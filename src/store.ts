import pg from "pg";
import type { GauntletReviewer } from "./types.js";
import type { ParsedFinding } from "./findings.js";

export type GauntletPool = pg.Pool;

export function createGauntletPool(connectionString: string): GauntletPool {
  return new pg.Pool({ connectionString, max: 5 });
}

export async function createGauntletRun(pool: GauntletPool, params: {
  workflowId: string; requestedBy: string; idempotencyKey: string; proposalName: string; proposal: string;
}): Promise<void> {
  await pool.query(
    `insert into gauntlet_runs (workflow_id, requested_by, idempotency_key, proposal_name, proposal, status)
     values ($1, $2, $3, $4, $5, 'requested')
     on conflict (workflow_id) do update set updated_at = now()`,
    [params.workflowId, params.requestedBy, params.idempotencyKey, params.proposalName, params.proposal]
  );
}

export async function setGauntletStatus(pool: GauntletPool, workflowId: string, status: string): Promise<void> {
  await pool.query(`update gauntlet_runs set status = $2, updated_at = now() where workflow_id = $1`, [workflowId, status]);
}

export async function saveGauntletReview(pool: GauntletPool, params: {
  workflowId: string; reviewer: GauntletReviewer; content: string; runnerJobId?: string;
}): Promise<void> {
  await pool.query(
    `insert into gauntlet_reviews (workflow_id, reviewer, runner_job_id, content)
     values ($1, $2, $3, $4)
     on conflict (workflow_id, reviewer) do update set runner_job_id = excluded.runner_job_id, content = excluded.content`,
    [params.workflowId, params.reviewer, params.runnerJobId ?? null, params.content]
  );
}

export async function saveGauntletChallenge(pool: GauntletPool, workflowId: string, content: string): Promise<void> {
  await pool.query(
    `insert into gauntlet_challenges (workflow_id, content) values ($1, $2)
     on conflict (workflow_id) do update set content = excluded.content`, [workflowId, content]
  );
}

export async function saveGauntletVerdict(pool: GauntletPool, workflowId: string, verdict: string, artifact: string): Promise<void> {
  await pool.query(
    `update gauntlet_runs set verdict = $2, final_artifact = $3, status = 'succeeded', updated_at = now()
     where workflow_id = $1`, [workflowId, verdict, artifact]
  );
}

export async function saveGauntletFailure(pool: GauntletPool, workflowId: string, errorMessage: string): Promise<void> {
  await pool.query(
    `update gauntlet_runs set status = 'failed', error_message = $2, updated_at = now()
     where workflow_id = $1`, [workflowId, errorMessage]
  );
}

export async function saveGauntletFindings(pool: GauntletPool, workflowId: string, source: "independent" | "challenge", findings: ParsedFinding[]): Promise<void> {
  for (const finding of findings) {
    await pool.query(
      `insert into gauntlet_findings
        (workflow_id, source, finding_ref, reviewer, severity, category, scenario, failure, blast_radius, evidence, recommendation, verification, disposition)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (workflow_id, source, finding_ref) do update set
         reviewer = excluded.reviewer, severity = excluded.severity, category = excluded.category,
         scenario = excluded.scenario, failure = excluded.failure, blast_radius = excluded.blast_radius,
         evidence = excluded.evidence, recommendation = excluded.recommendation,
         verification = excluded.verification, disposition = excluded.disposition`,
      [
        workflowId, source, finding.findingRef, finding.reviewer, finding.severity, finding.category,
        finding.scenario, finding.failure, finding.blastRadius, finding.evidence, finding.recommendation,
        finding.verification, finding.disposition
      ]
    );
  }
}

export async function countGauntletHardened(pool: GauntletPool): Promise<number> {
  const result = await pool.query(
    // A PASSED whose challenge never ran (its stored challenge is a
    // REVIEW_FAILED placeholder) was never judged, so it doesn't count.
    `select count(*)::int as count from gauntlet_runs r
     where r.verdict in ('PASSED', 'PASSED_WITH_CONDITIONS', 'ACCEPTED')
       and not exists (
         select 1 from gauntlet_challenges c
         where c.workflow_id = r.workflow_id and c.content like 'REVIEW_FAILED%'
       )`
  );
  return result.rows[0]?.count ?? 0;
}

