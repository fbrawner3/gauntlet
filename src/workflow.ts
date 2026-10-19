import { DBOS } from "@dbos-inc/dbos-sdk";
import type { GauntletAgentRunnerConfig } from "./agentRunnerClient.js";
import { getGauntletArtifact, getGauntletJobStatus, submitGauntletJob } from "./agentRunnerClient.js";
import { buildGauntletChallengePrompt, buildGauntletFinalizerPrompt, buildGauntletRevisePrompt, GAUNTLET_REVIEW_PROMPTS } from "./prompts.js";
import { carryForwardRemediations, createGauntletPool, createGauntletRun, getGauntletRemediationContext, listGauntletFindings, nextGauntletFindingNumber, nextGauntletRunNumber, saveGauntletChallenge, saveGauntletFailure, saveGauntletFindings, saveGauntletReview, saveGauntletVerdict, setGauntletStatus, type GauntletPool } from "./store.js";
import { countRawJsonFindings, parseChallengeFindings, parseIndependentFindings } from "./findings.js";
import type { GauntletRequest, GauntletResult, GauntletReviewer, GauntletReviewEnvelope, GauntletReviseRequest } from "./types.js";

let pool: GauntletPool | null = null;
let runner: GauntletAgentRunnerConfig | null = null;
let notifyGauntlet: ((message: string) => Promise<void>) | null = null;

// The vector memory store is decorated onto the Fastify app after boot, so
// workflows reach it through a getter set by registerGauntletRoutes instead of
// capturing it at configure time.
export interface GauntletMemoryStore {
  write(input: unknown, actor: string): Promise<unknown>;
  search(input: { query: string; project?: string; doc_type?: string; limit?: number }, actor: string): Promise<{ results: Array<{ note_id: string; title: string; content: string; doc_type: string }> }>;
}
let memoryStore: (() => GauntletMemoryStore | undefined) | null = null;
export function setGauntletMemoryProvider(fn: () => GauntletMemoryStore | undefined): void {
  memoryStore = fn;
}

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

async function runReview(workflowId: string, reviewer: GauntletReviewer, proposal: string, projectDir: string, persist = true, priorRemediation?: string): Promise<GauntletReviewEnvelope> {
  const config = requireRunner();
  const submitted = await submitGauntletJob(config, { reviewer, stage: "independent_review", projectDir, prompt: GAUNTLET_REVIEW_PROMPTS[reviewer].prompt(proposal, priorRemediation), mode: reviewer === "antigravity" ? "readonly" : "write" });
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
  // routes.ts builds workflowId as `${slug}-run-${n}`; fall back to deriving
  // the slug from it when a caller didn't also send projectSlug explicitly.
  const projectSlug = input.projectSlug || workflowId.replace(/-run-\d+$/, "");
  const prompt = buildGauntletFinalizerPrompt({
    proposalName: input.proposalName,
    workflowId,
    projectSlug,
    verdict,
    claudeReview: reviews.find((r) => r.reviewer === "claude")?.content || "REVIEW_FAILED",
    codexReview: reviews.find((r) => r.reviewer === "codex")?.content || "REVIEW_FAILED",
    antigravityReview: reviews.find((r) => r.reviewer === "antigravity")?.content || "REVIEW_FAILED",
    challenge,
    outputMode: input.outputMode || "vector"
  });
  const submitted = await submitGauntletJob(config, { reviewer: "codex", stage: "finalize_artifacts", projectDir, prompt });
  let status = await getGauntletJobStatus(config, submitted.runnerJobId);
  for (let poll = 0; poll < 180 && status.status === "running"; poll++) { await DBOS.sleepSeconds(20); status = await getGauntletJobStatus(config, submitted.runnerJobId); }
  if (status.status !== "succeeded") throw new Error(`Gauntlet finalizer failed (runnerJobId=${submitted.runnerJobId})`);
  const result = await getGauntletArtifact(config, submitted.runnerJobId);
  return cleanArtifact(result.content);
}

