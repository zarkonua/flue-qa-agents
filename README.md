# Flue QA Agents

A local, multi-agent QA system built on [Flue](https://flueframework.com/) and driven by
`qwen3:14b` through [Ollama](https://ollama.com/). No cloud LLM, no API keys, no Docker.

It turns a running web application into a reviewed manual test suite, and refuses to generate
automation from anything a person has not approved.

```text
PHASE 1 — Manual QA design         npm run qa:manual
        ↓
   HUMAN APPROVAL GATE             npm run qa:approve
        ↓
PHASE 2 — Automation engineering   npm run qa:automation
```

Phase 1 browses the target app, records only what it observed, and produces a manual test
suite plus a recommendation of which cases are worth automating — then **stops**. You review,
edit and approve it. Phase 2 starts only from that approved, unchanged content; its first
stage reads your automation repository and records how tests are written there.

## Quick start

```bash
export TARGET_URL="http://localhost:4444/"          # required for Phase 1
export QA_TARGET_REPO_ROOT="/path/to/your/e2e-repo" # required for Phase 2

npm run qa:manual        # Phase 1: 4 agents in fixed order, then STOP   (~5–15 min)
npm run qa:review        # optional AI review — proposes changes, edits nothing
npm run qa:approve       # your approval, hash-locked to the exact artifacts
npm run qa:automation    # Phase 2: entry gate, then Repo Analyzer, then STOP
```

`npm run qa` is an alias of `qa:manual`. Everything else has a working default.
Full operator guide: **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

## The pipeline

Host code fixes the order — no model decides what runs next. Each agent runs as its own
process and hands off through a JSON artifact on disk.

| # | Stage | Writes | Status |
|---|---|---|---|
| 1 | Product Discovery | `discovered-behavior.json` | live · 5 browser tools |
| 2 | Behavior Analyst | `requirements-analysis.json` | live |
| 3 | Test Designer | `test-cases.json` | live |
| 4 | Automation Prioritizer | `automation-prioritization.json` | live |
| — | *Test Case Reviewer* (`qa:review`) | `test-cases-review.json` | live · optional, advisory |
| 🔒 | **Human approval gate** (`qa:approve`) | `phase1-approval.json` | host code, no agent |
| 5 | Repo Analyzer | `repo-analysis.json` | live · Phase 2 stage 1 |

Phase 2 stops after stage 5. **UI Explorer** and **Automation Generator** exist in
`src/agents/` but are wired to no command and have never run live. Automation-code Reviewer,
Test Runner and Failure Analyzer are not built. A **QA Manager** (`qa:agentic`) keeps the old
model-driven orchestration for experiments; the approval gate does not apply to it.

## Why the output can be trusted

Nothing an agent writes is taken on its word. Every `write_qa_artifact` call is checked
against the artifact's JSON Schema and then against the evidence it claims — upstream
artifacts for Phase 1, the repository on disk for Phase 2 — before anything reaches disk.

These are enforced in code, not asked for in prompts:

| Invariant | Enforced by |
|---|---|
| Each agent can write **only its own artifact** | the tool's input schema (`writeQaArtifactToolFor`) |
| Phase 1 never starts a Phase 2 agent; Phase 2 starts only wired agents | closed allowlists checked at startup |
| Evidence IDs resolve; no invented routes, credentials or features | `src/lib/semantic-validate.ts`, on every write |
| Repo analysis names only real files, and accounts for every automation directory | `src/lib/repo-evidence.ts` + the same validator |
| A stage passes only if its artifact was written **during that attempt** | `scripts/lib/stage.mjs`, re-validated from disk |
| Phase 2 starts only from approved, unchanged content | `src/lib/phase1-gate.ts` — SHA-256 of all four artifacts |
| Approval is a person's act | `qa:approve` is host code; no agent can name the approval file |

Runtime agents have **no shell, no filesystem API and no path argument anywhere**. Each
capability is a narrow host-controlled tool over roots that must live outside this project.

What validation does and does not guarantee: **[docs/VALIDATION.md](docs/VALIDATION.md)**.

```bash
npm test     # 118 tests covering the validators, both gates and the orchestration
```

## Status

Phase 1 is live-verified: 5 of 5 complete runs on the current build. The approval gate and
the Phase 2 entry gate are implemented and tested end to end. Phase 2 stage 1 (Repo Analyzer)
is live-verified against a real Playwright repository.

Known limits worth reading first:

- Roughly 18% of individual agent attempts end with the model reasoning and then stopping
  without calling its tool. Retries recover it; four attempts per stage is the default.
- Output depth is capped by discovery depth — a thin discovery run yields a small suite.
- Repo analysis is checked for completeness, not for judgement: it must describe every
  automation directory and evidence each with a real file, but it cannot tell whether the
  conventions it found are the ones that matter. Read it before relying on it.

## Layout

```text
scripts/    host orchestration: qa-manual · qa-automation · qa-approve · qa-review · lib/
src/
  agents/       9 agents (4 Phase 1 · reviewer · QA Manager · Repo Analyzer · 2 unwired)
  tools/        9 narrow tools: artifacts · repo (read-only) · test-code
  lib/          trusted roots · schema + semantic validation · repo evidence · phase-1 gate
  connections/  Playwright MCP, with a per-role tool allowlist
  providers/    Ollama provider (reasoning-replay filter, low-variance sampling)
  skills/       custom/ (6) · upstream/qa-skills/ (15, vendored, MIT)
schemas/    8 hand-off JSON Schemas
test/       118 tests
```

Artifacts are written to a **sibling** workspace, never inside this project:
`~/projects/qa-workspace/.qa/` by default.

## Documentation

| | |
|---|---|
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Running it: commands, variables, outputs, troubleshooting |
| [docs/VALIDATION.md](docs/VALIDATION.md) | What deterministic validation guarantees, and what it does not |
| [docs/architecture/architecture-view.html](docs/architecture/architecture-view.html) | The architecture reference — execution chain, skills, trust boundaries, capability matrix. Open it in a browser |

Source, schemas and tests are the detailed truth; the documents above do not restate them.
Requires Node ≥ 22.19 and a reachable Ollama endpoint.
