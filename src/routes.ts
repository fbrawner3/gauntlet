import { DBOS } from "@dbos-inc/dbos-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createGauntletPool, listGauntletFindings } from "./store.js";
import { GauntletWorkflows } from "./workflow.js";

const startSchema = z.object({
  proposalName: z.string().min(1).max(200),
  proposal: z.string().min(1).max(500_000),
  requestedBy: z.string().min(1).max(120),
  idempotencyKey: z.string().min(8).max(128),
  projectSlug: z.string().max(120).optional(),
  projectDir: z.string().max(300).optional()
  ,triliumSourceNoteId: z.string().max(255).optional()
});

export function registerGauntletRoutes(app: FastifyInstance, config: { dbosDatabaseUrl: string }): void {
  const pool = createGauntletPool(config.dbosDatabaseUrl);
  app.post("/gauntlet/runs", async (request, reply) => {
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    const workflowId = `gauntlet-${parsed.data.idempotencyKey}`;
    const handle = await DBOS.startWorkflow(GauntletWorkflows, { workflowID: workflowId }).gauntletWorkflow(parsed.data);
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
}