// Felton's recorded decisions and blocker resolutions for this project, read
// from vector memory so the reviser can't undo them. Gauntlet's own notes are
// excluded to avoid feeding findings back in as if they were decisions.
async function gatherLockedDecisions(slug: string): Promise<string> {
  const store = memoryStore?.();
  if (!store) return "";
  const found = await store.search({ query: `${slug} Felton decisions blockers resolutions design choices`, project: slug, limit: 40 }, "claude");
  const byNote = new Map<string, { title: string; parts: string[] }>();
  for (const row of found.results) {
    if (row.doc_type.startsWith("gauntlet_") || row.doc_type === "tt_final_runbook") continue;
    const entry = byNote.get(row.note_id) ?? { title: row.title, parts: [] };
    entry.parts.push(row.content);
    byNote.set(row.note_id, entry);
  }
  return [...byNote.values()].map((e) => `## ${e.title}\n${e.parts.join("\n")}`).join("\n\n").slice(0, 30_000);
}

async function runReviseJob(prompt: string): Promise<string> {
  const config = requireRunner();
  // projectDir "." so the agent can read k3s-working/_standards beside the
  // package; the prompt confines its edits to the package folder.
  const submitted = await submitGauntletJob(config, { reviewer: "codex", stage: "revise_package", projectDir: ".", prompt, mode: "write" });
  let status = await getGauntletJobStatus(config, submitted.runnerJobId);
  for (let poll = 0; poll < 180 && status.status === "running"; poll++) { await DBOS.sleepSeconds(20); status = await getGauntletJobStatus(config, submitted.runnerJobId); }
  if (status.status !== "succeeded") throw new Error(`Gauntlet reviser failed (runnerJobId=${submitted.runnerJobId})`);
  const result = await getGauntletArtifact(config, submitted.runnerJobId);
  const content = cleanArtifact(result.content);
  if (!content) throw new Error(`Gauntlet reviser returned an empty change log (runnerJobId=${submitted.runnerJobId})`);
  return content;
}

export class GauntletWorkflows {
  @DBOS.step()
  static async notifyStep(message: string): Promise<void> {
    if (notifyGauntlet) await notifyGauntlet(message);
  }

  @DBOS.step()
  static async reviseContextStep(sourceWorkflowId: string, slug: string): Promise<{
    remediated: Array<{ ref: string; severity: string; category: string; scenario: string; failure: string; recommendation: string; remediation: string }>;
    unremediated: Array<{ ref: string; severity: string; category: string; scenario: string }>;
    decisions: string;
  }> {
    const rows = (await listGauntletFindings(requirePool(), sourceWorkflowId)) as Array<Record<string, string | null>>;
    // A finding Felton wrote a remediation for is his decision, whatever the
    // challenge phase concluded about it, so it always goes to the reviser
    // (unless the current files already fix it). Findings with no remediation
    // are only listed as open when they are still validated.
    const challenge = rows.filter((r) => r.source === "challenge" && r.disposition !== "resolved" && (r.remediation || r.disposition !== "disputed"));
    const remediated = challenge.filter((r) => r.remediation).map((r) => ({
      ref: String(r.finding_ref), severity: String(r.severity), category: String(r.category), scenario: String(r.scenario),
      failure: String(r.failure ?? ""), recommendation: String(r.recommendation ?? ""), remediation: String(r.remediation)
    }));
    const unremediated = challenge.filter((r) => !r.remediation).map((r) => ({
      ref: String(r.finding_ref), severity: String(r.severity), category: String(r.category), scenario: String(r.scenario)
    }));
    return { remediated, unremediated, decisions: await gatherLockedDecisions(slug) };
  }

