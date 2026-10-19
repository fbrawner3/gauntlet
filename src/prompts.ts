import { OBSIDIAN_DOC_STYLE } from "../obsidianStyle.js";
import type { GauntletOutputMode, GauntletReviewer } from "./types.js";

export interface GauntletReviewPrompt {
  reviewer: GauntletReviewer;
  prompt: (proposal: string, priorRemediation?: string) => string;
}

// Rendered only when a run explicitly links to a previous one
// (input.previousWorkflowId) -- not shown at all on a cold/first run, so
// existing behavior is unchanged unless a human deliberately continues from
// a prior round.
function priorRemediationBlock(priorRemediation?: string): string {
  if (!priorRemediation) return "";
  return `
PRIOR ROUND REMEDIATION
========================
The proposal below was already reviewed once. Here is what was actually
remediated since that round, per finding. Do not re-raise a finding exactly
as before if the stated remediation genuinely addresses it -- verify the
remediation against the current proposal/code instead of accepting the
claim at face value, and raise a new finding if it doesn't actually hold.

${priorRemediation}
`;
}

// Severity and stopping rule (Felton, 2026-10-02). Reviewers are adversarial by
// design, so without a definition every untested or optional item became
// "high" and the review never ended. high/critical now require a demonstrated
// failure; everything conditional or optional is "observation" and is
// recorded as residual risk without blocking approval.
const SEVERITY_AND_STOPPING_RULE = `
SEVERITY AND STOPPING RULE (mandatory)
======================================
- critical or high ONLY when you can point to the exact file and line where the package is demonstrably wrong and will fail, when it breaks a requirement Felton has stated, or when it creates a material security or data-loss risk. Quote the evidence.
- Something that is merely untested, unverified, conditional ("if X then..."), optional, a best practice, or a nice-to-have is "observation" (or "low" at most). It is a residual risk, not a blocker.
- "Needs an acceptance test or live check" is NOT a blocker for a design review: those run at install time. Record it once as an observation.
- Merge duplicates into one finding. Do not split one problem into several.
- Do not invent a new blocker to replace one that was fixed. A new high or critical finding must meet the first rule above on the current files.
- If nothing meets the first rule, return no high or critical findings. That is a valid and expected outcome.
`;

const common = (proposal: string, priorRemediation?: string) => `
You are reviewing the following proposal through Gauntlet. If it identifies a
Trilium source folder, read that folder and all child notes recursively before
reviewing it. If it is a local path, read that path from the supplied project
directory.
Return the review as markdown in your final response. Do not create or modify
any files; the Gauntlet finalizer agent writes the output files.

Gauntlet is an adversarial review, not a redesign exercise. Do not silently
invent missing facts. Treat material omissions as findings.
Use only the proposal and files present in the supplied project directory or
the supplied Trilium source folder.
Do not use external repository services or repository/search integrations.
Local filesystem access to the supplied project directory is allowed. If
local evidence is missing, record that as a finding instead of looking it up
elsewhere.

PROPOSAL
========
${proposal}
${priorRemediationBlock(priorRemediation)}
${SEVERITY_AND_STOPPING_RULE}
Return concrete findings only. Each finding must include: scenario, failure,
blast radius, evidence, recommendation, and verification. Use severity
critical, high, medium, low, or observation, and category dependency, logic,
security, state, operations, rollback, or ambiguity.

After the markdown narrative, append one fenced code block labeled json
containing a JSON array of every finding above, one object per finding, using
exactly these keys: id (a short stable label like "F1", "F2"), severity,
category, scenario, failure, blastRadius, evidence, recommendation,
verification. If you have no findings, return an empty array. This block is
parsed by an automated pipeline -- return it exactly once, with no
commentary inside it, and do not omit it even if it duplicates the markdown.
`;

