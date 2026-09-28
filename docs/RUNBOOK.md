# Operator runbook

How to run the system and what to do when it stops. The overview is the
[README](../README.md), diagrams are in [architecture/](architecture/README.md) (one-page view:
[architecture-view.html](architecture/architecture-view.html)), and what
validation guarantees is in [VALIDATION.md](VALIDATION.md).

## Prerequisites

- Node ≥ 22.19, `npm install` done.
- A model: a local **Ollama** with the model named in `QA_MODEL` pulled
  (`npm run check:ollama`), or an OpenRouter key.
- **Chromium for Playwright** for Phase 1 — `npm run check:playwright`.
- The application under test running, for Phase 1.
- A target automation repository, for Phase 2.

## Configuration

```bash
cp .env.example .env     # edit once, instead of exporting variables every run
```

`.env` is optional and git-ignored. Precedence is **shell > `.env` > code default**, so
`TARGET_URL=http://other npm run qa:manual` still overrides the file and CI can keep passing
variables directly.

Only `TARGET_URL` is required; Phase 2 also needs `QA_TARGET_REPO_ROOT` to point somewhere
real. Every root must be **absolute** and **outside this project** — both are checked at load
time, and the process throws rather than relocating anything.

Tracing to Langfuse is optional and off unless `LANGFUSE_ENABLED=true` — see
[observability.md](observability.md).

### Choosing the model

One setting, in Flue's `provider/model` form. Every agent uses it; there is no per-agent
override.

```dotenv
QA_MODEL=ollama/<model>                # any model your Ollama server has pulled
```

```dotenv
QA_MODEL=openrouter/<vendor>/<model>   # any OpenRouter model id
OPENROUTER_API_KEY=sk-or-...
```

Any provider other than `ollama` or `openrouter` is refused at startup. Choose a model that
reliably makes structured tool calls; `.env.example` has working examples.

Both run the same `npm run qa:manual` / `npm run qa:automation`. Selecting `openrouter/...`
without a key fails immediately, before any agent starts. The key is read host-side only: it
never reaches an agent prompt, a tool, the browser, or an artifact.

To check a model really does structured tool calls before a full run:

```bash
npm run check:tools        # uses QA_MODEL, whichever provider that selects
```