  @DBOS.step()
  static async fileRevisionStep(sourceWorkflowId: string, slug: string, proposalName: string, changeLog: string): Promise<void> {
    const store = memoryStore?.();
    if (!store) return;
    await store.write(
      {
        note_id: `gauntlet-${sourceWorkflowId}-revision`,
        title: `${proposalName} — ${sourceWorkflowId} revision change log`,
        content: changeLog,
        project: slug,
        doc_type: "gauntlet_revision",
        ancestry: [proposalName, sourceWorkflowId, "Revision"],
        attributes: { sourceWorkflowId }
      },
      "claude"
    );
  }

  @DBOS.step()
  static async nextRunNumberStep(slug: string): Promise<number> {
    return nextGauntletRunNumber(requirePool(), slug);
  }

  // Closes the Gauntlet loop: applies the remediations Felton saved on one
  // round to the package files, files the change log to vector memory, then
  // starts the next round linked to this one. That round's reviewers see the
  // revised files cold and its challenge findings show up in the Findings
  // Workshop as the new list to work through.
  @DBOS.workflow()
  static async gauntletReviseWorkflow(input: GauntletReviseRequest): Promise<GauntletResult> {
    const workflowId = DBOS.workflowID;
    if (!workflowId) throw new Error("gauntletReviseWorkflow invoked outside DBOS context");
    const db = requirePool();
    await createGauntletRun(db, { workflowId, requestedBy: input.requestedBy, idempotencyKey: `revise-${workflowId}`, proposalName: `${input.proposalName} (revision of ${input.sourceWorkflowId})`, proposal: `Revision of ${input.sourceWorkflowId}` });
    try {
      await setGauntletStatus(db, workflowId, "revising");
      await GauntletWorkflows.notifyStep(`🛠️ Gauntlet \`${workflowId}\`: revising \`${input.projectDir}\` from the remediations saved on \`${input.sourceWorkflowId}\`.`);
      const context = await GauntletWorkflows.reviseContextStep(input.sourceWorkflowId, input.projectSlug);
      if (!context.remediated.length) throw new Error(`No saved remediations on ${input.sourceWorkflowId} to apply`);
      const changeLog = await runReviseJob(buildGauntletRevisePrompt({
        proposalName: input.proposalName,
        sourceWorkflowId: input.sourceWorkflowId,
        packageDir: input.projectDir,
        remediated: context.remediated,
        unremediated: context.unremediated,
        decisions: context.decisions
      }));
      try {
        await GauntletWorkflows.fileRevisionStep(input.sourceWorkflowId, input.projectSlug, input.proposalName, changeLog);
      } catch {
        // Filing is best-effort; the change log is also stored on this run.
      }
      const runNumber = await GauntletWorkflows.nextRunNumberStep(input.projectSlug);
      const nextId = `${input.projectSlug}-run-${runNumber}`;
      await DBOS.startWorkflow(GauntletWorkflows, { workflowID: nextId }).gauntletWorkflow({
        proposalName: input.proposalName,
        // The reviewers read the revised files themselves from projectDir; the
        // old proposal text would be the pre-revision content.
        proposal: `Revised build package in "${input.projectDir}" (round after ${input.sourceWorkflowId}). Read every file in the project directory; the files are the current state of the package.`,
        requestedBy: input.requestedBy,
        idempotencyKey: `revise-next-${workflowId}`,
        projectSlug: input.projectSlug,
        projectDir: input.projectDir,
        outputMode: "vector",
        previousWorkflowId: input.sourceWorkflowId
      });
      await saveGauntletVerdict(db, workflowId, "REVISED", `${changeLog}\n\nNext round started: ${nextId}`);
      await GauntletWorkflows.notifyStep(`✅ Gauntlet \`${workflowId}\` revised the package. Next round \`${nextId}\` is running.\n\n${changeLog}`);
      return { workflowId, verdict: "REVISED", status: "succeeded" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await saveGauntletFailure(db, workflowId, message);
      await GauntletWorkflows.notifyStep(`❌ Gauntlet \`${workflowId}\` revise failed: ${message}`);
      throw error;
    }
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
      // Explicit, human-driven link to a prior round -- not an autonomous
      // loop. null (not undefined) when no previousWorkflowId is given, or
      // when that round has no challenge findings on record, so every
      // downstream prompt call sees the same "no prior context" shape either
      // way rather than two different falsy states.
      const priorRemediation = input.previousWorkflowId
        ? (await getGauntletRemediationContext(db, input.previousWorkflowId)) ?? undefined
        : undefined;
      await GauntletWorkflows.notifyStep(`🔎 Gauntlet \`${workflowId}\`: starting independent reviews.`);
      const reviews = await Promise.all((Object.keys(GAUNTLET_REVIEW_PROMPTS) as GauntletReviewer[]).map((reviewer) => runReview(workflowId, reviewer, proposal, projectDir, true, priorRemediation)));
      await GauntletWorkflows.notifyStep(`🧪 Gauntlet \`${workflowId}\`: independent reviews complete; starting cross-agent challenge.`);
      await setGauntletStatus(db, workflowId, "cross_agent_challenge");
      const nextFindingNumber = input.previousWorkflowId ? await nextGauntletFindingNumber(db, input.previousWorkflowId) : undefined;
      const challengePrompt = buildGauntletChallengePrompt(proposal, reviews.map((review) => review.content || `REVIEW_FAILED: ${review.error || "No output"}`), priorRemediation, nextFindingNumber);
      const challengeResult = await runReview(workflowId, "claude", challengePrompt, projectDir, false);
      const challenge = challengeResult.content || `REVIEW_FAILED\n\n${challengeResult.error || "Challenge returned no output"}`;
      await saveGauntletChallenge(db, workflowId, challenge);
      // No challenge means no findings were ever validated, and zero findings
      // used to read as PASSED (run 9: Claude hit its session limit, 429).
      // A run whose challenge failed has not been judged: fail it instead.
      if (challengeResult.status === "failed") {
        throw new Error(`Cross-agent challenge failed, so the run was not judged: ${challengeResult.error || "no output"}`);
      }
      // Fixed 2026-08-31: the old verdict line regex-scanned the raw
      // challenge PROSE for the words "critical"/"high" anywhere at all --
      // since every review prompt tells reviewers to literally use those
      // words as severity labels, any substantive review (dozens of
      // findings) was near-guaranteed to trip it regardless of actual
      // finding quality, making REVISION_REQUIRED almost the only reachable
      // outcome. parseChallengeFindings() is already called here to persist
      // structured findings -- reuse that same parse for the verdict instead
      // of a second, separate text scan, and use it correctly: only
      // VALIDATED findings (not ones the challenge disputed) count, and only
      // their real severity field, not word-presence in surrounding prose.
      const parsedChallengeFindings = parseChallengeFindings(challenge);
      // The challenge listed findings but none survived parsing: that is a
      // parser/format problem, not a clean pass. Fail loudly instead.
      if (parsedChallengeFindings.length === 0 && countRawJsonFindings(challenge) > 0) {
        throw new Error(`Challenge returned ${countRawJsonFindings(challenge)} findings but none could be parsed, so the run was not judged`);
      }
      try {
        await saveGauntletFindings(db, workflowId, "challenge", parsedChallengeFindings);
        // Same F# still open as last round: keep the decision Felton already wrote.
        if (input.previousWorkflowId) await carryForwardRemediations(db, workflowId, input.previousWorkflowId);
      } catch {
        // Same non-fatal enrichment guarantee as the independent phase above.
      }
      const validatedFindings = parsedChallengeFindings.filter((finding) => finding.disposition === "validated");
      const hasBlockingFinding = validatedFindings.some((finding) => finding.severity === "critical" || finding.severity === "high");
      const verdict =
        reviews.some((review) => review.status === "failed") || hasBlockingFinding
          ? "REVISION_REQUIRED"
          : validatedFindings.length === 0
            ? "PASSED"
            : "PASSED_WITH_CONDITIONS";
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