export const GAUNTLET_REVIEW_PROMPTS: Record<GauntletReviewer, GauntletReviewPrompt> = {
  claude: {
    reviewer: "claude",
    prompt: (proposal, priorRemediation) => `${common(proposal, priorRemediation)}
You are the Architecture Breaker. Focus on workflow logic, assumptions,
missing branches, state transitions, dependencies, conflicting requirements,
coupling, and failure domains. Independently test duplicate execution,
concurrency, stale state, interruption/restart, and partial completion.
`
  },
  codex: {
    reviewer: "codex",
    prompt: (proposal, priorRemediation) => `${common(proposal, priorRemediation)}
You are the Execution Breaker. Focus on commands, APIs, schemas, files,
permissions, authentication, retries, idempotency, malformed inputs, race
conditions, partial execution, and whether the proposal can actually run.
Independently test unavailable APIs, valid-but-wrong responses, insufficient
or excessive authority, and downstream actions falsely reported as successful.
`
  },
  antigravity: {
    reviewer: "antigravity",
    prompt: (proposal, priorRemediation) => `${common(proposal, priorRemediation)}
You are the Adversarial Systems Reviewer. Focus on unusual but plausible
failures, cross-system effects, operator behavior, security boundaries,
maintainability, ambiguity, misuse, scaling, and interactions the designer
likely missed. Independently test abuse cases and human recovery behavior.
`
  }
};

// Follow-up rounds: finding identity must carry over. Without this, each round
// invents new F-numbers and Felton has to re-validate findings he already
// worked through.
function priorFindingIdentityBlock(priorRemediation?: string, nextFindingNumber?: number): string {
  if (!priorRemediation) return "";
  return `
FINDING IDENTITY ACROSS ROUNDS (mandatory)
==========================================
The prior-round findings above each have an F-number. Keep those numbers.
- For EVERY prior finding, return exactly one entry in your JSON array using its ORIGINAL id and the same meaning:
  - disposition "resolved" if the current files now fix it (say what proves it in evidence),
  - disposition "validated" if it is still open (say specifically what is still missing),
  - disposition "disputed" only if it was never a valid finding.
- Prior findings marked RESOLVED stay resolved unless the current files regress them.
- Only a genuinely NEW problem gets a new id, numbered from F${nextFindingNumber ?? 1} upward. Never reuse or renumber a prior id, and never give a prior finding's problem a new id.
`;
}

export function buildGauntletChallengePrompt(proposal: string, reviews: string[], priorRemediation?: string, nextFindingNumber?: number): string {
  return `
You are conducting Gauntlet's cross-agent challenge phase.
${priorRemediationBlock(priorRemediation)}
${priorFindingIdentityBlock(priorRemediation, nextFindingNumber)}
${SEVERITY_AND_STOPPING_RULE}
Re-grade every finding, including carried-over ones, against this rule before you return it. Downgrade to "observation" anything that is only untested, conditional, optional, or a duplicate, and merge duplicates. Do not keep a finding at high or critical because an earlier round did.

Re-evaluate the proposal and the three independent reviews below. Identify
duplicate, unsupported, hallucinated, mis-severitized, or conflicting findings,
and add concrete missing findings. Do not accept a concern merely because a
reviewer stated it. Return validated findings and disputed findings with the
same structured fields as the independent phase.

After the markdown narrative, append one fenced code block labeled json
containing a JSON array covering every finding you are validating or
disputing (including ones you are adding), one object per finding, using
exactly these keys: id (a short stable label like "F1", "F2"), reviewer
(exactly "claude", "codex", or "antigravity" -- whichever independent review
originally raised it, or the one closest in spirit if you added it), severity,
category, scenario, failure, blastRadius, evidence, recommendation,
verification, disposition (exactly "validated" or "disputed"; on a follow-up round also "resolved" as described above). This block is
parsed by an automated pipeline -- return it exactly once, with no commentary
inside it, and do not omit it even if it duplicates the markdown.

PROPOSAL
========
${proposal}

INDEPENDENT REVIEWS
===================
${reviews.map((review, index) => `--- REVIEW ${index + 1} ---\n${review}`).join("\n\n")}
`;
}

