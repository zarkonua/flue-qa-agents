# Flue QA Agents

A local, multi-agent QA workflow built on [Flue](https://flueframework.com/) and driven by a
local [Ollama](https://ollama.com/) model. No cloud LLM, no API keys, no Docker.

It turns a running web application into a reviewed manual test suite, in two phases with a
person in the middle:

```text
PHASE 1 — Manual QA Design        npm run qa:manual
        ↓
   HUMAN APPROVAL GATE            npm run qa:approve
        ↓
PHASE 2 — Automation Engineering  npm run qa:automation   (entry gate only — not built yet)
```

Phase 1 browses the target application, records only what it observed, and produces a manual
test suite plus a recommendation of which cases are worth automating — then **stops**. You
review and edit the result and approve it yourself. Phase 2 refuses to start from anything
that has not been approved, or that changed after approval.

---

## Quick start

```bash
cd ~/projects/flue-qa-agents
export TARGET_URL="http://localhost:4444/"   # the only required setting

npm run qa:manual       # Phase 1: 4 agents in fixed order, then STOP  (~4–10 min)
npm run qa:review       # optional AI review — proposes changes, edits nothing
npm run qa:approve      # your approval, hash-locked to the exact artifacts
npm run qa:automation   # Phase 2 gate: refuses unless approved and unchanged
```

`npm run qa` is an alias of `qa:manual`. Everything else has a working default.

**Start here:** [docs/RUNBOOK.md](docs/RUNBOOK.md) — every command, variable, expected output
and failure message.

---

## How it works

Phase 1 runs four agents in a fixed order set by **host code** (`scripts/qa-manual.mjs`), not
by a model deciding what comes next:

| # | Stage | Writes | Browser |
|---|---|---|---|
| 1 | **Product Discovery** | `discovered-behavior.json` | 5 tools |
| 2 | **Behavior Analyst** | `requirements-analysis.json` | — |
| 3 | **Test Designer** | `test-cases.json` | — |
| 4 | **Automation Prioritizer** | `automation-prioritization.json` | — |

Optional: **Test Case Reviewer** (`npm run qa:review`) writes `test-cases-review.json` and
proposes changes only. Built but not wired into any command: UI Explorer, Automation
Generator. Not built: Repo Analyzer, automation-code Reviewer, Test Runner, Failure Analyzer.

Each stage runs as its own process, hands off through a JSON artifact on disk, and passes only
if host code confirms the artifact was written during that attempt and still validates. Stages
get up to 4 attempts, alternating between continuing the same conversation with a correction
and starting fresh.

**Diagrams and design:** [docs/architecture/](docs/architecture/) — start with the interactive
[architecture-view.html](docs/architecture/architecture-view.html) or
[two-phase-workflow.md](docs/architecture/two-phase-workflow.md).

### Two kinds of priority

`test-cases.json` carries **P0–P3**, the product risk of the test.
`automation-prioritization.json` carries **executionMode** (`AUTOMATION` / `MANUAL`) and
**automationPriority** (`HIGH` / `MEDIUM` / `LOW` / `NONE`), the value of automating it. They
are independent, and MANUAL cases stay in the suite permanently.

---

## What keeps the output honest

**Nothing an agent writes is trusted on its own.** Every `write_qa_artifact` call is checked
twice before anything reaches disk: against the artifact's JSON Schema, then against the
upstream artifacts — evidence IDs must exist, and no route, credential, quoted UI text or
product feature may appear unless upstream evidence contains it. A rejected write changes
nothing and hands the agent the exact problems to fix.

This is enforced in code, not asked for in prompts:

| Invariant | Enforced by |
|---|---|
| Each agent can write **only its own artifact** | the tool's input schema (`writeQaArtifactToolFor`) |
| Phase 1 can never start a Phase 2 agent | a closed allowlist checked at startup |
| Evidence IDs resolve; no invented facts | `src/lib/semantic-validate.ts`, on every write |
| Every test case prioritized exactly once | `validateAutomationPrioritization` |
| Phase 2 starts only from approved, unchanged content | `src/lib/phase1-gate.ts` (SHA-256 of all four artifacts) |
| Approval is a person's act | `npm run qa:approve` is host code; no agent can read or write the approval file |

Rules, the error format, and the known gaps:
[docs/SEMANTIC-VALIDATION.md](docs/SEMANTIC-VALIDATION.md).

```bash
npm test     # 60 regression tests for the validators and the approval gate (~1s)
```

---

## Security model

Runtime agents have **no shell, no filesystem API, and no path argument anywhere**. A working
directory is not a security boundary, so instead of a sandbox each agent gets a few narrow,
host-controlled tools:

- **Artifacts** — `read_qa_artifact(name)` / `write_qa_artifact(name, data)` take a logical
  name from a fixed list, never a path. Host code maps it under `QA_ARTIFACT_ROOT`.
- **Repository** — read-only, relative paths only; `..` escapes, absolute paths, `.claude/`,
  `.git`, `.env`, key files and symlinks out of the root are all refused.
- **Test execution** — the model never supplies a command. It asks for
  `run_playwright_test(path?)` and host code builds the argv.
- **Browser** — a per-role allowlist over Playwright MCP. `browser_evaluate`,
  `browser_run_code_unsafe` and `browser_file_upload` are never mounted: they amount to
  arbitrary code or local-file access behind a browser tool.

Every configured root must be absolute and **outside this project**, checked at load time. The
Playwright MCP server also runs with its working directory outside the project, because its
snapshot tools write a model-chosen filename — see
[docs/architecture/runtime-security.md](docs/architecture/runtime-security.md) §3a.

---

## Layout

```text
flue-qa-agents/
├─ scripts/          host code: qa-manual · qa-review · qa-approve · qa-automation ·
│                    qa-agentic · mcp-server · lib/runtime · diagnostics
├─ schemas/          7 hand-off JSON Schemas
├─ src/
│  ├─ agents/        8 agents (4 Phase 1 · reviewer · QA Manager · 2 Phase 2)
│  ├─ connections/   Playwright MCP + per-role tool allowlists
│  ├─ diagnostics/   regression agents: local tool calling · MCP tool calling
│  ├─ lib/           artifacts · schema + semantic validation · trusted roots · phase-1 gate
│  ├─ providers/     Ollama provider (reasoning-replay filter, sampling)
│  ├─ tools/         qa-artifacts · repo · test-code
│  └─ skills/        custom/ (6, project-specific) · upstream/qa-skills/ (15, vendored)
├─ test/             60 tests (semantic validation, Phase 1 invariants, approval gate)
└─ docs/             RUNBOOK · SEMANTIC-VALIDATION · architecture/ · notes/ (local only)
```

Artifacts are written to a **sibling** runtime workspace, never inside this project:
`~/projects/qa-workspace/.qa/` by default.

### Skills

- **Custom** (`src/skills/custom/`) — `agent-handoff`, `capability-security`,
  `product-evidence-policy`, `test-case-contract`, `locator-policy`, and a `project-rules`
  template (not yet populated).
- **Vendored** (`src/skills/upstream/qa-skills/`) — 15 skills from
  [`petrkindlmann/qa-skills`](https://github.com/petrkindlmann/qa-skills) (MIT), pinned at
  commit `b3bb61bd…`; see `src/skills/upstream/qa-skills/VENDORED.json`. Seven are mounted by an agent; the rest are kept
  for later stages.
- Which agent mounts which skill is shown per agent in the
  [architecture view](docs/architecture/architecture-view.html). Product Discovery and the
  Automation Prioritizer mount **none** — their rules are inlined to fit the context budget.
- The `.claude/skills/` directory holds Claude Code operator tooling. No runtime agent loads
  it.

---

## Environment

| | |
|---|---|
| OS | WSL2 (Ubuntu 24.04); Linux/macOS/CI-friendly by design |
| Model | `qwen3:14b` via Ollama's OpenAI-compatible endpoint, default `http://127.0.0.1:11434/v1` |
| Context | 8192 declared to Flue, 2048 max output tokens |
| Cost | $0 — no API key, no cloud provider |
| Flue | `@flue/runtime` / `@flue/cli` 2.1.0 |
| Browser | Playwright 1.63, Chromium only (`@playwright/mcp` to explore, `@playwright/test` to execute) |
| Node | ≥ 22.19 |

Two pins that must not drift, each established by debugging:

- **`@earendil-works/pi-ai` stays at `^0.83.0`** to match `@flue/runtime`. A mismatch installs
  two copies, and Flue then sends requests with *no system prompt and no tools* — which looks
  exactly like a model that refuses to call tools.
- **The reasoning-replay filter** in `src/providers/ollama.ts` stays on. Without it, Qwen's
  historical reasoning is replayed into every later request and overruns the context window.

Check the stack at any time:

```bash
npm run check:ollama       # model reachable, context, live tool-call probe
npm run check:playwright   # Chromium, deps, CLI, skill, MCP server, tool allowlist
npm run check:tools        # regression: the model really calls a local tool
npm run check:mcp-tools    # regression: the model really calls a browser tool
npm run probe:browser      # model-free: Flue → MCP → Chromium → page → validated artifact
```

If Ollama runs on a different machine from the agents (for example on a Windows host, with the
agents in WSL), `npm run check:ollama` probes the candidate endpoints and prints the
`OLLAMA_BASE_URL` to export.

---

## Status

Phase 1 is implemented and live-verified: **5 of 5** complete runs on the final build, with
every artifact schema- and semantically valid. The approval gate and the Phase 2 entry gate are
implemented and tested end to end. The Phase 2 pipeline itself is not built.

Known limits worth reading before relying on this:

- Roughly 18% of individual agent attempts end with the model reasoning and then stopping
  without calling its tool. Retries recover it; a failed attempt costs about 20 seconds.
- Output depth is capped by discovery depth — faithful artifacts mean a thin discovery run
  yields a small test suite.
- The repository is not committed to git yet (no git identity configured).

## Documentation

| Document | What it covers |
|---|---|
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operator guide: commands, variables, outputs, troubleshooting |
| [docs/architecture/](docs/architecture/) | Diagrams: execution chain, trust zones, capability matrix |
| [docs/SEMANTIC-VALIDATION.md](docs/SEMANTIC-VALIDATION.md) | What is checked between artifacts, and what cannot be |

Dated working notes — milestone journals, measurements, open decisions — live in `docs/notes/`,
which is git-ignored and local to the machine that ran them.

Specification source: `../flue-qa-agents-spec-v4` — agent role definitions, JSON Schemas and
the security architecture this project implements.
