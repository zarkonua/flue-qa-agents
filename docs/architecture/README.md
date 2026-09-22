# Architecture

Four documents and one interactive page. Start with **[architecture-view.html](architecture-view.html)** —
open it in a browser; it is self-contained. The Markdown diagrams are Mermaid and render in
GitHub and VS Code.

| Document | Covers |
|---|---|
| [**architecture-view.html**](architecture-view.html) | The whole current system on one interactive page: the execution chain from `TARGET_URL` through Phase 1, the approval gate and the Phase 2 boundary, each agent's mounted skills, the artifacts between stages, retry behaviour, the trust boundary and the capability matrix. |
| [**two-phase-workflow.md**](two-phase-workflow.md) | How Phase 1 is sequenced, what the approval gate locks, the Phase 2 entry conditions, and every invariant with the file that enforces it. |
| [**runtime-security.md**](runtime-security.md) | Trust zones and the tool gateway, the per-role Playwright MCP allowlists, the agent × tool capability matrix, and the configured roots. |
| [**system-architecture.md**](system-architecture.md) | Deployment topology and a component view of `src/`. |
| [**agent-workflow.md**](agent-workflow.md) | *Planned Phase 2 pipeline only* — the stages after the approval gate, the locator-evidence gate and the healing rule. |

## Implemented vs planned

The single status table for this folder; the documents below do not repeat it.

| Area | Status |
|---|---|
| **Phase 1** — Product Discovery → Behavior Analyst → Test Designer → Automation Prioritizer | **Implemented, live-verified**; sequenced by `scripts/qa-manual.mjs` |
| Test Case Reviewer (`qa:review`) | Implemented; advisory, writes proposals only |
| Approval gate (`qa:approve`) and Phase 2 entry gate (`qa:automation`) | Implemented; hash-locked, host code only |
| Semantic validation across all Phase 1 artifacts | Implemented; 60 regression tests |
| Per-agent write restriction | Implemented, enforced by tool input schema |
| Playwright MCP confined outside the control plane | Implemented (fixed 2026-09-22) |
| QA Manager (model-driven orchestration) | Implemented but **experimental** (`qa:agentic`), off the critical path |
| UI Explorer, Automation Generator | Built and wired; **never run live**; not invoked by `qa:automation` |
| **Phase 2 pipeline** | **Planned.** `qa:automation` verifies the gate, then stops. |
| Repo Analyzer | **Planned** — its read-only tools exist; agent and schema do not |
| Automation-code Reviewer, Test Runner, Failure Analyzer | **Planned** |
| `modify_test_file` | **Planned** — in the spec's tool contracts, no implementation |
| Langfuse observability | **Planned only** — no dependency or integration point exists |

## Legend

Used by every diagram in this folder.

| Style | Meaning |
|---|---|
| Purple | Implemented agent |
| Amber | Implemented guard, gateway, or policy decision |
| Green | Implemented artifact, data store, or allowed capability |
| Blue | Deterministic authoring/execution path (Playwright CLI / `@playwright/test`) |
| Orange | Operator layer, outside the agent trust zone |
| Red | Refused, blocked, or never-mounted capability |
| **Grey, dashed** | **Planned** — specified, not implemented |

These diagrams are derived from `src/` and must stay consistent with it; stages that do not
exist yet come from the spec pack at `../flue-qa-agents-spec-v4`.
