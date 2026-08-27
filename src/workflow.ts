import { DBOS } from "@dbos-inc/dbos-sdk";
import type { GauntletAgentRunnerConfig } from "./agentRunnerClient.js";
import { getGauntletArtifact, getGauntletJobStatus, submitGauntletJob } from "./agentRunnerClient.js";
import { buildGauntletChallengePrompt, GAUNTLET_REVIEW_PROMPTS } from "./prompts.js";
import { createGauntletPool, createGauntletRun, saveGauntletChallenge, saveGauntletFailure, saveGauntletFindings, saveGauntletReview, saveGauntletVerdict, setGauntletStatus, type GauntletPool } from "./store.js";
import { parseChallengeFindings, parseIndependentFindings } from "./findings.js";
import type { GauntletRequest, GauntletResult, GauntletReviewer, GauntletReviewEnvelope } from "./types.js";

let pool: GauntletPool | null = null;
let runner: GauntletAgentRunnerConfig | null = null;
let notifyGauntlet: ((message: string) => Promise<void>) | null = null;

export function setGauntletNotifier(fn: (message: string) => Promise<void>): void {
  notifyGauntlet = fn;
}

export function configureGauntlet(config: { dbosDatabaseUrl: string; agentRunnerUrl: string; agentRunnerToken: string; trilium: import("../config.js").DbosConfig["trilium"] }): void {
  pool = createGauntletPool(config.dbosDatabaseUrl);
  runner = { baseUrl: config.agentRunnerUrl, token: config.agentRunnerToken };
}

function requirePool(): GauntletPool { if (!pool) throw new Error("Gauntlet is not configured"); return pool; }
function requireRunner(): GauntletAgentRunnerConfig { if (!runner?.baseUrl) throw new Error("AGENT_RUNNER_URL is not configured for Gauntlet"); return runner; }

function cleanArtifact(content: string): string {
  const trimmed = content.trim();
  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown; content?: unknown; message?: unknown; response?: unknown; status?: unknown };
    if (typeof parsed.result === "string") return parsed.result.trim();
    if (typeof parsed.content === "string") return parsed.content.trim();
    if (typeof parsed.message === "string") return parsed.message.trim();
    if (typeof parsed.response === "string" && parsed.response.trim()) return parsed.response.trim();
    if (parsed.status === "CANCELED" || parsed.status === "FAILED" || parsed.status === "ERROR" || parsed.response === "") return "";
  } catch { /* plain markdown */ }
  return trimmed;
}

async function runReview(workflowId: string, reviewer: GauntletReviewer, proposal: string, projectDir: string, persist = true): Promise<GauntletReviewEnvelope> {
  const config = requireRunner();
  const submitted = await submitGauntletJob(config, { reviewer, stage: "independent_review", projectDir, prompt: GAUNTLET_REVIEW_PROMPTS[reviewer].prompt(proposal), mode: reviewer === "antigravity" ? "readonly" : "write" });
  let status = await getGauntletJobStatus(config, submitted.runnerJobId);
  for (let poll = 0; poll < 180 && status.status === "running"; poll++) {
    await DBOS.sleepSeconds(20);
    status = await getGauntletJobStatus(config, submitted.runnerJobId);
  }
  if (status.status !== "succeeded") {
    const failed = { reviewer, status: "failed" as const, content: "", error: `Agent job ended with status ${status.status}` };
    if (persist) await saveGauntletReview(requirePool(), { workflowId, reviewer, runnerJobId: submitted.runnerJobId, content: `REVIEW_FAILED\n\n${failed.error}` });
    return failed;
  }
  const artifact = await getGauntletArtifact(config, submitted.runnerJobId);
  const content = cleanArtifact(artifact.content);
  if (!content) {
    const failed = { reviewer, status: "failed" as const, content: "", error: "Agent returned an empty artifact" };
    if (persist) await saveGauntletReview(requirePool(), { workflowId, reviewer, runnerJobId: submitted.runnerJobId, content: `REVIEW_FAILED\n\n${failed.error}` });
    return failed;
  }
  if (persist) {
    await saveGauntletReview(requirePool(), { workflowId, reviewer, runnerJobId: submitted.runnerJobId, content });
    try {
      await saveGauntletFindings(requirePool(), workflowId, "independent", parseIndependentFindings(reviewer, content));
    } catch {
      // Findings extraction is enrichment on top of the review, never a
      // requirement for it -- a storage hiccup here must not fail the run.
    }
  }
  return { reviewer, status: "succeeded", content };
}