// Revise stage: one write-mode agent edits the build package in place so the
// next Gauntlet round has something different to judge. It starts with no
// memory of how the package was designed, so everything it must respect is
// written into the prompt: the repo's deploy standard, Felton's recorded
// decisions (locked), and one checklist item per validated finding.
export function buildGauntletRevisePrompt(params: {
  proposalName: string;
  sourceWorkflowId: string;
  packageDir: string;
  remediated: Array<{ ref: string; severity: string; category: string; scenario: string; failure: string; recommendation: string; remediation: string }>;
  unremediated: Array<{ ref: string; severity: string; category: string; scenario: string }>;
  decisions: string;
}): string {
  const checklist = params.remediated
    .map((f) => `### ${f.ref} — ${f.severity} / ${f.category}\nScenario: ${f.scenario}\nFailure: ${f.failure}\nReviewer recommendation: ${f.recommendation}\nFELTON'S DECISION (binding): ${f.remediation}`)
    .join("\n\n");
  const open = params.unremediated.length
    ? params.unremediated.map((f) => `- ${f.ref} (${f.severity} / ${f.category}): ${f.scenario}`).join("\n")
    : "(none)";
  return `You are the Gauntlet reviser for "${params.proposalName}". Your job is to edit the build package so Felton's decisions below are actually reflected in its files. Gauntlet reviewed round ${params.sourceWorkflowId} and a new round will review your result with fresh eyes.

SCOPE
- The package is the folder "${params.packageDir}" (relative to the current working directory, the repository root). Edit, add, or remove files ONLY inside that folder.
- Do not touch anything outside it. Do not run git commands. Do not write to vector memory or any external service.
- Edit files in place. Do not create copies, backups, or "-v2" files.
- Do NOT delete, rename, merge, or split any file, and do NOT change how the package is divided (for example the number of Helm releases, values files, pods, or controllers). The existing structure is a locked decision even if a finding suggests otherwise; if a finding seems to require a structural change, leave it unapplied and say so in your report.
- Do not rewrite or shorten historical or review documents (for example CODEX-IMPLEMENTATION-REVIEW.md, IMPLEMENTATION-RUNBOOK.md). Only touch them if a decision below names that file.
- You are here to REVISE the package, not to annotate it. For each decided finding, change the package so the finding is actually fixed: write the real content, values, manifests, config, steps, or text the decision calls for.
- These do NOT count as applying a finding, and you must not report them as Applied: adding a "verification gate", a "required test", a "TODO", a comment, an "[UNVERIFIED]" marker, or text saying the item is "unresolved", "blocked" or "must be verified". If the only thing you can do is write one of those, the finding is NOT applied: say so under Not applied with the reason.
- Create new files inside the package folder when a decision needs them (for example manifests or config). Do not stop at describing what a file would contain.
- Never use "[UNVERIFIED]" or any hedge to avoid writing the content. Write the content.
- Read k3s-working/_standards first; the package must follow it unless Felton's decisions below say otherwise.

LOCKED DECISIONS (do not undo, re-argue, or redesign any of these)
${params.decisions || "(none on record)"}

FINDINGS FELTON HAS DECIDED (do each one, in the files)
${checklist || "(none)"}

For every item above, the package file(s) must change so the decision is true. If a decision truly cannot be applied (it contradicts a locked decision or a file you cannot create), do not improvise: leave that item unchanged and say why in your report.

FINDINGS WITH NO DECISION (do NOT change the package for these; just list them as open)
${open}

If you notice a new problem while editing, do not fix it silently. List it in your report under NEW ISSUES with the file and what is wrong.

Decide concrete values yourself from the package files, the findings, Felton's decisions, and k3s-working/_standards: write the actual ports, paths, user and group IDs, resource requests and limits, probes, mounts, policies, and so on into the files. Do not write "[UNVERIFIED]" or hedge a value you can reasonably decide. If you must choose a default, write the value and list it under Not applied with the reason it needs Felton's confirmation.

FINAL REPLY: markdown change log only, with these sections:
## Applied   (one line per finding ref: the file(s) changed and the concrete content you wrote, quoted briefly. A line that only says "added a gate/test/note" is not allowed here)
## Not applied   (finding ref and the reason)
## Open findings   (the refs listed above as having no decision)
## New issues   (anything you noticed; empty if none)`;
}

