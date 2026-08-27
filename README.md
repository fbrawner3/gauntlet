# Gauntlet

Gauntlet is an adversarial, multi-agent review workflow for proposal and project material. It runs inside `geekygramps-mcp` as a DBOS workflow and uses the shared agent-runner service to invoke independent reviewers.

Gauntlet is intentionally separate from Triple-Threat. Triple-Threat owns project planning, approvals, implementation, validation, and handoff. Gauntlet provides an independent pressure test of the material before or alongside that work.

## What it does

For each run, Gauntlet:

1. Resolves the supplied proposal or Trilium source location.
2. Ingests a source note or a folder, including nested child notes.
3. Runs independent reviews from Claude, Codex, and Antigravity.
4. Runs a cross-agent challenge over the proposal and independent reviews.
5. Determines a verdict from reviewer failures and high-severity findings.
6. Uses a finalizer agent to create the report notes in Trilium.
7. Persists workflow state, reviews, findings, challenges, and the final artifact in PostgreSQL.
8. Reports progress and completion through the Gauntlet Mattermost bot.

## Review roles

| Reviewer | Focus |
| --- | --- |
| Claude | Architecture, assumptions, state transitions, dependencies, and failure domains |
| Codex | Commands, APIs, schemas, permissions, authentication, retries, and execution behavior |
| Antigravity | Adversarial systems behavior, abuse cases, operator recovery, scaling, and maintainability |

Every independent review returns a Markdown report followed by a machine-readable JSON findings block. Findings are best-effort parsed into the database without making the review dependent on parsing success.

## Source and report locations

Gauntlet reads the source supplied with the run. The intended source of truth is Trilium, where a run may target a single note or a folder tree.

Reports are created under:

```text
Operations / Gauntlet Reports / <project name>
```

The report folder contains the consolidated `GAUNTLET-REVIEW`, verdict, reviewer reports, cross-agent challenge, and run metadata as applicable. Reports are not written into the source folder and are not intended to be committed to the repository.

## Mattermost commands

The Gauntlet bot accepts:

```text
run <project name> :: <Trilium source location>
status <workflow id>
artifact <workflow id>
```

The bot posts the workflow ID, progress updates, final verdict, and consolidated artifact in the dedicated Gauntlet channel.

## HTTP API

The MCP service exposes these Gauntlet routes:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/gauntlet/runs` | Start a DBOS workflow |
| `GET` | `/gauntlet/runs/:workflowId` | Read persisted run state |
| `GET` | `/gauntlet/runs/:workflowId/artifact` | Retrieve the consolidated artifact |
| `GET` | `/gauntlet/runs/:workflowId/findings` | Retrieve structured findings |

The start request includes `proposalName`, `proposal`, `requestedBy`, and `idempotencyKey`. Optional fields include `projectSlug`, `projectDir`, and the Trilium source identifier.

## Durable state

DBOS provides durable workflow execution and PostgreSQL-backed state. Gauntlet stores:

- run status, proposal, verdict, final artifact, and failure information;
- independent reviewer output;
- cross-agent challenge output; and
- structured findings and dispositions.

The database must be initialized before the workflow is started. The service's existing initialization script provisions the DBOS application tables and Gauntlet tables.

## Repository and security boundaries

- Gauntlet owns its contracts, prompts, workflow, persistence, Mattermost handler, and agent-runner client in this directory.
- Its agent-runner client is a Gauntlet-specific copy so changes cannot alter Triple-Threat behavior.
- Gauntlet does not search Gitea or use external repository integrations for the review process.
- Triple-Threat's existing repository access and shared agent permissions remain unchanged.
- Reviewer jobs receive only the supplied project/source context and the review prompt.
- A run is not complete until the final report artifacts are created and the result is reported.

## Source files

- `workflow.ts` — DBOS workflow orchestration and reviewer/finalizer execution
- `routes.ts` — HTTP API routes
- `mattermost.ts` — Mattermost command parsing and responses
- `agentRunnerClient.ts` — Gauntlet-specific agent-runner HTTP contract
- `prompts.ts` — reviewer and cross-agent challenge prompts
- `findings.ts` — structured findings extraction and validation
- `store.ts` — PostgreSQL persistence
- `types.ts` — Gauntlet-only contracts and verdict/severity enums
