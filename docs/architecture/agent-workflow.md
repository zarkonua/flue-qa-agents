# Phase 2 pipeline — planned

What happens **after** the human approval gate. None of this runs today: `npm run qa:automation`
verifies the gate and stops. Phase 1 and the gate are in
[two-phase-workflow.md](two-phase-workflow.md); status for every box here is in
[README.md](README.md).

Sources: `../flue-qa-agents-spec-v4/agents/*.md` and `tool-contracts.json`. Every stage hands
off through a schema-validated JSON artifact on disk — never through conversation.

```mermaid
flowchart TB
    classDef agent fill:#ddd6fe,stroke:#6d28d9,color:#1f2937
    classDef planagent fill:#f9fafb,stroke:#9ca3af,color:#6b7280,stroke-dasharray:5 3
    classDef artifact fill:#a7f3d0,stroke:#047857,color:#1f2937
    classDef planartifact fill:#f9fafb,stroke:#9ca3af,color:#6b7280,stroke-dasharray:5 3
    classDef gate fill:#fef3c7,stroke:#b45309,color:#1f2937
    classDef exec fill:#bfdbfe,stroke:#1d4ed8,color:#1f2937

    approved[("approved AUTOMATION cases<br/>test-cases + automation-prioritization")]:::artifact

    repoanalyzer["Repo Analyzer<br/>existing test architecture<br/>NOT BUILT"]:::planagent
    a4[(".qa/repo-analysis.json<br/>PLANNED")]:::planartifact

    explorer["UI Explorer<br/>walks the real UI, records<br/>stable locator evidence<br/>built, never run live"]:::agent
    a5[(".qa/ui-exploration.json")]:::artifact

    gate{"real browser evidence<br/>OR existing Page Objects<br/>in the repo?"}:::gate
    refuse["refuse the case and name<br/>what needs exploration —<br/>never invent a locator"]:::gate

    generator["Automation Generator<br/>writes Playwright TS, then runs it<br/>built, never run live"]:::agent
    a6[(".qa/automation-plan.json<br/>+ tests/*.spec.ts")]:::artifact

    reviewer["automation-code Reviewer<br/>traceability, assertions,<br/>locator stability — NOT BUILT"]:::planagent
    a7[(".qa/review.json<br/>PLANNED")]:::planartifact

    exec["Playwright execution<br/>run_playwright_test · run_typecheck<br/>tools implemented"]:::exec

    analyzer["Failure Analyzer / Healer<br/>TEST_BUG · LOCATOR_CHANGED · TIMING_OR_SYNC<br/>TEST_DATA · ENVIRONMENT · PRODUCT_BUG<br/>NOT BUILT"]:::planagent
    a8[(".qa/failures/&lt;test-id&gt;.json<br/>+ .qa/bugs/&lt;test-id&gt;.md<br/>PLANNED")]:::planartifact

    approved --> repoanalyzer
    repoanalyzer -.-> a4
    approved --> explorer --> a5 --> gate
    a4 -.-> gate
    gate -->|"no"| refuse
    gate -->|"yes"| generator --> a6
    a6 --> reviewer
    reviewer -.-> a7
    a7 -.->|"approved: no BLOCKER,<br/>no correctness MAJOR"| exec
    a6 -->|"run_playwright_test"| exec
    exec -.->|"failures + read_test_results"| analyzer
    analyzer -.-> a8
    a8 -.->|"LOCATOR_CHANGED / TIMING_OR_SYNC / TEST_BUG<br/>only, with strong evidence"| generator
```

### The evidence gate

The point of the whole Playwright milestone: the Automation Generator **must not invent a
locator**. If neither real-browser evidence nor an existing Page Object covers a flow, it
refuses that test case and says which one needs exploration.
Rule: `src/skills/custom/locator-policy/SKILL.md`.

### The healing rule

Failure Analyzer may auto-modify a test only for `TEST_BUG`, `LOCATOR_CHANGED` and
`TIMING_OR_SYNC`, and only with strong evidence. It may never remove a valid assertion to go
green, weaken an exact expectation, add arbitrary sleeps, silently skip, swallow errors, or
turn an expected result into a product defect.

### Artifacts this phase would add

| Artifact | Produced by | Schema |
|---|---|---|
| `.qa/ui-exploration.json` | UI Explorer | `schemas/ui-exploration.schema.json` — exists |
| `.qa/automation-plan.json` | Automation Generator | `schemas/automation-plan.schema.json` — exists |
| `.qa/repo-analysis.json` | Repo Analyzer | spec pack only |
| `.qa/review.json` | automation-code Reviewer | spec pack only |
| `.qa/failures/<test-id>.json` | Failure Analyzer | spec pack only |

The spec writes **per-test** failure files plus `.qa/bugs/<test-id>.md` for `PRODUCT_BUG` — not
a single `failure-analysis.json`, despite the schema's singular name.
