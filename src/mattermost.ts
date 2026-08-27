import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { createGauntletPool } from "./store.js";
import { GauntletWorkflows } from "./workflow.js";

export const GAUNTLET_HELP_TEXT = [
  "**Gauntlet commands**",
  "`run <name> :: <path-to-proposal>` — start an adversarial review in that folder",
  "`status <workflowId>` — show run status and verdict",
  "`artifact <workflowId>` — retrieve the consolidated review"
].join("\n");

export function createGauntletMattermostHandler(config: { dbosDatabaseUrl: string }) {
  const pool = createGauntletPool(config.dbosDatabaseUrl);
  return async function handleGauntletCommand(message: string): Promise<string> {
    const [command, ...rest] = message.trim().split(/\s+/);
    const normalized = (command || "").toLowerCase();
    if (normalized === "run") {
      const raw = rest.join(" ");
      const separator = raw.indexOf("::");
      if (separator < 1) return "Usage: `run <name> :: <proposal>`";
      const proposalName = raw.slice(0, separator).trim();
      const proposalPath = raw.slice(separator + 2).trim();
      const projectDir = dirname(proposalPath);
      const workflowId = `gauntlet-${randomUUID()}`;
      await DBOS.startWorkflow(GauntletWorkflows, { workflowID: workflowId }).gauntletWorkflow({ proposalName, proposal: proposalPath, proposalPath: undefined, projectDir, triliumSourceNoteId: proposalPath, requestedBy: "mattermost", idempotencyKey: workflowId });
      return `Started Gauntlet run \`${workflowId}\` for **${proposalName}**.`;
    }
    if ((normalized === "status" || normalized === "artifact") && rest[0]) {
      const result = await pool.query(`select status, verdict, final_artifact from gauntlet_runs where workflow_id = $1`, [rest[0]]);
      if (!result.rows[0]) return `No Gauntlet run found with ID \`${rest[0]}\`.`;
      if (normalized === "status") return `**${rest[0]}** — status: **${result.rows[0].status}**, verdict: **${result.rows[0].verdict || "pending"}**`;
      return result.rows[0].final_artifact || `Artifact is not ready yet (status: ${result.rows[0].status}).`;
    }
    return "Unknown Gauntlet command. See the pinned command reference.";
  };
}
