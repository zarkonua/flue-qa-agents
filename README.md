# Flue QA Agents

A local-first, multi-agent QA workflow built on [Flue](https://flueframework.com/). It explores
a running web application in a real browser, records only what it observed, and turns that
evidence into requirements, a manual test suite, automation priorities and bug reports. A
person reviews and changes the result in a local workspace and approves it before any
automation work starts.

Everything is artifact-driven: each stage hands off through a JSON file that is checked
against its schema and against the evidence it claims before it is written. Models run
locally through [Ollama](https://ollama.com/) by default, or through OpenRouter.

```text
PHASE 1 — Manual QA design              npm run qa:manual
    ↓
QA REVIEW WORKSPACE (you)               npm run qa:ui
    ↓
HUMAN APPROVAL GATE                     npm run qa:approve   (or in the workspace)
    ↓
PHASE 2 — Automation engineering        npm run qa:automation
```

## Quick start

```bash
npm install
cp .env.example .env      # set TARGET_URL; QA_TARGET_REPO_ROOT for Phase 2; a model

npm run qa:manual         # Phase 1: five agents in fixed order, then STOP
npm run qa:ui             # review workspace at http://127.0.0.1:4445
npm run qa:approve        # approve Phase 1 (the workspace has the same button)
npm run qa:automation     # Phase 2: entry gate, then Repo Analyzer, then STOP
```

Optional: `npm run qa:review` (suite-wide AI review), `npm run qa:defects` (bug decisions from the
command line, the same as the workspace's), `npm run qa:refresh` (re-derive prioritization and
defect analysis after the suite changed). Full operator guide: **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

## Phase 1 pipeline

Host code fixes the order; no model decides what runs next. Each agent runs as its own
process with only its own tools.

| # | Stage | Writes |
|---|---|---|
| 1 | Product Discovery — browses the target through Playwright MCP | `discovered-behavior.json` |
| 2 | Behavior Analyst — acceptance points and business rules, each citing behaviors | `requirements-analysis.json` |
| 3 | Test Designer — risk-based manual test cases covering every testable requirement | `test-cases.json` |
| 4 | Automation Prioritizer — AUTOMATION/MANUAL, priority and strategy per case | `automation-prioritization.json` |
| 5 | Defect Analyzer — observed behavior that contradicts supported expectations | `defect-analysis.json`, `bugs/BUG-NNN.json` |

A defect is **CONFIRMED** only when an observed behavior contradicts an expectation stated by a
requirement that rests on a *different* observed, or explicitly given, behavior. An expectation
that is only inferred makes it **POTENTIAL** at most. Finding no defect is a valid result;
defects never block approval.

## Human in the loop

Four different things, deliberately kept apart:

| | What it is | Changes the suite? |
|---|---|---|
| `npm run qa:review` | A suite-wide, advisory AI review. Writes `test-cases-review.json`. | Never |
| Change requests (workspace) | You edit, comment on, add or delete a case; the QA agent answers with a **proposal**. | Only when you click Apply |
| Bug decisions (workspace or `qa:defects`) | Accept, reject, downgrade, request changes or edit a bug report. | No — it changes the report, and makes the approval stale |
| Phase 1 approval | Your approval of the exact artifacts on disk, hash-locked. | No — it gates Phase 2 |

```text
you: edit / comment / add / delete
  → request (stored)
  → QA agent PROPOSES complete resulting case(s)      (no write access to the suite)
  → host VALIDATES: schema, evidence, stale check
  → you see CURRENT vs PROPOSED, impact, problems
  → you APPLY, REJECT or REQUEST CHANGES
  → host WRITES test-cases.json atomically
  → prioritization, defect analysis and the Phase 1 approval become STALE
  → you REFRESH dependent analysis (Automation Prioritizer, then Defect Analyzer)
  → you APPROVE Phase 1 again — a refresh never does
```

## QA Review Workspace

`npm run qa:ui` builds the UI when its sources changed and serves it with the host API on
`127.0.0.1:4445` (`QA_UI_PORT`). React + TypeScript + Vite; `npm run qa:ui:dev` adds hot reload.

- **Overview** — counts, requirement coverage with the cases covering each requirement,
  Phase 1 health (test cases, prioritization, defect analysis, AI review, approval — each CURRENT
  or STALE with the reason, e.g. "NC-12 was modified"), **Refresh dependent analysis**, and
  Phase 1 approval.
- **Test Cases** — search and filter by priority, type, strategy and pending changes. Each
  case shows what it covers, the behaviors it cites, its automation decision, related bugs and
  its review history. **Edit** (the id is fixed), **Request Change** (free text), **Delete**,
  and **+ Add Test Case** (describe it in a sentence).
- **Reviews** — every change request by state: proposal ready, processing, pending, failed,
  applied, rejected. A proposal shows a field-level diff (steps as added / removed / changed),
  the host's validation, coverage impact, possible duplicates and unresolved issues. **Apply**
  is disabled unless the host says the proposal is valid and was made from the current suite.
- **Bugs** — the bug reports with their evidence, test-case links (only where a report names the
  case) and review history. **Accept**, **Reject**, **Downgrade** (CONFIRMED → POTENTIAL),
  **Request Changes** (a note; the report's content is untouched) and **Edit** (title, severity,
  priority, steps — previewed as a diff and re-validated against the evidence before Apply).

The QA agent follows the evidence, not the request: asked for an outcome nothing observed, it
leaves it out and records an unresolved issue instead of writing it down as expected behavior.

## Models

One setting, in Flue's `provider/model` form:

```dotenv
QA_MODEL=ollama/qwen3:14b                              # default — local, no key
QA_MODEL=openrouter/deepseek/deepseek-v4-flash-0731    # needs OPENROUTER_API_KEY
```

Ollama context and output limits are configurable (`OLLAMA_CONTEXT_WINDOW`,
`OLLAMA_MAX_OUTPUT_TOKENS`); see the runbook.

## Sign-in and test infrastructure

Discovery starts signed out and handles sign-up and sign-in itself. When a flow needs test
infrastructure on another origin — a MailHog inbox holding the confirmation mail, typically —
allow it with `QA_DISCOVERY_AUX_ORIGINS=http://localhost:8025`. Without it, discovery records the
sign-in flow BLOCKED and never reaches the product behind it, and the suite is correspondingly
small.

## Observability

Optional Langfuse tracing: one trace per QA run and per workspace review, with stages, agent
turns, tool calls, token usage and QA metrics. Off unless `LANGFUSE_ENABLED=true`; prompts and
tool I/O are sent only with `LANGFUSE_CAPTURE_IO=true`, and are redacted even then. See
**[docs/observability.md](docs/observability.md)**.

## Trust boundaries

Enforced in code, not asked for in prompts:

| Invariant | Enforced by |
|---|---|
| Agents have no shell, filesystem API or path argument; each gets narrow tools over roots outside this project | `src/tools/`, `src/lib/trusted-roots.ts` |
| Each agent can write only its own artifact | the write tool's input schema (`writeQaArtifactToolFor`) |
| Every artifact matches its JSON Schema (Ajv, Draft 2020-12) and is supported by upstream evidence — ids resolve, no invented routes, messages, features or credentials | `src/lib/schema-validation.ts`, `src/lib/semantic-validate.ts`, `src/lib/defects.ts` |
| Discovery cannot finalize with unverified actions, unexplored reachable areas or unsupported BLOCKED claims | `src/lib/discovery-completion.ts` |
| The review agent can read its own request and submit a proposal — nothing else | `src/tools/review-proposals.ts` |
| A proposal applies only to the exact suite it was made from, re-validated at apply, written atomically | `src/review/test-case-changes.ts` |
| The workspace API accepts only small, strictly-typed JSON; ids are pattern-checked; no path, file name, command or agent name is ever accepted | `src/ui-server/server.ts` |
| Phase 2 starts only from approved, unchanged content; approval is a person's act | `src/lib/phase1-gate.ts`, SHA-256 of every Phase 1 artifact and bug report |
| Secrets and one-time values never reach an artifact or a trace | `src/lib/redaction.ts`, `src/observability/content-policy.ts` |

What validation does and does not guarantee: **[docs/VALIDATION.md](docs/VALIDATION.md)**.

## Artifacts

Everything lands in `QA_ARTIFACT_ROOT` (default `../qa-workspace/.qa`, outside this project):

| | |
|---|---|
| **Canonical QA results** | `discovered-behavior.json` · `requirements-analysis.json` · `test-cases.json` · `automation-prioritization.json` · `defect-analysis.json` · `bugs/BUG-NNN.json` |
| Advisory | `test-cases-review.json` |
| Approval | `phase1-approval.json` — host code only |
| **Review workflow state** | `reviews/requests/REQ-NNNN.json` · `reviews/proposals/PRP-NNNN.json` |
| Run records | `phase1-run.json`, `runs/<id>/`, `archive/<timestamp>/` |
| Phase 2 | `repo-analysis.json`, `automation-project-contract.json` |

Canonical artifacts hold QA results and are what approval locks. Review workflow state lives
behind a `ReviewStore` interface (`src/review/review-store.ts`); the file-backed store is the
only implementation today.

## Project structure

```text
scripts/        host orchestration: qa-manual · qa-ui · qa-review · qa-approve · qa-defects · qa-automation · lib/
src/
  agents/       Phase 1 stages · focused test-case reviewer · suite reviewer · Repo Analyzer · QA Manager (experimental) · 2 unwired
  tools/        narrow agent tools: QA artifacts · review proposals · observations · repo (read-only) · test code
  review/       ReviewStore, change requests, proposals, host-side apply
  ui-server/    the workspace's host API
  lib/          schema + semantic validation · discovery surface and completion gate · defects · phase-1 gate · redaction
  config/       .env loading · auxiliary origins
  connections/  Playwright MCP, with a per-role tool allowlist
  providers/    Ollama · OpenRouter
  observability/ optional Langfuse
  skills/       custom and vendored QA skills
ui/             the workspace UI (React, TypeScript, Vite)
schemas/        JSON Schemas for every artifact and review record
test/           node:test suites        e2e/   Playwright tests of the workspace
docs/           RUNBOOK · VALIDATION · observability · architecture/
```

```bash
npm test               # unit and integration tests
npm run test:ui-e2e    # the workspace in a real browser, over fixture artifacts
npm run typecheck:ui
```

## Status and known limits

Phase 1, the review workspace and the approval gate are in daily use against a local
application. Phase 2 runs its entry gate and stage 1 (Repo Analyzer); UI Explorer and
Automation Generator exist in `src/agents/` but are wired to no command. Test Runner and
Failure Analyzer are not built.

- An agent turn sometimes ends without its tool call; each stage retries (four attempts by
  default), the review agent twice.
- The suite is only as deep as discovery: a thin discovery run yields a small suite.
- The review agent answers from recorded evidence; it does not browse to verify a new claim.
  A request the evidence cannot support comes back unresolved.
- After a test case changes, prioritization and defect analysis are STALE until refreshed; the
  refresh is a model run and is started on purpose (Overview, or `npm run qa:refresh`), never
  automatically after each edit. A regenerated defect analysis keeps a person's decision only on
  bugs that are materially the same; the rest start again as PENDING.
- Deterministic validation proves a claim is supported, not that it is right; see VALIDATION.md.
