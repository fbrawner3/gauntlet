// Parses the structured JSON findings block that GAUNTLET_REVIEW_PROMPTS and
// buildGauntletChallengePrompt (prompts.ts) require agents to append after
// their markdown narrative. Parsing is best-effort: a missing or malformed
// block yields zero findings rather than failing the review -- findings are
// an enrichment on top of the review content, never a requirement for it.
import { z } from "zod";
import { GAUNTLET_CATEGORIES, GAUNTLET_REVIEWERS, GAUNTLET_SEVERITIES } from "./types.js";
import type { GauntletCategory, GauntletReviewer, GauntletSeverity } from "./types.js";

export interface ParsedFinding {
  findingRef: string;
  reviewer: GauntletReviewer;
  severity: GauntletSeverity;
  category: GauntletCategory;
  scenario: string;
  failure: string;
  blastRadius: string;
  evidence: string;
  recommendation: string;
  verification: string;
  // "resolved" is only used on a follow-up round: the prior round's finding,
  // by the same F#, that the current files now fix. It never counts toward
  // the verdict (which counts "validated" only).
  disposition: "validated" | "disputed" | "resolved" | null;
}

const baseFindingSchema = z.object({
  id: z.string().min(1).max(40),
  severity: z.enum(GAUNTLET_SEVERITIES),
  category: z.enum(GAUNTLET_CATEGORIES),
  scenario: z.string().min(1),
  failure: z.string().min(1),
  blastRadius: z.string().min(1),
  evidence: z.string().min(1),
  recommendation: z.string().min(1),
  verification: z.string().min(1)
});

const challengeFindingSchema = baseFindingSchema.extend({
  reviewer: z.enum(GAUNTLET_REVIEWERS),
  // A finding the challenge lists in its JSON array is validated unless it
  // says otherwise. Run 12 returned 41 findings with no disposition key; the
  // parser required one, dropped all 41, and zero findings read as PASSED.
  disposition: z.enum(["validated", "disputed", "resolved"]).default("validated")
});

function extractJsonArray(content: string): unknown[] | null {
  const match = content.match(/```json\s*([\s\S]*?)```/i);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1].trim());
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseIndependentFindings(reviewer: GauntletReviewer, content: string): ParsedFinding[] {
  const raw = extractJsonArray(content);
  if (!raw) return [];
  const findings: ParsedFinding[] = [];
  for (const item of raw) {
    const result = baseFindingSchema.safeParse(item);
    if (!result.success) continue;
    findings.push({
      findingRef: result.data.id,
      reviewer,
      severity: result.data.severity,
      category: result.data.category,
      scenario: result.data.scenario,
      failure: result.data.failure,
      blastRadius: result.data.blastRadius,
      evidence: result.data.evidence,
      recommendation: result.data.recommendation,
      verification: result.data.verification,
      disposition: null
    });
  }
  return findings;
}

// How many entries the challenge's JSON array held, whether or not they parsed.
// Lets the workflow tell "no findings" apart from "findings the parser dropped".
export function countRawJsonFindings(content: string): number {
  return extractJsonArray(content)?.length ?? 0;
}

export function parseChallengeFindings(content: string): ParsedFinding[] {
  const raw = extractJsonArray(content);
  if (!raw) return [];
  const findings: ParsedFinding[] = [];
  for (const item of raw) {
    const result = challengeFindingSchema.safeParse(item);
    if (!result.success) continue;
    findings.push({
      findingRef: result.data.id,
      reviewer: result.data.reviewer,
      severity: result.data.severity,
      category: result.data.category,
      scenario: result.data.scenario,
      failure: result.data.failure,
      blastRadius: result.data.blastRadius,
      evidence: result.data.evidence,
      recommendation: result.data.recommendation,
      verification: result.data.verification,
      disposition: result.data.disposition
    });
  }
  return findings;
}
