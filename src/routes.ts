import { DBOS } from "@dbos-inc/dbos-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createGauntletPool, listGauntletFindings, nextGauntletRunNumber, saveGauntletRemediation } from "./store.js";
import { GauntletWorkflows, setGauntletMemoryProvider, type GauntletMemoryStore } from "./workflow.js";
import { GAUNTLET_OUTPUT_MODES } from "./types.js";

// Mirrors the client's slugify() in arena/page.ts exactly -- kept as a
// fallback for callers that don't send projectSlug (the HTTP API is public
// within the LAN, not just the Arena UI), not the primary path.
function slugify(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "project";
}

const startSchema = z.object({
  proposalName: z.string().min(1).max(200),
  proposal: z.string().min(1).max(500_000),
  requestedBy: z.string().min(1).max(120),
  idempotencyKey: z.string().min(8).max(128),
  projectSlug: z.string().max(120).optional(),
  projectDir: z.string().max(300).optional()
  ,triliumSourceNoteId: z.string().max(255).optional()
  ,outputMode: z.enum(GAUNTLET_OUTPUT_MODES).optional()
  ,previousWorkflowId: z.string().max(255).optional()
});

const remediateSchema = z.object({
  remediation: z.string().min(1).max(10_000)
});

// The workflow writes its gauntlet_runs row a moment after startWorkflow
// returns, and the Arena page polls status immediately -- that first poll
// 404'd. Hold the 202 until the row exists (bounded, so a slow start can't
// hang the request).
async function waitForRunRow(pool: ReturnType<typeof createGauntletPool>, workflowId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const found = await pool.query(`select 1 from gauntlet_runs where workflow_id = $1`, [workflowId]);
    if (found.rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const reviseSchema = z.object({
  projectDir: z.string().max(300).optional(),
  requestedBy: z.string().max(120).optional()
});

export function registerGauntletRoutes(app: FastifyInstance, config: { dbosDatabaseUrl: string }): void {
  const pool = createGauntletPool(config.dbosDatabaseUrl);
  // ragStore is decorated onto the app by the vector-memory integration, after
  // this runs; the revise workflow reads it lazily through this getter.
  setGauntletMemoryProvider(() => (app as unknown as { ragStore?: GauntletMemoryStore }).ragStore);
  app.post("/gauntlet/runs", async (request, reply) => {
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    const slug = parsed.data.projectSlug || slugify(parsed.data.proposalName);
    const runNumber = await nextGauntletRunNumber(pool, slug);
    const workflowId = `${slug}-run-${runNumber}`;
    const handle = await DBOS.startWorkflow(GauntletWorkflows, { workflowID: workflowId }).gauntletWorkflow(parsed.data);
    await waitForRunRow(pool, workflowId);
    return reply.code(202).send({ workflowId: handle.workflowID, status: "requested" });
  });
  app.get("/gauntlet/runs/:workflowId", async (request, reply) => {
    const { workflowId } = request.params as { workflowId: string };
    const result = await pool.query(`select * from gauntlet_runs where workflow_id = $1`, [workflowId]);
    if (!result.rows[0]) return reply.code(404).send({ error: "not_found" });
    return reply.send(result.rows[0]);
  });
  app.get("/gauntlet/runs/:workflowId/artifact", async (request, reply) => {
    const { workflowId } = request.params as { workflowId: string };
    const result = await pool.query(`select status, verdict, final_artifact from gauntlet_runs where workflow_id = $1`, [workflowId]);
    if (!result.rows[0]) return reply.code(404).send({ error: "not_found" });
    if (!result.rows[0].final_artifact) return reply.code(409).send({ error: "artifact_not_ready", status: result.rows[0].status });
    return reply.send({ status: result.rows[0].status, verdict: result.rows[0].verdict, artifact: result.rows[0].final_artifact });
  });
  app.get("/gauntlet/runs/:workflowId/findings", async (request, reply) => {
    const { workflowId } = request.params as { workflowId: string };
    const findings = await listGauntletFindings(pool, workflowId);
    return reply.send({ workflowId, findings });
  });

  // Findings Workshop: one remediation note per finding, matching TT's
  // blocker-workshop pattern -- not a single free-text field covering every
  // finding at once. Only the deduped "challenge" rows are addressable here
  // (matches getGauntletRemediationContext's read side in store.ts).
  app.post("/gauntlet/runs/:workflowId/findings/:findingRef/remediate", async (request, reply) => {
    const { workflowId, findingRef } = request.params as { workflowId: string; findingRef: string };
    const parsed = remediateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    const updated = await saveGauntletRemediation(pool, workflowId, findingRef, parsed.data.remediation);
    if (!updated) return reply.code(404).send({ error: "finding_not_found" });
    const filed = await fileRemediationToMemory(workflowId, findingRef);
    return reply.code(202).send({ workflowId, findingRef, status: "remediation_saved", memoryFiled: filed });
  });

  // Applies this round's saved remediations to the package files in place,
  // then starts the next linked Gauntlet round (see gauntletReviseWorkflow).
  // projectDir falls back to the run's slug, which is the package folder for
  // top-level packages; the page sends the exact folder when it knows it.
  app.post("/gauntlet/runs/:workflowId/revise", async (request, reply) => {
    const { workflowId } = request.params as { workflowId: string };
    const parsed = reviseSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    const run = await pool.query(`select proposal_name from gauntlet_runs where workflow_id = $1`, [workflowId]);
    if (!run.rows[0]) return reply.code(404).send({ error: "not_found" });
    const remediated = await pool.query(
      `select count(*)::int as n from gauntlet_findings
       where workflow_id = $1 and source = 'challenge' and remediation is not null and remediation <> ''`,
      [workflowId]
    );
    if (!remediated.rows[0]?.n) return reply.code(409).send({ error: "no_remediations_saved" });
    const slug = workflowId.replace(/-run-\d+$/, "");
    const projectDir = (parsed.data.projectDir || slug).replace(/^[/\\]+/, "");
    if (projectDir.split(/[/\\]/).includes("..")) return reply.code(400).send({ error: "invalid_project_dir" });
    // Numbered so a round can be revised again (after more remediations, or a
    // bad revise) without colliding with the earlier run's id and keys.
    const prior = await pool.query(`select count(*)::int as n from gauntlet_runs where workflow_id like $1`, [`${workflowId}-revise-%`]);
    const reviseId = `${workflowId}-revise-${(prior.rows[0]?.n ?? 0) + 1}`;
    await DBOS.startWorkflow(GauntletWorkflows, { workflowID: reviseId }).gauntletReviseWorkflow({
      sourceWorkflowId: workflowId,
      proposalName: String(run.rows[0].proposal_name),
      projectSlug: slug,
      projectDir,
      requestedBy: parsed.data.requestedBy || "arena"
    });
    await waitForRunRow(pool, reviseId);
    return reply.code(202).send({ workflowId: reviseId, status: "requested", projectDir });
  });

  // The operator's "enough". Closes a finished round as ACCEPTED: the verdict
  // becomes ACCEPTED (it counts as hardened), and every finding still open is
  // filed to vector memory as an accepted residual risk. The decision is
  // Felton's, not the reviewers'.
  app.post("/gauntlet/runs/:workflowId/accept", async (request, reply) => {
    const { workflowId } = request.params as { workflowId: string };
    const run = await pool.query(`select status, verdict, proposal_name from gauntlet_runs where workflow_id = $1`, [workflowId]);
    const row = run.rows[0] as { status: string; verdict: string | null; proposal_name: string } | undefined;
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.status !== "succeeded") return reply.code(409).send({ error: "run_not_finished" });
    if (row.verdict === "INVALID") return reply.code(409).send({ error: "run_voided" });
    const open = await pool.query(
      `select finding_ref, severity, category, scenario, recommendation, remediation
       from gauntlet_findings
       where workflow_id = $1 and source = 'challenge' and coalesce(disposition, 'validated') = 'validated'
       order by case severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end, finding_ref`,
      [workflowId]
    );
    await pool.query(`update gauntlet_runs set verdict = 'ACCEPTED', updated_at = now() where workflow_id = $1`, [workflowId]);
    let filed = false;
    try {
      const store = (app as unknown as { ragStore?: { write(input: unknown, actor: string): Promise<unknown> } }).ragStore;
      if (store) {
        const slug = workflowId.replace(/-run-\d+$/, "");
        const lines = (open.rows as Array<Record<string, string | null>>).map((f) =>
          `- **${f.finding_ref}** (${f.severity} / ${f.category}): ${f.scenario}${f.remediation ? `\n  Decision: ${f.remediation}` : ""}`
        );
        await store.write(
          {
            note_id: `gauntlet-${workflowId}-accepted`,
            title: `${row.proposal_name} — ${workflowId} accepted by Felton`,
            content: [
              `# ${workflowId} — accepted by Felton`,
              "",
              "Felton accepted this round. The findings below were still open and are accepted residual risk.",
              "",
              ...(lines.length ? lines : ["(no open findings)"])
            ].join("\n"),
            project: slug,
            doc_type: "gauntlet_accepted",
            ancestry: [slug, workflowId, "Accepted"],
            attributes: { acceptedBy: "felton via Arena", openFindings: open.rows.length }
          },
          "claude"
        );
        filed = true;
      }
    } catch (error) {
      app.log.warn({ err: error, workflowId }, "failed to file accepted-run note to vector memory");
    }
    return reply.send({ workflowId, verdict: "ACCEPTED", residualFindings: open.rows.length, memoryFiled: filed });
  });

  // Stops a running round from the Arena. The DBOS workflow is cancelled and
  // the run is marked failed with the reason. A review job already started on
  // the agent host is not killed; it just finishes unused.
  app.post("/gauntlet/runs/:workflowId/cancel", async (request, reply) => {
    const { workflowId } = request.params as { workflowId: string };
    const run = await pool.query(`select status from gauntlet_runs where workflow_id = $1`, [workflowId]);
    if (!run.rows[0]) return reply.code(404).send({ error: "not_found" });
    if (["succeeded", "failed"].includes(String(run.rows[0].status))) return reply.code(409).send({ error: "already_finished" });
    await DBOS.cancelWorkflow(workflowId);
    await pool.query(
      `update gauntlet_runs set status = 'failed', error_message = 'Cancelled by operator', updated_at = now()
       where workflow_id = $1 and status not in ('succeeded', 'failed')`,
      [workflowId]
    );
    return reply.send({ workflowId, status: "cancelled" });
  });

  // Clears one run's vector-memory notes (report, verdict, three reviews,
  // challenge, and its remediation/revision notes) when the operator clicks
  // "Delete" in the Arena and confirms. Matches this run's id exactly plus the
  // "<id>-" prefix, so run-3 never touches run-30 or any other run. The
  // memory store's delete keeps a history snapshot, as for any delete.
  app.post("/gauntlet/runs/:workflowId/purge-memory", async (request, reply) => {
    const { workflowId } = request.params as { workflowId: string };
    if (!/^[a-z0-9][a-z0-9-]*-run-[0-9]+$/.test(workflowId)) return reply.code(400).send({ error: "invalid_workflow_id" });
    const store = (app as unknown as { ragStore?: { pool: { query(sql: string, params: unknown[]): Promise<{ rows: Array<{ note_id: string }> }> }; delete(input: { note_id: string; reason: string }, actor: string): Promise<unknown> } }).ragStore;
    if (!store) return reply.code(503).send({ error: "memory_unavailable" });
    const base = `gauntlet-${workflowId}`;
    const found = await store.pool.query(`select note_id from notes_canonical where note_id = $1 or note_id like $2 order by note_id`, [base, `${base}-%`]);
    const deleted: string[] = [];
    for (const row of found.rows) {
      await store.delete({ note_id: row.note_id, reason: `Deleted by Felton from the Arena (run ${workflowId})` }, "claude");
      deleted.push(row.note_id);
    }
    // A run whose notes were deleted is not a result to count. Its row stays
    // (the run happened) but a PASSED verdict is voided so it drops out of the
    // hardened counter.
    const voided = await pool.query(
      `update gauntlet_runs set verdict = 'INVALID', updated_at = now()
       where workflow_id = $1 and verdict in ('PASSED', 'PASSED_WITH_CONDITIONS')`,
      [workflowId]
    );
    return reply.send({ workflowId, deleted, verdictVoided: (voided.rowCount ?? 0) > 0 });
  });

  // Re-files every saved remediation to vector memory. Safe to repeat: the
  // note_id per finding is fixed, so a rerun overwrites rather than duplicates.
  app.post("/gauntlet/backfill-memory", async (_request, reply) => {
    const rows = await pool.query(
      `select workflow_id, finding_ref from gauntlet_findings
       where source = 'challenge' and remediation is not null and remediation <> ''
       order by workflow_id, finding_ref`
    );
    let filed = 0;
    for (const row of rows.rows as Array<{ workflow_id: string; finding_ref: string }>) {
      if (await fileRemediationToMemory(row.workflow_id, row.finding_ref)) filed += 1;
    }
    return reply.send({ remediationsFound: rows.rows.length, filed });
  });

  // Remediations are typed into the Arena page and saved to gauntlet_findings,
  // a table nothing else reads. File each one to vector memory so agents, the
  // next round and search can see what was decided. Returns false (never
  // throws) on failure so a memory problem can't fail the operator's save.
  async function fileRemediationToMemory(workflowId: string, findingRef: string): Promise<boolean> {
    try {
      const store = (app as unknown as { ragStore?: { write(input: unknown, actor: string): Promise<unknown> } }).ragStore;
      if (!store) return false;
      const slug = workflowId.replace(/-run-\d+$/, "");
      const result = await pool.query(
        `select severity, category, scenario, failure, recommendation, verification, remediation
         from gauntlet_findings where workflow_id = $1 and source = 'challenge' and finding_ref = $2`,
        [workflowId, findingRef]
      );
      const f = result.rows[0] as Record<string, string | null> | undefined;
      if (!f?.remediation) return false;
      const content = [
        `# ${findingRef} — ${f.category ?? "finding"} (${f.severity ?? "unrated"})`,
        `**Run:** ${workflowId}`,
        `**Scenario:** ${f.scenario ?? "(none recorded)"}`,
        `**Failure:** ${f.failure ?? "(none recorded)"}`,
        `**Reviewer recommendation:** ${f.recommendation ?? "(none recorded)"}`,
        `**Verification:** ${f.verification ?? "(none recorded)"}`,
        "",
        `**Remediation (Felton):** ${f.remediation}`
      ].join("\n");
      await store.write(
        {
          note_id: `gauntlet-${workflowId}-remediation-${findingRef}`,
          title: `${slug} — ${workflowId} ${findingRef} remediation`,
          content,
          project: slug,
          doc_type: "gauntlet_remediation",
          ancestry: [slug, workflowId, "Remediations"],
          attributes: { recordedBy: "felton via Arena" }
        },
        "claude"
      );
      return true;
    } catch (error) {
      app.log.warn({ err: error, workflowId, findingRef }, "failed to file gauntlet remediation to vector memory");
      return false;
    }
  }
}
