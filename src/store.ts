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
    `select count(*)::int as count from gauntlet_runs where verdict in ('PASSED', 'PASSED_WITH_CONDITIONS')`
  );
  return result.rows[0]?.count ?? 0;
}

export async function listGauntletFindings(pool: GauntletPool, workflowId: string): Promise<unknown[]> {
  const result = await pool.query(
    `select source, finding_ref, reviewer, severity, category, scenario, failure, blast_radius,
            evidence, recommendation, verification, disposition, created_at
     from gauntlet_findings where workflow_id = $1
     order by case severity
       when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4
     end, created_at`,
    [workflowId]
  );
  return result.rows;
}
