# Operator runbook — running the QA workflow

Verified against the repository on 2026-09-22 (two-phase workflow): `package.json`, `scripts/qa-manual.mjs`, `scripts/lib/runtime.mjs`, `src/lib/phase1-gate.ts`,
`src/lib/target.ts`, `src/lib/qa-artifacts.ts`, `src/lib/trusted-roots.ts`,
`src/connections/playwright-mcp.ts`, `src/providers/ollama.ts`, and the agent entrypoints.

Environment: Linux (developed on WSL2 Ubuntu 24.04), project `~/projects/flue-qa-agents`,
Node >= 22.19, and an Ollama endpoint at `OLLAMA_BASE_URL` — local or on another machine.

---

## 1. The operator flow

```text
PHASE 1 — Manual QA Design        npm run qa:manual
        ↓                         inspect · edit · npm run qa:review · npm run qa:prioritize
   HUMAN APPROVAL GATE            npm run qa:approve
        ↓
PHASE 2 — Automation Engineering  npm run qa:automation     (gate only, for now)
```

From a fresh terminal:

```bash
cd ~/projects/flue-qa-agents
export TARGET_URL="http://localhost:4444/"

# Phase 1 — runs 4 agents in fixed order, then STOPS. ~10–25 min.
npm run qa:manual

# Inspect
jq . ~/projects/qa-workspace/.qa/test-cases.json
jq . ~/projects/qa-workspace/.qa/automation-prioritization.json

# Optional AI review — proposes changes, edits nothing
npm run qa:review
jq . ~/projects/qa-workspace/.qa/test-cases-review.json

# Edited test-cases.json by hand? Re-prioritize just that stage:
npm run qa:prioritize

# Your approval — required before Phase 2
npm run qa:approve

# Phase 2 entry gate
npm run qa:automation
```

`npm run qa` is an alias of `qa:manual`. **Only `TARGET_URL` is required**, and only for
stages that browse. Everything else has a working default.

> **Do not quote the tilde** in path variables: `export QA_ARTIFACT_ROOT="~/…"` leaves `~`
> literal, which is not absolute, and the run aborts. Leave it unquoted or use `$HOME/…`.

### Variable reference

| Variable | Status | Default | Notes |
|---|---|---|---|
| `TARGET_URL` | **Required** for discovery | — | `http:`/`https:`. Exit 2 on a bad value. |
| `QA_ARTIFACT_ROOT` | Optional | `<project>/../qa-workspace/.qa` | Absolute, outside this project; created if missing. |
| `QA_MCP_OUTPUT_ROOT` | Optional | `<project>/../qa-workspace/.mcp-output` | Playwright MCP working directory — a **security boundary**, must be outside this project. |
| `QA_STAGE_ATTEMPTS` | Optional | `2` | Attempts per Phase 1 stage before stopping (or `--attempts n`). |
| `PLAYWRIGHT_MCP_URL` | Optional | `http://localhost:8931/mcp` | Set for you. `default` also resolves to this. |
| `OLLAMA_BASE_URL` | Optional | `http://127.0.0.1:11434/v1` | Correct under WSL mirrored networking. |
| `OLLAMA_CONTEXT_WINDOW` | Optional | `8192` | Verified sufficient — leave it. |
| `OLLAMA_REPLAY_REASONING` | Optional | unset (= strip) | Diagnostic opt-out only; `true` breaks runs. |
| `QA_TARGET_REPO_ROOT` | Optional | `<project>/../qa-workspace/target-repo` | Phase 2 only. Validated at load even when unused. |
| `QA_TEST_WRITE_ROOTS`, `QA_TEST_RESULTS_ROOTS`, `QA_TYPECHECK_SCRIPT`, `QA_TEST_RUN_TIMEOUT_MS` | Optional | see `src/lib/trusted-roots.ts` | Phase 2 only. |

### One-time prerequisites

```bash
npm run check:ollama       # model reachable, context, live tool-call probe
npm run check:playwright   # Chromium, deps, CLI, skill, MCP server, allowlist
npm test                   # 60 semantic-validation and gate tests, ~1s
```

---

## 2. Phase 1 — `npm run qa:manual`

```text
1. validate TARGET_URL                          exit 2 on failure
2. archive previous artifacts, review, approval .qa/archive/<timestamp>/  (never deleted)
3. ensure a CONFINED Playwright MCP server      reuses one only if its cwd is outside the project
4. preflight the target                         TCP check (3s), then a browser navigate; exit 3
5. Product Discovery      -> discovered-behavior.json         (then stop MCP if we started it)
6. Behavior Analyst       -> requirements-analysis.json
7. Test Designer          -> test-cases.json
8. Automation Prioritizer -> automation-prioritization.json
9. STOP — print counts and next steps
```