async function runFinalizer(input: GauntletRequest, workflowId: string, verdict: string, reviews: GauntletReviewEnvelope[], challenge: string): Promise<string> {
  const config = requireRunner();
  const projectDir = input.projectDir || ".";
  const prompt = `You are the Gauntlet finalizer. Read the supplied Trilium source folder and its child notes. Create a project folder named ${input.proposalName} under Operations/Gauntlet Reports in Trilium, then create notes there named GAUNTLET-REVIEW, verdict, claude-review, codex-review, antigravity-review, and cross-agent-challenge. Use the exact content below. Do not use external repositories or services.\n\nVERDICT: ${verdict}\n\nCLAUDE REVIEW:\n${reviews.find((r) => r.reviewer === "claude")?.content || "REVIEW_FAILED"}\n\nCODEX REVIEW:\n${reviews.find((r) => r.reviewer === "codex")?.content || "REVIEW_FAILED"}\n\nANTIGRAVITY REVIEW:\n${reviews.find((r) => r.reviewer === "antigravity")?.content || "REVIEW_FAILED"}\n\nCHALLENGE:\n${challenge}\n\nAfter creating the Trilium notes, return the consolidated GAUNTLET-REVIEW content only.`;
  const submitted = await submitGauntletJob(config, { reviewer: "codex", stage: "finalize_artifacts", projectDir, prompt });
  let status = await getGauntletJobStatus(config, submitted.runnerJobId);
  for (let poll = 0; poll < 180 && status.status === "running"; poll++) { await DBOS.sleepSeconds(20); status = await getGauntletJobStatus(config, submitted.runnerJobId); }
  if (status.status !== "succeeded") throw new Error(`Gauntlet finalizer failed (runnerJobId=${submitted.runnerJobId})`);
  const result = await getGauntletArtifact(config, submitted.runnerJobId);
  return cleanArtifact(result.content);
}

export class GauntletWorkflows {
  @DBOS.step()
  static async notifyStep(message: string): Promise<void> {
    if (notifyGauntlet) await notifyGauntlet(message);
  }

  @DBOS.workflow()
  static async gauntletWorkflow(input: GauntletRequest): Promise<GauntletResult> {
    const workflowId = DBOS.workflowID;
    if (!workflowId) throw new Error("gauntletWorkflow invoked outside DBOS context");
    const db = requirePool();
    await createGauntletRun(db, { workflowId, requestedBy: input.requestedBy, idempotencyKey: input.idempotencyKey, proposalName: input.proposalName, proposal: input.proposal });
    try {
      await setGauntletStatus(db, workflowId, "independent_reviews");
      const projectDir = input.projectDir || ".";
      const proposal = input.proposal;
      await GauntletWorkflows.notifyStep(`🔎 Gauntlet \`${workflowId}\`: starting independent reviews.`);
      const reviews = await Promise.all((Object.keys(GAUNTLET_REVIEW_PROMPTS) as GauntletReviewer[]).map((reviewer) => runReview(workflowId, reviewer, proposal, projectDir)));
      await GauntletWorkflows.notifyStep(`🧪 Gauntlet \`${workflowId}\`: independent reviews complete; starting cross-agent challenge.`);
      await setGauntletStatus(db, workflowId, "cross_agent_challenge");
      const challengePrompt = buildGauntletChallengePrompt(proposal, reviews.map((review) => review.content || `REVIEW_FAILED: ${review.error || "No output"}`));
      const challengeResult = await runReview(workflowId, "claude", challengePrompt, projectDir, false);
      const challenge = challengeResult.content || `REVIEW_FAILED\n\n${challengeResult.error || "Challenge returned no output"}`;
      await saveGauntletChallenge(db, workflowId, challenge);
      try {
        await saveGauntletFindings(db, workflowId, "challenge", parseChallengeFindings(challenge));
      } catch {
        // Same non-fatal enrichment guarantee as the independent phase above.
      }
      const verdict = reviews.some((review) => review.status === "failed") || /\bcritical\b|\bhigh\b/i.test(challenge) ? "REVISION_REQUIRED" : "PASSED_WITH_CONDITIONS";
      const artifact = await runFinalizer(input, workflowId, verdict, reviews, challenge);
      await saveGauntletVerdict(db, workflowId, verdict, artifact);
      await GauntletWorkflows.notifyStep(`✅ Gauntlet \`${workflowId}\` finished — verdict: **${verdict}**\n\n${artifact}`);
      return { workflowId, verdict, status: "succeeded" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await saveGauntletFailure(db, workflowId, message);
      await GauntletWorkflows.notifyStep(`❌ Gauntlet \`${workflowId}\` failed: ${message}`);
      throw error;
    }
  }
}
