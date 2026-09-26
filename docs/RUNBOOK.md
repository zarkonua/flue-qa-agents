# Operator runbook

How to run the system and what to do when it stops. Architecture lives in
[architecture/architecture-view.html](architecture/architecture-view.html); what validation
guarantees is in [VALIDATION.md](VALIDATION.md).

## Prerequisites

- Node ≥ 22.19, `npm install` done.
- **Ollama** reachable with `qwen3:14b` pulled — `npm run check:ollama`.
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

The browser starts signed out unless `QA_AUTH_MODE` says otherwise: `credentials` makes an
existing test account available without showing its values to the model, and `storage_state`
starts every browser context from a Playwright storage-state file. Use `storage_state` when
authentication is not what is being tested, and for model comparisons — see
[auth-bootstrap.md](auth-bootstrap.md).

### Choosing the model

One setting, in Flue's `provider/model` form. Every agent uses it; there is no per-agent
override.

```dotenv
QA_MODEL=ollama/qwen3:14b                              # default when unset
```

```dotenv
QA_MODEL=openrouter/deepseek/deepseek-v4-flash-0731
OPENROUTER_API_KEY=sk-or-...
```

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
| `PLAYWRIGHT_MCP_URL` | unset → `http://localhost:8931/mcp` | `default` expands to the same. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434/v1` | *(Ollama only)*  `npm run check:ollama` prints the right value if the default does not reach it. |
| `OLLAMA_CONTEXT_WINDOW` | `8192` | Declared to Flue. Must not exceed the server's `num_ctx`. |
| `OLLAMA_MAX_OUTPUT_TOKENS` | `2048` | Per-turn output cap. |
| `OLLAMA_REPLAY_REASONING` | unset (filter on) | Set `true` only to debug; historical reasoning then overruns the context. |
| `QA_TEST_WRITE_ROOTS` | `tests,e2e,pages,fixtures,helpers` | Repo-relative dirs where test code may be written (Phase 2, unwired). |
| `QA_TEST_RESULTS_ROOTS` | `test-results,playwright-report,blob-report` | Read-only result dirs. |
| `QA_TYPECHECK_SCRIPT` | `npx tsc --noEmit` | Host-built argv; no model input. |
| `QA_TEST_RUN_TIMEOUT_MS` | `600000` | Hard kill for a test or typecheck run. |

## The flow

```bash
export TARGET_URL="http://localhost:4444/"
npm run qa:manual                      # Phase 1: 5 stages, then STOP  (~5–15 min)
#   Discovery → Analysis → Test Design → Automation Prioritization → Defect Analysis

npm run qa:ui                          # review in a browser at http://127.0.0.1:4445
npm run qa:review                      # AI review; proposes only, edits nothing; summarises defects
npm run qa:defects                     # list bug reports; decide on each (see below)
# hand-edit test-cases.json if you want
npm run qa:prioritize                  # re-run from stage 4 after edits (defect analysis re-runs too)
npm run qa:approve                     # required before Phase 2

export QA_TARGET_REPO_ROOT="/path/to/your/e2e-repo"
npm run qa:automation                  # Phase 2: gate, Repo Analyzer, then STOP
```

`npm run qa` is an alias of `qa:manual`.

### Options

```bash
npm run qa:manual -- --from prioritization   # discovery | analysis | design | prioritization | defects
npm run qa:manual -- --from defects          # re-run defect analysis only
npm run qa:manual -- --attempts 2
npm run qa:approve -- --accept-findings      # approve despite semantic findings; recorded
npm run qa:automation -- --gate-only         # check prerequisites, start no agent
npm run qa:automation -- --from repo-analyzer
```

A stage that fails all its attempts stops the run, keeps what succeeded, and prints the
`--from` command to resume. Retries alternate: even attempts continue the same conversation
with a correction naming what went wrong, odd attempts start fresh.

### Reviewing in a browser

`npm run qa:ui` serves a read-and-approve screen at `http://127.0.0.1:4445` (`QA_UI_PORT` to
change the port; it binds to loopback only and has no login). It merges the Phase 1 artifacts
into one page — test cases with their execution mode, automation priority, covered
requirements, steps and evidence, plus coverage, any blocking findings and the optional AI
review — so a normal review no longer means reading `test-cases.json` beside
`automation-prioritization.json`.

Approving there calls the same `approvePhase1()` as `npm run qa:approve`; the resulting
approval is the same artifact and the Phase 2 gate treats it identically. The
`--accept-findings` override is deliberately **not** available in the browser — overriding a
semantic finding stays a terminal action.

### Approval

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

`qa:approve` records the SHA-256 of all five Phase 1 artifacts and of every bug report. Change any of them — by hand
or by re-running a stage — and the approval goes stale and Phase 2 refuses, naming the file.
Regenerating a stage archives the old review and approval automatically. Structural problems
can never be approved; see [VALIDATION.md](VALIDATION.md).

## Outputs

Everything lands in `QA_ARTIFACT_ROOT` (default `~/projects/qa-workspace/.qa/`):

| File | Written by |
|---|---|
| `discovered-behavior.json` · `requirements-analysis.json` · `test-cases.json` · `automation-prioritization.json` | Phase 1 stages 1–4 |
| `defect-analysis.json` · `bugs/BUG-NNN.json` | Phase 1 stage 5 (Defect Analyzer); reports edited only by `qa:defects` |
| `test-cases-review.json` | `qa:review` (advisory) |
| `phase1-approval.json` | `qa:approve` — host code only |
| `repo-analysis.json` | Phase 2 stage 1 |
| `phase1-run.json` · `phase2-run.json` | run logs: stages, attempts, timings |
| `archive/<timestamp>/` | whatever a re-run replaced — nothing is deleted |

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
npm test                   # 118 tests
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