| Variable | Default | What it does |
|---|---|---|
| `TARGET_URL` | — | The application Phase 1 explores. Required. |
| `QA_MODEL` | `ollama/qwen3:14b` | `<provider>/<model>`; `ollama` or `openrouter`. |
| `OPENROUTER_API_KEY` | — | Required only when `QA_MODEL` is `openrouter/*`. |
| `QA_TARGET_REPO_ROOT` | `../qa-workspace/target-repo` | The automation repo Phase 2 reads. |
| `QA_ARTIFACT_ROOT` | `../qa-workspace/.qa` | Artifacts, the approval, run logs. |
| `QA_MCP_OUTPUT_ROOT` | `../qa-workspace/.mcp-output` | Playwright MCP working directory. A security boundary: browser tools write a model-chosen filename relative to it. |
| `QA_STAGE_ATTEMPTS` | `4` | Attempts per stage; `--attempts n` overrides per run. |
| `QA_DISCOVERY_AUX_ORIGINS` | unset | Comma-separated helper origins discovery may use (a test mailbox). See [Sign-in](#sign-in-and-helper-origins). |
| `QA_FRESH_BROWSER` | unset | `true` = `--fresh-browser`: restart the MCP server so the run owns a signed-out browser. |
| `QA_UI_PORT` · `QA_UI_HOST` | `4445` · `127.0.0.1` | Where `qa:ui` listens. The workspace has no login; keep it on loopback. |
| `QA_UI_MODELS` | unset | Further models **New Run** may offer besides `QA_MODEL` (comma-separated `<provider>/<model>`). |
| `QA_UI_TARGETS` | unset | Further targets **New Run** may offer besides `TARGET_URL` (comma-separated URLs). |
| `QA_ENV_FILE` | `./.env` | Load settings from another file. |
| `LANGFUSE_*` | off | See [observability.md](observability.md). |
| `PLAYWRIGHT_MCP_URL` | unset → `http://localhost:8931/mcp` | `default` expands to the same. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434/v1` | *(Ollama only)*  `npm run check:ollama` prints the right value if the default does not reach it. |
| `OLLAMA_CONTEXT_WINDOW` | `8192` | Declared to Flue. Must not exceed the server's `num_ctx`. |
| `OLLAMA_MAX_OUTPUT_TOKENS` | `2048` | Per-turn output cap. |
| `OLLAMA_REPLAY_REASONING` | unset (filter on) | Set `true` only to debug; historical reasoning then overruns the context. |
| `QA_TEST_WRITE_ROOTS` | `tests,e2e,pages,fixtures,helpers` | Repo-relative dirs where test code may be written (Phase 2, unwired). |
| `QA_TEST_RESULTS_ROOTS` | `test-results,playwright-report,blob-report` | Read-only result dirs. |
| `QA_TYPECHECK_SCRIPT` | `npx tsc --noEmit` | Host-built argv; no model input. |
| `QA_TEST_RUN_TIMEOUT_MS` | `600000` | Hard kill for a test or typecheck run. |

## Sign-in and helper origins

There is no authentication bootstrap: nothing injects a session, a stored browser state or
credentials. Discovery signs up and signs in through the product's own UI, and the completion
gate will not let it finish while a sign-in flow it saw is unresolved (see
[VALIDATION.md](VALIDATION.md#discovery-finalizing-is-gated)).

- A browser the run starts is signed out. A Playwright MCP server that is already running is
  reused and keeps its cookies and sign-in; pass `--fresh-browser` (or `QA_FRESH_BROWSER=true`)
  when a clean start matters, e.g. when comparing two models.
- If the application confirms accounts by mail, allow the mailbox:
  `QA_DISCOVERY_AUX_ORIGINS=http://localhost:8025` (MailHog). Only host configuration can grant
  an origin; the model is told what is listed and cannot add to it, and an artifact that
  describes a helper origin as part of the product is rejected. Without it, discovery records
  the flow BLOCKED and the suite covers only the signed-out pages. When discovery is blocked by
  an unlisted origin, the run prints a hint naming it.
- Use test accounts only. Artifacts may not carry an email address or a real credential value
  (`FABRICATED_CREDENTIAL`), and one-time values in URLs are redacted before anything is written
  or traced.

## The flow

```bash
npm run qa:manual                      # Phase 1: 5 stages, then STOP
#   discovery → analysis → design → prioritization → defects

npm run qa:ui                          # workspace: change test cases, decide on bugs, refresh, approve
npm run qa:review                      # optional: advisory AI review of the suite; edits nothing
npm run qa:refresh                     # after test cases changed: prioritization + defect analysis
npm run qa:approve                     # required before Phase 2 (same as the workspace button)

npm run qa:automation                  # Phase 2: gate, Repo Analyzer, then STOP (needs QA_TARGET_REPO_ROOT)
```

`npm run qa` is an alias of `qa:manual`. `npm run qa:prioritize` is shorthand for
`qa:manual -- --from prioritization`, which re-runs stages 4 and 5 — the right step after editing
`test-cases.json` by hand instead of through the workspace.

### Options

```bash
npm run qa:manual -- --from prioritization   # discovery | analysis | design | prioritization | defects
npm run qa:manual -- --from defects          # re-run defect analysis only
npm run qa:refresh                           # prioritization + defect analysis after a suite change (all or nothing)
npm run qa:manual -- --attempts 2
npm run qa:manual -- --fresh-browser         # restart the MCP server: a signed-out browser this run owns
npm run qa:approve -- --accept-findings      # approve despite semantic findings; recorded
npm run qa:automation -- --gate-only         # check prerequisites, start no agent
npm run qa:automation -- --from repo-analyzer
```

A stage that fails all its attempts stops the run, keeps what succeeded, and prints the
`--from` command to resume. Retries alternate: even attempts continue the same conversation
with a correction naming what went wrong, odd attempts start fresh.

### The QA Review Workspace

`npm run qa:ui` builds the workspace UI when its sources changed (`ui/`, React + TypeScript +
Vite, output in the git-ignored `ui/dist/`) and serves it with the host API at
`http://127.0.0.1:4445` (`QA_UI_PORT`; loopback only, no login). `npm run qa:ui:dev` serves the
API the same way and runs Vite with hot reload on port 5173.

| Page | For |
|---|---|
| Overview | counts, requirement coverage (which cases cover each requirement), each derived artifact CURRENT or STALE with the reason, **Refresh dependent analysis**, Phase 1 approval |
| Test Cases | search/filter; open a case to **Edit**, **Request Change**, **Delete**, or **+ Add Test Case** |
| Reviews | every change request by state; a proposal's diff, validation, impact and the actions |
| Bugs | bug reports: Accept, Reject, Downgrade, Request Changes, Edit — the same decisions as `npm run qa:defects` |

**Changing a test case.** Nothing you do in the workspace changes `test-cases.json` until you
apply a proposal:

1. *Edit* (form over the case's own fields; the id is fixed), *Request Change* (free text) or
   *+ Add Test Case* (one sentence) creates a **change request** and hands it to the focused QA
   agent (`src/agents/test-case-change-reviewer.ts`). It can read only its request's context
   and submit a proposal — no artifact write tool is mounted. *Delete* needs no model: the host
   proposes the deletion itself.
2. The **proposal** holds the complete resulting case(s). The host validates it every time it is
   shown: schema, the same semantic checks as the Test Designer's write, the base-suite hash,
   possible duplicates, and coverage impact. Anything the evidence could not settle is an
   **unresolved issue**, and Apply stays disabled.
3. **Apply Change / Apply Deletion** rebuilds the suite from the file on disk, validates it again
   and replaces `test-cases.json` atomically. **Reject** (*Keep Test Case* for a deletion) closes
   the request; **Request Changes** sends it back to the agent with your note.
4. A proposal made from an older suite is refused with a conflict — re-process the request.
   Coverage getting worse is shown as impact, not refused; `qa:approve` lists it as a finding.

**What goes stale.** Each derived artifact records the hashes of the inputs it was generated from
(`phase1-dependencies.json`), so the Overview can say exactly what changed:

| Change | Prioritization | Defect analysis | Phase 1 approval |
|---|---|---|---|
| a test case applied (edit, add, delete) | STALE | STALE | STALE |
| a bug decision or bug edit | current | current | STALE |

**Refresh dependent analysis** (Overview, or `npm run qa:refresh`) re-runs Automation
Prioritizer, then Defect Analyzer — nothing upstream, and no browser. It asks first, and says what
it does to bug reviews. It is all or nothing: the previous artifacts are snapshotted and restored
if either stage fails, so they stay STALE rather than half-replaced; the run lock stops it from
overlapping a QA run. It never restores the approval — approve again afterwards. It is never
started automatically, so several edits can share one refresh.

**Bug decisions across a refresh.** The regenerated reports are reconciled with the reviewed
ones by the host, deterministically: a report with the same area, evidence and original status,
whose expected and actual say the same thing, keeps the decision, note, downgrade and any
edited fields (re-validated). A changed finding — a REJECTED one included — goes back to PENDING;
a new one starts PENDING; one no longer produced leaves the active set. The Overview lists what
was preserved, reset, new and removed; the previous reports and histories are archived under
`archive/<stamp>-refresh/`.

Requests and proposals are workflow state, stored as `reviews/requests/REQ-NNNN.json` and
`reviews/proposals/PRP-NNNN.json` under the artifact root through the `ReviewStore` interface.
They survive a restart; a request left *Processing* by a stopped server comes back as *Failed*
and can be processed again. Processing takes the run lock, so it never overlaps a QA run.

Approving in the workspace calls the same `approvePhase1()` as `npm run qa:approve`. The
`--accept-findings` override is deliberately **not** available in the browser — overriding a
semantic finding stays a terminal action.

### Defects

The Defect Analyzer reads the evidence earlier stages recorded — it has no browser — and
classifies each candidate:

| Classification | Needs | Bug report |
|---|---|---|
| `CONFIRMED_DEFECT` | an OBSERVED actual, and an expectation from a requirement resting on a CONFIRMED behavior or on an OBSERVED behavior other than the actual | `status: CONFIRMED` |
| `POTENTIAL_DEFECT` | an OBSERVED actual; the expectation may be inferred | `status: POTENTIAL` |
| `NOT_A_DEFECT` | observed behavior consistent with what is supported | none |
| `INSUFFICIENT_EVIDENCE` | expected versus actual cannot be established | none |

The host writes `defect-analysis.json` and one `bugs/BUG-NNN.json` per defect. It assigns the
ids, the summary, the expected basis, the evidence list and the environment; priority is
`UNASSIGNED` until you set it. Decide on each report before approving:

```bash
npm run qa:defects                                    # list: status, severity, priority, decision
npm run qa:defects -- show BUG-001
npm run qa:defects -- accept BUG-001 --note "Reproduced."
npm run qa:defects -- reject BUG-002 --note "By design."
npm run qa:defects -- downgrade BUG-003               # CONFIRMED -> POTENTIAL
npm run qa:defects -- request-changes BUG-003 --note "Add the reload timing."
npm run qa:defects -- edit BUG-001 --title "…" --severity MAJOR --priority P1 --step "…" --step "…"
```

Every change is re-validated against the evidence (an edit that invents a route, message or
credential is refused and nothing is written), and makes an existing approval stale.
Undecided reports do not block approval; the approval records each one's status and decision.

### Approval

`qa:approve` records the SHA-256 of all five Phase 1 artifacts and of every bug report. Change any of them — by hand
or by re-running a stage — and the approval goes stale and Phase 2 refuses, naming the file.
Regenerating a stage archives the old review and approval automatically. Structural problems
can never be approved; see [VALIDATION.md](VALIDATION.md).

## Outputs

Everything lands in `QA_ARTIFACT_ROOT` (default `../qa-workspace/.qa`, outside this project):

| File | Written by |
|---|---|
| `discovered-behavior.json` · `requirements-analysis.json` · `test-cases.json` · `automation-prioritization.json` | Phase 1 stages 1–4 |
| `defect-analysis.json` · `bugs/BUG-NNN.json` | Phase 1 stage 5 (Defect Analyzer); reports changed only by a person's decisions (workspace or `qa:defects`) |
| `phase1-dependencies.json` · `phase1-refresh.json` | host: what prioritization and defect analysis were generated from; the last refresh |
| `reviews/bugs/BUG-NNN.json` | the review history of each bug report (workflow state) |
| `test-cases-review.json` | `qa:review` (advisory) |
| `reviews/requests/REQ-NNNN.json` · `reviews/proposals/PRP-NNNN.json` | the review workspace (workflow state; never approved or hashed) |
| `phase1-approval.json` | `qa:approve` — host code only |
| `discovery-surface.json` · `discovery-observations.json` | host, during discovery: the surface to account for, the completion-gate verdicts, the observation ledger |
| `discovery-evidence.json` | host, after discovery: console and network facts per explored page |
| `repo-analysis.json` | Phase 2 stage 1 |
| `automation-project-contract.json` | host, derived from `repo-analysis.json` |
| `phase1-run.json` · `phase2-run.json` | run logs: stages, attempts, timings |
| `archive/<timestamp>/` | whatever a re-run replaced — nothing is deleted |
| `runs/<run-id>/` | every run's own output and `run-metadata.json`, completed or failed — immutable |
| `history.sqlite` (+ `-wal`, `-shm`) | the run history index; see [Run history](#run-history) |

## Run control (starting runs from the workspace)

```text
npm run qa:ui  →  New Run  →  Start Phase 1  →  Live Run  (→ Cancel Run)
```

- **What can be chosen** comes from the host: `GET /api/run-config` lists the targets
  (`TARGET_URL`, `QA_UI_TARGETS`), the models (`QA_MODEL`, `QA_UI_MODELS`; an `openrouter/*` model
  is offered only when `OPENROUTER_API_KEY` is set — its value is never shown), the fresh-browser
  default (`QA_FRESH_BROWSER`), and the helper origins and Langfuse state, read-only. There is no authentication choice: there is no auth bootstrap on main, so
  discovery signs up or signs in through the product itself.
- **Starting.** `POST /api/runs` → the RunController validates the choices, refuses if the run lock
  is held (by the workspace or a terminal run), and forks `scripts/qa-manual.mjs --run-id <id>
  [--fresh-browser]` with only `TARGET_URL`, `QA_MODEL` and `QA_FRESH_BROWSER` set from the chosen
  values. It is the same runner as `npm run qa:manual`: same lock, stages, history, archive, traces.
- **Following.** The runner appends every event to `runs/<run-id>/events.jsonl` (redacted, at most
  5000 per run — past that only stages, artifacts, metrics and the end are kept). The Live Run page
  reads it over SSE (`GET /api/runs/<id>/events`), replaying at most 500 events on (re)connect and
  resuming after `Last-Event-ID`. Terminal runs write the same log and can be watched too.
- **Cancelling.** Only a run this workspace started. The controller asks the runner over IPC; the
  runner stops its agent, archives what it has, stops its browser, records CANCELLED and exits 130.
  After 30 s without exit: TERM to its process group; 10 s later: KILL. Then the controller stops a
  browser server the run reported owning, removes a lock left by it, and closes its history row and
  event log if the run could not. A terminal run is stopped in its terminal (Ctrl-C = INTERRUPTED).
- **During a run** the workspace refuses to apply proposals, record bug decisions or approve Phase 1
  (409): those artifacts are being regenerated.
- **Restarting the workspace** does not stop a run it started — the runner is its own process and
  writes to the same terminal. The new workspace can watch it but not cancel it (it did not start
  it); stop it with `kill -INT <pid>` from the run lock, which records INTERRUPTED.

## Run history

Every QA command records its run in `history.sqlite` under the artifact root. The path is fixed —
derived from `QA_ARTIFACT_ROOT`, never configurable from a request. Nothing to do in normal use:
`npm run qa:manual` records, `npm run qa:ui` shows it under **Runs**.

| Command | Run kind | Archived to `runs/<run-id>/` |
|---|---|---|
| `qa:manual` (terminal or New Run) | `PHASE1_MANUAL` | the Phase 1 artifacts, bug reports, discovery records, `phase1-run.json` and `events.jsonl` — also when a stage fails or the run is cancelled |
| `qa:refresh` / workspace refresh | `DEPENDENCY_REFRESH` | test cases, prioritization, defect analysis, bug reports — when it completes (a failed refresh restores the old files, so it has no archive) |
| `qa:review` | `PHASE1_REVIEW` | `test-cases-review.json` |
| `qa:automation` | `PHASE2_AUTOMATION` | `repo-analysis.json`, `automation-project-contract.json`, `phase2-run.json` |

**Lifecycle.** A Phase 1 run is inserted as STARTING when it takes the run lock and becomes
RUNNING when its first stage begins; each stage is recorded as it starts and ends with its attempts,
and the run's counts are recorded as stages produce artifacts. It is closed COMPLETED, FAILED or
CANCELLED (a person's cancel from the workspace — never recorded as a failure) with its archive's
metrics and artifact index in one transaction. Ctrl-C in a terminal closes it INTERRUPTED. A run
whose process was killed stays RUNNING until the history is next opened — by the next run, the
workspace, or `qa:history:import` — which marks it INTERRUPTED once its process is gone (and, for
a run that took the run lock, once the lock no longer names it).

**When the history fails**, QA does not:

| Problem | What happens |
|---|---|
| The database cannot be opened or migrated | `WARNING … run history is unavailable` at the start; the run continues and is archived; the Runs page answers with the reason |
| A stage update cannot be written | `WARNING`; the run continues |
| The final index cannot be written | the archive is kept; the run is closed with `HISTORY_INDEX_FAILED`; `qa:history:import` rebuilds it |

```bash
npm run qa:history:import   # import archives made before the history existed; idempotent, read-only on archives
npm run qa:history:verify   # compare the index with the archives: missing, changed or unindexed files, stale RUNNING rows
```

Metrics are derived from the archive, and only when the archive supports them: a missing metric is
shown as `—`, never as 0. Tool errors, parse errors and context usage are not recorded host-side —
they are in Langfuse, whose trace id the run keeps when tracing is on.

SQLite settings: WAL (the workspace reads while a run writes), foreign keys on, a 5 s busy timeout,
`synchronous=NORMAL` (survives a crashed process; a power loss may drop the last commit, which
`qa:history:import` restores from the archive). The schema version is SQLite's `user_version`; a
database newer than the code is refused rather than guessed at.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | a stage failed after all attempts |
| 2 | bad configuration (`TARGET_URL`, unknown `--from`, missing repo, unconfined MCP server) |
| 3 | target unreachable |
| 4 | a gate refused (approval or Phase 2 entry) |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `TARGET_URL is not set` | Export it. Phase 1 will not guess. |
| `must be an absolute path for this platform` | A quoted `~`, or a leftover Windows `C:\…`. Use `$HOME/...`. |
| `… is inside the control plane` | A root points inside this project. Move it to a sibling directory. |
| `No target repository at …` (exit 2) | Phase 2 only. Set `QA_TARGET_REPO_ROOT` to a real repo. |
| `Phase 1 is not approved` (exit 4) | Run `npm run qa:approve`. |
| `Phase 1 approval is stale` (exit 4) | An approved artifact changed. Review and approve again. |
| `no test case is marked AUTOMATION` (exit 4) | Nothing for Phase 2 to do — the manual suite is the deliverable. |
| `Refusing to use the running Playwright MCP server` | Something started it from inside this project, so browser writes could land here. Kill it; the command starts a confined one. |
| `<artifact>.json was not written by this attempt` | The model reasoned and stopped without calling its tool. Expected in ~18% of attempts; retries recover it. Persistent failure usually means the artifact it must emit is too large or too nested for the model. |
| `is schema-valid but not supported by upstream evidence` | Working as intended — the agent gets the list and retries. Repeated failure means the upstream artifact is thin. |
| `UNCOVERED_ACCEPTANCE_POINT` in a rejected write | A requirement has no test case. Normally the agent adds one and retries. If it persists, the requirement may not be testable as written — that is the Behavior Analyst's `testable: false` to set, with a reason. |
| Artifact mentions a feature the app does not have | Validation catches most of this. If it persists, check the skills that agent mounts for a worked example it may be copying. |

## Diagnostics

```bash
npm run check:ollama       # model reachable, context, live tool-call probe
npm run check:playwright   # Chromium, deps, MCP server, tool allowlist
npm run check:tools        # regression: the model really calls a local tool
npm run check:mcp-tools    # regression: the model really calls a browser tool
npm run probe:browser      # model-free: Flue → MCP → Chromium → page → validated artifact
npm test                   # all unit, integration and documentation checks
npm run test:ui-e2e        # the workspace in a real browser over fixture artifacts
npm run docs:architecture  # regenerate docs/architecture/README.md from its .mmd sources
npm run qa:history:verify  # run history index vs. the archives on disk
npm run validate <name> <file>    # validate a JSON file as an artifact, without writing
npm run mcp:playwright[:headed]   # run the confined MCP server yourself
npm run qa:agentic                # experimental model-driven path; no approval gate
npx flue run src/agents/<agent>.ts --new --id x -m "..."   # one agent standalone
```

## Do not change these

Each was established by measurement:

- `@earendil-works/pi-ai` pinned to `^0.83.0` — it must match `@flue/runtime`'s own range, or
  two copies get installed and Flue sends requests with no system prompt and no tools.
- The reasoning-replay filter in `src/providers/ollama.ts` (leave `OLLAMA_REPLAY_REASONING`
  unset).
- `OLLAMA_CONTEXT_WINDOW` must not exceed the Ollama server's `num_ctx`, or the server
  silently truncates the prompt — tool definitions first.