Each stage runs as **its own root agent** with only its own tools. The sequence is fixed in
`scripts/qa-manual.mjs` — no model decides whether the next stage runs. After each stage host
code checks the artifact was **written during that attempt** and **re-validates it from disk**
(schema + semantic). A failed stage is retried (`QA_STAGE_ATTEMPTS`, default 2); then the run
stops, keeps what succeeded, and prints the resume command:

```bash
npm run qa:manual -- --from analysis        # discovery | analysis | design | prioritization
```

Every run writes `.qa/phase1-run.json`: stages, attempts, timings, agent exit codes, and
whether any Phase 2 artifact appeared (it must not).

`qa:manual` **cannot** start UI Explorer, Automation Generator, Repo Analyzer, a test runner,
or any other Phase 2 agent: its stages are a closed allowlist of four modules, checked at
startup, and none of those four agents can delegate.

### Output

```text
~/projects/qa-workspace/.qa/
├── discovered-behavior.json          Product Discovery
├── requirements-analysis.json        Behavior Analyst
├── test-cases.json                   Test Designer         — the complete manual suite
├── automation-prioritization.json    Automation Prioritizer — one entry per test case
├── phase1-run.json                   host run log (not an agent artifact)
└── archive/<timestamp>/              previous runs
```

**Two different priorities.** `test-cases.json` has P0–P3 (business risk).
`automation-prioritization.json` has `executionMode` AUTOMATION/MANUAL and
`automationPriority` HIGH/MEDIUM/LOW/NONE (value of automating). They are independent.
MANUAL cases are never removed — they stay in the suite permanently.

---

## 3. Review, edit, approve

### Optional AI review — `npm run qa:review`

Runs the Test Case Reviewer over all four artifacts and writes `test-cases-review.json`:
`status` (APPROVED / CHANGES_REQUESTED), `issues`, `suggestedChanges`, `summary`. It
**proposes**; it cannot modify `test-cases.json` (its write tool forbids it), and the command
hashes the inputs before and after to prove it. **An AI review is not approval.**

### Editing by hand

Edit `test-cases.json` directly. If you add, remove, or rename test cases, re-run the
Prioritizer so every case has exactly one entry:

```bash
npm run qa:prioritize            # = qa:manual --from prioritization; keeps your test cases
```

### Approval — `npm run qa:approve`

Trusted host code, not a model. Writes `.qa/phase1-approval.json` with who, when, the counts,
the review status, and the **SHA-256 of all four Phase 1 artifacts**.

| Situation | Result |
|---|---|
| An artifact missing | refused — run `qa:manual` |
| Schema error, missing/duplicate prioritization, duplicate IDs, MANUAL/HIGH | refused — **cannot be overridden** |
| Semantic findings (e.g. a route you added that discovery never saw) | refused by default; `npm run qa:approve -- --accept-findings` approves and **records** them |

Any later change to an approved artifact — even whitespace — makes the approval **stale**.
Re-running any Phase 1 stage archives the approval.

---

## 4. Phase 2 gate — `npm run qa:automation`

Refuses (exit 4) unless: test cases and prioritization exist and are valid; an approval exists
with status APPROVED; every recorded hash still matches; and at least one case is AUTOMATION.

```text
Phase 1 is not approved.
Review/edit the test cases and run:
npm run qa:approve
```
```text
Phase 1 approval is stale because the approved artifacts changed.
Changed since approval: test-cases.json
Review and approve again.
```

When open, it lists the selected AUTOMATION cases (HIGH first) and stops: **the Phase 2
pipeline is not implemented yet.**

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | a stage failed after all attempts, or a tool failed |
| 2 | bad configuration (TARGET_URL, `--from`, an unconfined MCP server) |
| 3 | target unreachable |
| 4 | a gate refused (approval or Phase 2 entry) |

### Experimental and debugging paths

```bash
npm run qa:agentic                  # old model-driven orchestration via QA Manager
npm run mcp:playwright[:headed]     # run the confined MCP server yourself
npx flue run src/agents/<agent>.ts --new --id x -m "..."   # one agent standalone
npm run check:tools                 # regression: model calls a local tool
npm run check:mcp-tools             # regression: model calls a browser tool
QA_ARTIFACT_ROOT=/tmp/probe npm run probe:browser   # model-free browser path
```

