# Flue QA Agents

A local-first, artifact-driven, multi-agent QA workflow built on
[Flue](https://flueframework.com/).

## What it is

Flue QA Agents points a set of narrowly-scoped AI agents at a running web application. They
explore it in a real browser, record only what they observed, and turn that evidence into
requirements, a manual test suite, automation priorities and bug reports. A person reviews and
changes the result in a local workspace, and must explicitly approve it before any automation
work (Phase 2) may start.

Every hand-off is a JSON artifact on disk. Host code — not a model — decides which stage runs
next, and checks each artifact against its JSON Schema and against the upstream evidence
before it is written.

## Core capabilities

- **Product Discovery** — explores the target through Playwright MCP; the host tracks the
  reachable surface and refuses to let discovery finish while it has evidence that
  exploration is incomplete.
- **Behavior analysis** — acceptance points and business rules, each citing observed behaviors.
- **Test case generation** — a risk-based manual suite that covers every testable requirement.
- **Automation prioritization** — AUTOMATION / MANUAL, priority and strategy for every case.
- **Defect analysis** — evidence-grounded findings and one bug report per defect.
- **Deterministic validation** — schema (Ajv, Draft 2020-12) and semantic checks: evidence
  ids resolve, no invented routes, messages, features or credentials.
- **QA Review Workspace** — a local React UI for test cases, change requests and proposals,
  bugs, dependency freshness and Phase 1 approval.
- **Hash-based human approval** — Phase 2 refuses to start unless a person approved the exact
  Phase 1 content on disk.
- **Phase 2 Repo Analyzer** — reads the target automation repository and records how tests are
  written there.
- **Models** — local Ollama or OpenRouter, selected by one setting.
- **Observability** — optional Langfuse tracing, off by default.

## Architecture overview

```text
Target application ──► PHASE 1 agents (host-sequenced) ──► canonical QA artifacts (.qa/)
                                                              │
                         QA Review Workspace  ◄───────────────┘
                         (you: change requests, proposals, bug decisions)
                                                              │
                         Phase 1 approval (hash-locked, human-only)
                                                              │
                         PHASE 2 ──► entry gate ──► Repo Analyzer ──► STOP
```

Diagrams (Mermaid) for the system, Phase 1, discovery, the review workspace, trust boundaries
and Phase 2 live in **[docs/architecture/](docs/architecture/README.md)**.

## Quick start

Requires Node ≥ 22.19, the application under test running, and either a local Ollama or an
OpenRouter key.

```bash
npm install
cp .env.example .env      # set TARGET_URL, and QA_MODEL (+ OPENROUTER_API_KEY for OpenRouter)

npm run check:playwright  # Chromium and the MCP server are usable
npm run qa:manual         # Phase 1: five stages in fixed order, then STOP
npm run qa:ui             # QA Review Workspace at http://127.0.0.1:4445
npm run qa:approve        # approve Phase 1 (the workspace has the same button)
npm run qa:automation     # Phase 2: entry gate, Repo Analyzer, then STOP (needs QA_TARGET_REPO_ROOT)
```

`npm run qa` is an alias of `qa:manual`. Resuming, retries, exit codes and every setting are in
the **[runbook](docs/RUNBOOK.md)**.

## Phase 1 pipeline

The stage list is a closed allowlist in `scripts/lib/phase1-stages.mjs`. Each agent runs in its
own process with only its own tools; a stage passes only if its artifact was written during
that attempt and re-validates from disk.

| # | Stage | Agent | Writes |
|---|---|---|---|
| 1 | `discovery` | Product Discovery | `discovered-behavior.json` (plus host-written `discovery-evidence.json`) |
| 2 | `analysis` | Behavior Analyst | `requirements-analysis.json` |
| 3 | `design` | Test Designer | `test-cases.json` |
| 4 | `prioritization` | Automation Prioritizer | `automation-prioritization.json` |
| 5 | `defects` | Defect Analyzer | `defect-analysis.json`, `bugs/BUG-NNN.json` |

Then the run stops. Review, refresh and approval are separate, human-started steps.

## QA Review Workspace

`npm run qa:ui` builds the UI when its sources changed and serves it together with the host API
on `127.0.0.1:4445` (loopback by default, no login). It is React + TypeScript + Vite;
`npm run qa:ui:dev` adds hot reload.

- **Overview** — counts, requirement coverage, and Phase 1 health: each derived artifact is
  CURRENT or STALE with the reason (e.g. "TC-012 was modified"). **Refresh dependent
  analysis** and **Approve Phase 1** live here.
- **Test Cases** — search and filter; each case shows what it covers, the behaviors it cites,
  its automation decision, related bugs and review history. **Edit**, **Request Change**
  (free text), **Delete**, and **+ Add Test Case** (one sentence).
- **Reviews** — every change request by state (pending, processing, proposal ready, changes
  requested, failed, applied, rejected). A proposal shows CURRENT vs PROPOSED field by field,
  the host's validation, coverage impact, possible duplicates and unresolved issues, with
  **Apply**, **Reject** and **Request Changes**.
- **Bugs** — the bug reports with their evidence, related test cases and review history, with
  the decisions described under [Bugs](#bugs).

## Human-in-the-loop approval model

Five different things, deliberately kept apart:

| | Who | Changes canonical artifacts? |
|---|---|---|
| **AI generation** (`qa:manual`, `qa:refresh`) | agents, host-sequenced | Yes — each stage writes its own artifact |
| **AI suite review** (`qa:review`) | Test Case Reviewer | No — advisory `test-cases-review.json` only |
| **Test-case proposal** (workspace) | focused review agent, or the host for a deletion | No — a proposal is workflow state |
| **Applying a proposal** (workspace) | you | Yes — the host rewrites `test-cases.json` |
| **Phase 1 approval** (`qa:approve` or workspace) | you | No — it records hashes and gates Phase 2 |

```text
AI produces the Phase 1 artifacts
  → you review them in the workspace
  → you edit / comment on / add / delete a test case          (a change request)
  → the review agent PROPOSES the complete resulting case(s)  (it cannot write the suite)
  → the host VALIDATES: schema, evidence, base-suite hash
  → you APPLY, REJECT or REQUEST CHANGES
  → the host writes test-cases.json atomically
  → prioritization, defect analysis and the Phase 1 approval become STALE
  → you REFRESH dependent analysis (Automation Prioritizer, then Defect Analyzer)
  → you APPROVE Phase 1 again — nothing restores an approval for you
```

- `npm run qa:review` is **advisory**: it never changes the suite and is never approval.
- **Applying a proposal is not Phase 1 approval.** It changes the suite and makes any existing
  approval stale.
- **Phase 1 approval is the final, explicit human gate.** It records the SHA-256 of the five
  Phase 1 artifacts and of every bug report; changing any of them afterwards makes it stale,
  and Phase 2 refuses to start.

## Bugs

Bug reports are produced by the **Defect Analyzer** (Phase 1 stage 5), which reads the recorded
evidence — it has no browser. A finding is `CONFIRMED_DEFECT` only when an observed behavior
contradicts a requirement resting on *different* observed or confirmed evidence; an inferred
expectation makes it `POTENTIAL_DEFECT` at most. Finding nothing is a valid result.

Each defect becomes `bugs/BUG-NNN.json` with `status` (CONFIRMED / POTENTIAL), `title`,
`severity`, `priority` (`UNASSIGNED` until a person sets it), `steps`, `expected`, `actual`,
the host-derived `expectedBasis`, `evidence`, `environment`, and explicit trace links:
`sourceBehaviorIds`, `sourceAcceptancePointIds`, `sourceBusinessRuleIds` and
`sourceTestCaseIds`. The workspace links a bug to a test case only through
`sourceTestCaseIds`.

Bugs are **reviewable, not only readable**: in the workspace or with `npm run qa:defects` you can
**Accept**, **Reject**, **Downgrade** (CONFIRMED → POTENTIAL), **Request Changes** (a note) or
**Edit** title, severity, priority and steps. An edit is re-validated against the evidence
before it is saved. Each action is made against the report's current hash, so a concurrent
change conflicts instead of being overwritten. Every decision is recorded in `reviews/bugs/BUG-NNN.json` and makes an
existing Phase 1 approval stale. Undecided bugs do not block approval.

When defect analysis is refreshed, the host carries a decision over only to a regenerated report
that is materially the same defect; the rest start again as PENDING.

## Phase 2

`npm run qa:automation` runs an **entry gate** (Phase 1 complete, valid, approved and unchanged
since approval, with at least one AUTOMATION case), then **Repo Analyzer**, which reads
`QA_TARGET_REPO_ROOT` read-only and writes `repo-analysis.json`. The host then derives
`automation-project-contract.json` from it, and stops.

That is all Phase 2 does today. `src/agents/ui-explorer.ts` and
`src/agents/automation-generator.ts` exist but are wired to no command, and the Phase 2
allowlist refuses to start them.

## Models and providers

One setting, in Flue's `<provider>/<model>` form; every agent uses it.

```dotenv
QA_MODEL=ollama/<model>          # local Ollama; OLLAMA_BASE_URL, OLLAMA_CONTEXT_WINDOW, OLLAMA_MAX_OUTPUT_TOKENS
QA_MODEL=openrouter/<vendor>/<model>
OPENROUTER_API_KEY=...           # required for openrouter/*; read host-side only
```

Any other provider prefix is refused at startup. When `QA_MODEL` is unset the code falls back
to a local Ollama default; see `.env.example`. `npm run check:tools` confirms the selected model
really makes tool calls, and `npm run check:ollama` checks a local Ollama.

## Sign-in and helper origins

There is **no authentication bootstrap**: no session injection, stored browser state or
pre-supplied credentials. Discovery signs up or signs in through the product's own UI, and the
Discovery Completion Gate holds it to resolving that flow. A browser the run starts is signed
out; an already-running MCP server keeps its sign-in, so use `npm run qa:manual -- --fresh-browser`
when a clean start matters.

When a flow needs test infrastructure on another origin — typically a mailbox such as MailHog
holding a confirmation mail — allow it explicitly:

```dotenv
QA_DISCOVERY_AUX_ORIGINS=http://localhost:8025
```

Only the host can grant an origin; the model is told what is listed and cannot add to it.
Helper origins are never described as product areas. Without the setting, discovery records the
flow BLOCKED and the suite covers only what it could reach. Details:
[RUNBOOK — Sign-in](docs/RUNBOOK.md#sign-in-and-helper-origins).

## Observability

Optional [Langfuse](https://langfuse.com) tracing, **off unless `LANGFUSE_ENABLED=true`**. One
trace per QA run, refresh, workspace review and bug decision, with stages, agent turns, tool
calls, token usage, context pressure and QA metrics. Works with Langfuse Cloud or a self-hosted
instance (`LANGFUSE_BASE_URL`). Prompts and tool I/O are sent only with
`LANGFUSE_CAPTURE_IO=true`, and are redacted even then. See
**[docs/observability.md](docs/observability.md)**.

## Artifacts

Everything lands in `QA_ARTIFACT_ROOT` (default `../qa-workspace/.qa`, which must be outside
this project).

| Kind | Files |
|---|---|
| **Canonical QA artifacts** — what approval locks | `discovered-behavior.json` · `requirements-analysis.json` · `test-cases.json` · `automation-prioritization.json` · `defect-analysis.json` · `bugs/BUG-NNN.json` |
| Approval | `phase1-approval.json` — written by host code only |
| Advisory | `test-cases-review.json` |
| Host-written discovery evidence | `discovery-surface.json` · `discovery-observations.json` · `discovery-evidence.json` |
| **Review workflow state** — never hashed or approved | `reviews/requests/REQ-NNNN.json` · `reviews/proposals/PRP-NNNN.json` · `reviews/bugs/BUG-NNN.json` |
| Freshness | `phase1-dependencies.json` · `phase1-refresh.json` |
| Phase 2 | `repo-analysis.json` · `automation-project-contract.json` |
| Run records | `phase1-run.json` · `phase2-run.json` · `runs/<id>/` · `archive/<timestamp>/` |

Canonical artifacts are plain files. Review workflow state goes through the `ReviewStore`
interface (`src/review/review-store.ts`), whose only implementation is file-backed.

## Trust boundaries

Enforced in code, not requested in prompts ([VALIDATION.md](docs/VALIDATION.md) has the details and
the tests behind them):

- **Narrow tools.** Agents get no shell, filesystem API or path argument; each has only the
  tools it needs, over roots outside this project (`src/tools/`, `src/lib/trusted-roots.ts`).
- **Own artifact only.** An agent that writes an artifact can name exactly one — its own.
- **Schema, then semantics.** Every write is validated against its JSON Schema and against
  host-loaded upstream evidence; evidence ids must resolve. A rejected write changes nothing.
- **Discovery must be finished.** Discovery cannot finalize while host-recorded browser
  evidence shows unverified actions, unexplored reachable areas or unsupported BLOCKED claims.
- **Review agents propose, the host applies.** The focused review agent can read its one
  request and submit a proposal — nothing else. Only a person's Apply changes the suite.
- **No stale overwrite.** A proposal carries the hash of the suite it was made from; apply
  re-validates it and refuses if the suite changed since.
- **Approval is hash-locked and human-only.** No agent can read or write the approval.
- **The UI names no paths or commands.** The workspace API accepts small, strictly-typed JSON
  with pattern-checked ids and refuses cross-origin writes.
- **Secrets stay out.** One-time values in URLs and known keys are redacted before anything is
  written or traced, and an artifact carrying a real credential value is rejected.

What validation does and does not guarantee: **[docs/VALIDATION.md](docs/VALIDATION.md)**.

## Project structure

```text
scripts/          host orchestration: qa-manual · qa-ui · qa-review · qa-refresh · qa-defects · qa-approve · qa-automation
  lib/            stage lists, retries, run lock, refresh, MCP lifecycle
src/
  agents/         Phase 1 stages · review agents · Repo Analyzer · QA Manager (experimental) · unwired Phase 2 agents
  tools/          narrow agent tools
  lib/            schema + semantic validation · discovery surface and completion gate · defects · Phase 1 gate · redaction
  review/         ReviewStore, change requests, proposals, host-side apply
  ui-server/      the workspace's host API
  config/         .env loading · helper origins
  connections/    Playwright MCP, with a per-role tool allowlist
  providers/      Ollama · OpenRouter
  observability/  optional Langfuse
  skills/         project and vendored QA skills
  diagnostics/    tool-calling probes used by check:* scripts
ui/               the workspace UI (React, TypeScript, Vite)
schemas/          JSON Schemas for every artifact and review record
test/             node:test suites
e2e/              Playwright tests of the workspace over fixture artifacts
docs/             runbook · validation · observability · architecture
```

## Testing / validation

```bash
npm test               # unit, integration and documentation checks
npm run test:ui-e2e    # the workspace in a real browser, over fixture artifacts
npm run typecheck:ui
npm run validate <name> <file>   # validate a JSON file as an artifact, without writing it
```

`test/docs.test.ts` keeps these docs honest: every `npm run` script named in the docs must exist,
local links must resolve, Mermaid sources must be well-formed, and the architecture diagrams
must name the stages the code actually runs.

## Known limitations

- **Discovery depth bounds everything.** A thin discovery run yields a small suite, honestly
  labelled as fully covered.
- **No authenticated start.** Discovery signs in through the UI; a product whose accounts
  cannot be created or confirmed that way (with helper origins) is explored signed out.
- **The review agent does not browse.** It answers from recorded evidence; a request the
  evidence cannot support comes back with unresolved issues and cannot be applied.
- **Refresh is manual.** After a test case changes, prioritization and defect analysis stay
  STALE until you refresh — deliberately, so several edits can share one model run.
- **Agent turns sometimes end without a tool call.** Stages retry (four attempts by default).
- **Validation proves support, not correctness** — see VALIDATION.md.
- **Phase 2 stops after Repo Analyzer.**
- **The workspace is single-user and local**: no login, bound to loopback by default; review
  state is file-backed.

Next directions (not built): wiring the remaining Phase 2 agents (UI Explorer, Automation
Generator) and adding test execution and failure analysis.

## Detailed documentation

| | |
|---|---|
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operating it: settings, commands, options, refresh, bugs, exit codes, troubleshooting |
| [docs/VALIDATION.md](docs/VALIDATION.md) | What the deterministic checks guarantee, and what they do not |
| [docs/observability.md](docs/observability.md) | Langfuse tracing: configuration, trace shape, metrics, content policy |
| [docs/architecture/README.md](docs/architecture/README.md) | Architecture diagrams (Mermaid sources, rendered on GitHub) |
| [docs/architecture/architecture-view.html](docs/architecture/architecture-view.html) | The same diagrams on one styled page, plus the agent capability matrix — open locally in a browser |
