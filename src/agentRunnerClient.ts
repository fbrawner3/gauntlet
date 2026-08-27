// Gauntlet-owned copy of the agent-runner HTTP contract. Keep this client
// separate from Triple-Threat so future Gauntlet changes cannot alter TT.

export interface GauntletAgentRunnerConfig {
  baseUrl: string;
  token: string;
}

export interface GauntletSubmittedJob { runnerJobId: string; status: string; }
export interface GauntletJobStatus { runnerJobId: string; status: "running" | "succeeded" | "failed"; }
export interface GauntletArtifact { status: string; content: string; source: string; }

function headers(config: GauntletAgentRunnerConfig): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${config.token}` };
}

export async function submitGauntletJob(
  config: GauntletAgentRunnerConfig,
  params: { reviewer: "claude" | "codex" | "antigravity"; stage: string; projectDir: string; prompt: string; mode?: "write" | "readonly" }
): Promise<GauntletSubmittedJob> {
  const response = await fetch(`${config.baseUrl}/jobs`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      specialist: params.reviewer,
      stage: `gauntlet_${params.stage}`,
      project_slug: "gauntlet",
      project_dir: params.projectDir,
      prompt: params.prompt,
      mode: params.mode || "write"
    }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`agent-runner-service rejected Gauntlet job: HTTP ${response.status}`);
  const body = (await response.json()) as { job_id: string; status: string };
  return { runnerJobId: body.job_id, status: body.status };
}

export async function getGauntletJobStatus(config: GauntletAgentRunnerConfig, runnerJobId: string): Promise<GauntletJobStatus> {
  const response = await fetch(`${config.baseUrl}/jobs/${encodeURIComponent(runnerJobId)}`, {
    headers: headers(config), signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`agent-runner-service Gauntlet status failed: HTTP ${response.status}`);
  const body = (await response.json()) as { job_id: string; status: string };
  return { runnerJobId: body.job_id, status: body.status as GauntletJobStatus["status"] };
}

export async function getGauntletArtifact(config: GauntletAgentRunnerConfig, runnerJobId: string): Promise<GauntletArtifact> {
  const response = await fetch(`${config.baseUrl}/jobs/${encodeURIComponent(runnerJobId)}/artifact`, {
    headers: headers(config), signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`agent-runner-service Gauntlet artifact failed: HTTP ${response.status}`);
  return (await response.json()) as GauntletArtifact;
}