`probe:browser` overwrites `discovered-behavior.json` in its artifact root — point it
elsewhere, as above, to keep real results.

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `TARGET_URL is not set` | Export it. Exit code 2. |
| `TARGET_URL is not a valid URL` | Include the scheme: `https://…`, not `demo.playwright.dev`. |
| `Nothing is accepting connections at host:port` (exit 3) | The app is not running, or the port is wrong. Check with `ss -lptn 'sport = :<port>'`. |
| `Target preflight failed` (exit 3) | Something listens but the browser could not load it — TLS, redirect loop, or a very slow first load. Open it with `npm run mcp:playwright:headed` to see why. |
| Artifact describes a **different application** than `TARGET_URL` | See *Stale browser page* below. |
| `must be an absolute path for this platform` | A quoted `~`, or a leftover Windows `C:\…` value. Use `$HOME/...`. |
| `is inside the control plane` | A root was pointed inside `~/projects/flue-qa-agents`. The runtime workspace must be a sibling. |
| `Playwright MCP did not become ready within 120s` | Check `npm run check:playwright`; usually missing Chromium system deps (`sudo npx playwright install-deps chromium`). |
| `Playwright MCP is configured … but unreachable` | A stale `PLAYWRIGHT_MCP_URL`, or the server died. `unset PLAYWRIGHT_MCP_URL` and let the wrapper manage it. |
| Agents reply in prose and call no tools | Run `npm run check:tools`. A `@earendil-works/pi-ai` version split once caused Flue to send *no* tools and *no* system prompt. `npm ls @earendil-works/pi-ai` must show a single deduped `0.83.0`. |
| Run finishes, no artifacts | Known variance — see below. |
| Port 8931 busy | `ss -lptn 'sport = :8931'`, then kill that pid if it is a stale server. |

### Stale browser page (fixed, but know the symptom)

A run against `http://localhost:4444/` once produced a `discovered-behavior.json` describing
**TodoMVC** — the demo app from earlier runs. The long-lived shared MCP server had been up for
hours, and Product Discovery described what it saw instead of verifying where it was. The
target itself was fine (HTTP 200).

Two defences now exist, and both must hold:

1. **Host-side**: step 4 drives the browser to `TARGET_URL` before any agent runs, so the
   shared browser starts on the right page.
2. **Agent-side**: Product Discovery must make `browser_navigate` its *first* call, must
   check the `Page URL` of every snapshot against the target, and must reply BLOCKED rather
   than describe an unverified page.

If you ever see the wrong application in an artifact, restart the MCP server to clear all
browser state (`ss -lptn 'sport = :8931'`, kill that pid, then re-run — the wrapper starts a
fresh one) and report it: it means both defences failed.

### Artifact mentions a feature your app does not have

A run against the Auth + Notes app produced a test-cases open question about a *"Todo
creation"* feature. The app has no todos. Cause: the evidence-policy rules used TodoMVC wording
as examples, and the small model carried that wording into its output for a different app.
All prompt and skill examples are now domain-neutral.

If an artifact names a feature, page, or entity you do not recognise from your app, search
the prompts for it:

```bash
grep -rni "<the word>" src/agents src/skills/custom
```

Any hit inside an `INSTRUCTIONS` string or a `SKILL.md` body is contamination — the model
reads both. Keep examples generic; record lessons in source comments, which it does not read.

### Reliability — what to expect

Measured on `http://localhost:4444/`, 15 full Phase 1 runs across three builds:

| Build | Runs complete | Notes |
|---|---|---|
| deterministic sequencing, 2 attempts, fresh retries | 4/5 | MCP server silently orphaned and reused |
| + MCP group-kill, resumed retries | 4/5 | clean MCP lifecycle |
| **+ 4 attempts, alternating fresh / resumed** (current) | **5/5** | 4 failed attempts, all recovered |

The one failure mode left: in ~18% of attempts Qwen reasons at length and then stops without
calling the tool (empty content, `finish_reason: stop`). It is not the token cap and cannot be
switched off through Ollama's `/v1`. Retries recover it; a failed attempt costs ~20s. If a
stage still exhausts its attempts, the run stops, keeps what succeeded, and prints
`npm run qa:manual -- --from <stage>`.

A run takes **~4–10 minutes**. Artifacts appear in `.qa/` as each stage finishes.

## 6. Do not change these

Each was established by measurement.

- `@earendil-works/pi-ai` pinned to `^0.83.0` — must match `@flue/runtime`'s own range
- the reasoning-replay filter in `src/providers/ollama.ts` (keep `OLLAMA_REPLAY_REASONING` unset)
- model `qwen3:14b`, context `8192`
- Product Discovery's 5-tool browser allowlist
- `browser_evaluate`, `browser_run_code_unsafe`, `browser_file_upload` stay unmounted