// Human-readable workflow IDs: "<source-slug>-run-<n>" instead of
// "gauntlet-arena-<noteId>-<timestamp>". Derives n from the existing
// workflow_id namespace (max "-run-N" suffix under this slug + 1) rather
// than a row count against proposal_name, so a renamed/reused proposal name
// can't collide with or skip numbers already claimed in the ID space itself.
// Race note: two runs launched on the same source in the same instant could
// both compute the same next number -- acceptable for solo/low-concurrency
// use; createGauntletRun's "on conflict (workflow_id)" makes that an update
// of the same row rather than a crash, not a silent data loss.
export async function nextGauntletRunNumber(pool: GauntletPool, slug: string): Promise<number> {
  const result = await pool.query(
    `select coalesce(max((regexp_match(workflow_id, '-run-([0-9]+)$'))[1]::int), 0) as max_run
     from gauntlet_runs where workflow_id like $1`,
    [`${slug}-run-%`]
  );
  return (result.rows[0]?.max_run ?? 0) + 1;
}

export async function listGauntletFindings(pool: GauntletPool, workflowId: string): Promise<unknown[]> {
  const result = await pool.query(
    `select source, finding_ref, reviewer, severity, category, scenario, failure, blast_radius,
            evidence, recommendation, verification, disposition, remediation, created_at
     from gauntlet_findings where workflow_id = $1
     order by case severity
       when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4
     end, created_at`,
    [workflowId]
  );
  return result.rows;
}

// Findings Workshop: one remediation note per finding, matching TT's
// blocker-workshop pattern (resolve one item at a time, not a single blob
// covering everything). Applies to the "challenge" source specifically --
// that's the deduped, validated list a human would actually work through,
// not the raw pre-consolidation "independent" rows from each reviewer.
export async function saveGauntletRemediation(
  pool: GauntletPool,
  workflowId: string,
  findingRef: string,
  remediation: string
): Promise<boolean> {
  const result = await pool.query(
    `update gauntlet_findings set remediation = $3
     where workflow_id = $1 and source = 'challenge' and finding_ref = $2`,
    [workflowId, findingRef, remediation]
  );
  return (result.rowCount ?? 0) > 0;
}

// Formats a prior round's challenge findings + whatever remediation text was
// recorded for each, for injection into the next round's reviewer prompts
// (see prompts.ts's priorRemediationBlock). Findings with no remediation
// recorded are shown as "(no remediation recorded)" rather than omitted --
// an unaddressed finding re-appearing with no stated fix is itself useful
// signal for the next round to see, not something to hide.
export async function getGauntletRemediationContext(pool: GauntletPool, workflowId: string): Promise<string | null> {
  const result = await pool.query(
    `select finding_ref, severity, category, scenario, failure, remediation, disposition
     from gauntlet_findings where workflow_id = $1 and source = 'challenge'
     order by finding_ref`,
    [workflowId]
  );
  if (result.rows.length === 0) return null;
  return result.rows
    .map((row) => `${row.finding_ref} [${row.disposition === "resolved" ? "RESOLVED" : row.disposition === "disputed" ? "DISPUTED" : "OPEN"}] (${row.severity} / ${row.category}) — ${row.scenario}\nFailure: ${row.failure}\nFelton's remediation: ${row.remediation || "(no remediation recorded)"}`)
    .join("\n\n");
}

// The first F-number a follow-up round may use for a NEW finding: one past the
// highest "F<n>" already used by the prior round, so new findings can never
// collide with (or be mistaken for) a prior one.
export async function nextGauntletFindingNumber(pool: GauntletPool, previousWorkflowId: string): Promise<number> {
  const result = await pool.query(
    `select coalesce(max((regexp_match(finding_ref, '^F([0-9]+)$'))[1]::int), 0) as max_n
     from gauntlet_findings where workflow_id = $1 and source = 'challenge'`,
    [previousWorkflowId]
  );
  return (result.rows[0]?.max_n ?? 0) + 1;
}

// A finding that is still open under the SAME F# as the prior round keeps the
// remediation Felton already wrote, so a follow-up round never asks him to
// redo a decision.
export async function carryForwardRemediations(pool: GauntletPool, workflowId: string, previousWorkflowId: string): Promise<number> {
  const result = await pool.query(
    `update gauntlet_findings n set remediation = p.remediation
     from gauntlet_findings p
     where n.workflow_id = $1 and n.source = 'challenge' and n.disposition = 'validated'
       and (n.remediation is null or n.remediation = '')
       and p.workflow_id = $2 and p.source = 'challenge' and p.finding_ref = n.finding_ref
       and p.remediation is not null and p.remediation <> ''`,
    [workflowId, previousWorkflowId]
  );
  return result.rowCount ?? 0;
}
