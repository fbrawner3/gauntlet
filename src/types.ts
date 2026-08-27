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

export interface GauntletRequest {
  proposal: string;
  proposalName: string;
  proposalPath?: string;
  requestedBy: string;
  idempotencyKey: string;
  projectSlug?: string;
  projectDir?: string;
  triliumSourceNoteId?: string;
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
  verdict: GauntletVerdict;
  status: string;
}
