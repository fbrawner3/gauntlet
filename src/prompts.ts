import type { GauntletReviewer } from "./types.js";

export interface GauntletReviewPrompt {
  reviewer: GauntletReviewer;
  prompt: (proposal: string) => string;
}

const common = (proposal: string) => `
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
    prompt: (proposal) => `${common(proposal)}
You are the Architecture Breaker. Focus on workflow logic, assumptions,
missing branches, state transitions, dependencies, conflicting requirements,
coupling, and failure domains. Independently test duplicate execution,
concurrency, stale state, interruption/restart, and partial completion.
`
  },
  codex: {
    reviewer: "codex",
    prompt: (proposal) => `${common(proposal)}
You are the Execution Breaker. Focus on commands, APIs, schemas, files,
permissions, authentication, retries, idempotency, malformed inputs, race
conditions, partial execution, and whether the proposal can actually run.
Independently test unavailable APIs, valid-but-wrong responses, insufficient
or excessive authority, and downstream actions falsely reported as successful.
`
  },
  antigravity: {
    reviewer: "antigravity",
    prompt: (proposal) => `${common(proposal)}
You are the Adversarial Systems Reviewer. Focus on unusual but plausible
failures, cross-system effects, operator behavior, security boundaries,
maintainability, ambiguity, misuse, scaling, and interactions the designer
likely missed. Independently test abuse cases and human recovery behavior.
`
  }
};

export function buildGauntletChallengePrompt(proposal: string, reviews: string[]): string {
  return `
You are conducting Gauntlet's cross-agent challenge phase.

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
verification, disposition (exactly "validated" or "disputed"). This block is
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
