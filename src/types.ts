// Gauntlet-only contracts. This namespace is intentionally independent from
// Triple-Threat types so the two workflows cannot share mutable state or
// accidentally change each other's behavior.

export const GAUNTLET_REVIEWERS = ["claude", "codex", "antigravity"] as const;
export type GauntletReviewer = (typeof GAUNTLET_REVIEWERS)[number];

export const GAUNTLET_VERDICTS = [
  "PASSED",
  "PASSED_WITH_CONDITIONS",
  "REVISION_REQUIRED",
  "REJECTED"
] as const;
export type GauntletVerdict = (typeof GAUNTLET_VERDICTS)[number];

export const GAUNTLET_SEVERITIES = ["critical", "high", "medium", "low", "observation"] as const;
export type GauntletSeverity = (typeof GAUNTLET_SEVERITIES)[number];

export const GAUNTLET_CATEGORIES = [
  "dependency",
  "logic",
  "security",
  "state",
  "operations",
  "rollback",
  "ambiguity"
] as const;
export type GauntletCategory = (typeof GAUNTLET_CATEGORIES)[number];

// Decided 2026-08-31, output backend changed 2026-09-21 (Felton's call:
// Gauntlet moves off Trilium onto vector memory, matching TT): Gauntlet is
// also used on friends' projects, not just FNDHome's own -- "vector"
// (default) has the finalizer file its reports via mcp__geekygramps__write_memory
// (the consolidated report under doc_type "gauntlet_consolidated_verdict",
// which the vector store auto-flags to_obsidian=true for -- see
// obsidian-export.mjs), "export" instead has the finalizer write plain
// markdown files to a local folder and zip them, with zero vector/Trilium
// involvement, safe to hand off outside this homelab.
export const GAUNTLET_OUTPUT_MODES = ["vector", "export"] as const;
export type GauntletOutputMode = (typeof GAUNTLET_OUTPUT_MODES)[number];

export interface GauntletRequest {
  proposal: string;
  proposalName: string;
  proposalPath?: string;
  requestedBy: string;
  idempotencyKey: string;
  projectSlug?: string;
  projectDir?: string;
  triliumSourceNoteId?: string;
  outputMode?: GauntletOutputMode;
  // Explicit, human-driven link to a prior round -- not an autonomous loop.
  // If set, that round's findings + your own recorded remediation text are
  // injected into every reviewer's prompt as prior-round context, instead of
  // reviewing cold every time.
  previousWorkflowId?: string;
}

// Revise: edits the package in place from one round's remediations, then
// starts the next Gauntlet round linked to it (see gauntletReviseWorkflow).
export interface GauntletReviseRequest {
  sourceWorkflowId: string;
  proposalName: string;
  projectSlug: string;
  projectDir: string;
  requestedBy: string;
}

export interface GauntletReviewEnvelope {
  reviewer: GauntletReviewer;
  status: "succeeded" | "failed";
  content: string;
  error?: string;
}

export interface GauntletFinding {
  id: string;
  reviewer: GauntletReviewer;
  severity: GauntletSeverity;
  category: GauntletCategory;
  scenario: string;
  failure: string;
  blastRadius: string;
  evidence: string;
  recommendation: string;
  verification: string;
}

export interface GauntletResult {
  workflowId: string;
  verdict: GauntletVerdict | "REVISED";
  status: string;
}