// Decided 2026-08-31: "vector" mode (default, renamed from "trilium"
// 2026-09-21 -- Felton's call: Gauntlet moves off Trilium onto vector memory,
// matching TT's tripleThreatPrompts.ts pattern) has the specialist file its
// own reports via mcp__geekygramps__write_memory, one call per report, same
// note_id every time so a re-run updates rather than duplicates. The
// consolidated GAUNTLET-REVIEW note uses doc_type "gauntlet_consolidated_verdict",
// the one Gauntlet doc_type the vector store auto-flags to_obsidian=true for
// (db/migrations/202609070001_vector_memory.sql), which the workstation
// poller (trilium-vector-mirror/scripts/obsidian-export.mjs) then exports to
// the FeltonsVault Runbooks tree -- see that script for the exact path shape.
// "export" mode is unchanged and is for Gauntlet runs on friends' projects:
// the specialist instead writes plain markdown files to a local folder and
// zips them, with zero vector/Trilium involvement, so nothing about someone
// else's project ever touches this homelab's own knowledge base.
export function buildGauntletFinalizerPrompt(params: {
  proposalName: string;
  workflowId: string;
  projectSlug: string;
  verdict: string;
  claudeReview: string;
  codexReview: string;
  antigravityReview: string;
  challenge: string;
  outputMode: GauntletOutputMode;
}): string {
  const body = `VERDICT: ${params.verdict}\n\nCLAUDE REVIEW:\n${params.claudeReview}\n\nCODEX REVIEW:\n${params.codexReview}\n\nANTIGRAVITY REVIEW:\n${params.antigravityReview}\n\nCHALLENGE:\n${params.challenge}`;

  if (params.outputMode === "export") {
    return `You are the Gauntlet finalizer, running in EXPORT mode -- this proposal is not FNDHome's own, do not touch vector memory, Trilium, or any Trilium tool at all.

Create a local folder named "${params.proposalName}" inside a subfolder called gauntlet-exports under the current working directory. Inside it, write six plain markdown files named GAUNTLET-REVIEW.md, verdict.md, claude-review.md, codex-review.md, antigravity-review.md, and cross-agent-challenge.md, using the exact content below (verdict.md contains only the VERDICT line). Then zip that folder into "${params.proposalName}.zip" in the same gauntlet-exports directory. Do not use vector memory, Trilium, any Trilium tool, or any external repository or service.

${body}

After writing and zipping the files, return the consolidated GAUNTLET-REVIEW content only, followed by the absolute path to the zip file.`;
  }

  // Bare (no suffix) so the workstation poller can derive the vault filename
  // from it directly (Gauntlet-<workflowId>.md) -- see obsidian-export.mjs.
  const base = `gauntlet-${params.workflowId}`;
  const ancestry = JSON.stringify([params.proposalName, params.workflowId]);
  const reports = [
    { id: `${base}-verdict`, title: `${params.proposalName} — Verdict`, docType: "gauntlet_verdict", desc: "verdict.md's content (the VERDICT line only)" },
    { id: `${base}-claude-review`, title: `${params.proposalName} — Claude Review`, docType: "gauntlet_review", desc: "claude-review.md's content" },
    { id: `${base}-codex-review`, title: `${params.proposalName} — Codex Review`, docType: "gauntlet_review", desc: "codex-review.md's content" },
    { id: `${base}-antigravity-review`, title: `${params.proposalName} — Antigravity Review`, docType: "gauntlet_review", desc: "antigravity-review.md's content" },
    { id: `${base}-challenge`, title: `${params.proposalName} — Cross-Agent Challenge`, docType: "gauntlet_challenge", desc: "cross-agent-challenge.md's content" }
  ];
  const callList = reports
    .map((r) => `- note_id="${r.id}", title="${r.title}", project="${params.projectSlug}", doc_type="${r.docType}", ancestry=${ancestry}, content = ${r.desc}`)
    .join("\n");

  return `You are the Gauntlet finalizer. Do not use Trilium, any Trilium tool, or any external repository or service.

File each of the following as its own call to mcp__geekygramps__write_memory. Reuse the exact note_id given so a re-run updates the note instead of duplicating it:
${callList}
- note_id="${base}", title="${params.proposalName} — GAUNTLET-REVIEW", project="${params.projectSlug}", doc_type="gauntlet_consolidated_verdict", ancestry=${ancestry}, content = the consolidated GAUNTLET-REVIEW report (verdict plus all four reviews, formatted as one human-facing markdown document -- this is the report a human reads, not a summary of it. ${OBSIDIAN_DOC_STYLE})

${body}

After filing all six notes, return the consolidated GAUNTLET-REVIEW content only.`;
}
