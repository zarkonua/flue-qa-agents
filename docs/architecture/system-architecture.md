# System Architecture

C4-style view of where every part of Flue QA Agents runs and how the pieces reach each
other. Source of truth: the project [`README.md`](../../README.md) (Environment, security
model, layout) and the spec pack at `../flue-qa-agents-spec-v4`.

## 1. Deployment topology — model host and agent host

```mermaid
flowchart TB
    classDef impl fill:#ddd6fe,stroke:#6d28d9,color:#1f2937
    classDef model fill:#3b82f6,stroke:#1e3a5f,color:#ffffff
    classDef store fill:#a7f3d0,stroke:#047857,color:#1f2937
    classDef operator fill:#fed7aa,stroke:#c2410c,color:#1f2937
    classDef planned fill:#f9fafb,stroke:#9ca3af,color:#6b7280,stroke-dasharray:5 3

    subgraph windows["Model host"]
        direction TB
        ollama["Ollama<br/>127.0.0.1:11434/v1<br/>OpenAI-compatible endpoint"]:::impl
        qwen["qwen3:14b<br/>server ctx 16384 · declared to Flue 8192<br/>max output 2048"]:::model
        ollama --> qwen
    end

    subgraph wsl["Agent host · WSL2 / Linux · Node ≥ 22.19"]
        direction TB

        subgraph operatorzone["Operator layer — trusted, not an agent capability"]
            direction TB
            cc["Claude Code<br/>authors agents, runs npm scripts"]:::operator
            ccmcp["Playwright MCP<br/>(Claude Code's own registration)"]:::operator
            pwcli["Playwright CLI 0.1.21<br/>+ .claude/skills/playwright-cli"]:::operator
            cc --> ccmcp
            cc --> pwcli
        end

        subgraph cp["Control plane — ~/projects/flue-qa-agents"]
            direction TB
            flue["Flue runtime 2.1.0<br/>npx flue run src/agents/*.ts"]:::impl
            agents["8 QA agents + 9 narrow tools<br/>src/agents · src/tools · src/lib"]:::impl
            flue --> agents
        end

        pwmcp["@playwright/mcp server<br/>localhost:8931/mcp<br/>--headless --isolated --browser chromium<br/>cwd = qa-workspace/.mcp-output"]:::impl
        pwtest["@playwright/test 1.63.0<br/>run_playwright_test · run_typecheck"]:::impl
        chromium["Chromium (bundled)"]:::impl

        subgraph ws["Runtime QA workspace — ~/projects/qa-workspace"]
            direction TB
            qa[(".qa/ — QA_ARTIFACT_ROOT<br/>schema-validated hand-off JSON")]:::store
            target[("target-repo/ — QA_TARGET_REPO_ROOT<br/>tests · e2e · test-results")]:::planned
        end
    end

    targetapp["Target application under test<br/>live URL, e.g. demo.playwright.dev/todomvc"]:::impl
    langfuse["Langfuse — observability<br/>agent traces, token/prompt telemetry"]:::planned

    cc -.->|"authors, operates"| flue
    agents -->|"every agent turn<br/>OpenAI-compat HTTP"| ollama
    agents -->|"MCP<br/>role allowlist"| pwmcp
    agents -->|"host-built argv"| pwtest
    agents -->|"read/write_qa_artifact"| qa
    agents -->|"repo read<br/>test-file write"| target
    pwmcp --> chromium
    pwtest --> chromium
    chromium --> targetapp
    agents -.->|"planned: export traces"| langfuse
```

Ollama is reached over its OpenAI-compatible HTTP endpoint, so it may run beside the agents or
on another machine. `OLLAMA_BASE_URL` selects it; `npm run check:ollama` prints the right value
when the default loopback address does not reach it.

## 2. Control-plane internals

```mermaid
flowchart LR
    classDef impl fill:#ddd6fe,stroke:#6d28d9,color:#1f2937
    classDef gate fill:#fef3c7,stroke:#b45309,color:#1f2937
    classDef store fill:#a7f3d0,stroke:#047857,color:#1f2937
    classDef planned fill:#f9fafb,stroke:#9ca3af,color:#6b7280,stroke-dasharray:5 3

    subgraph src["src/"]
        direction TB
        agentsMod["agents/<br/>8 agent modules"]:::impl
        toolsMod["tools/<br/>qa-artifacts · repo · test-code"]:::gate
        libMod["lib/<br/>trusted-roots · qa-artifacts · target<br/>schema-validate · semantic-validate · phase1-gate"]:::gate
        provMod["providers/ollama.ts<br/>custom Flue provider via pi-ai"]:::impl
        connMod["connections/playwright-mcp.ts<br/>3 per-role allowlists"]:::gate
        skillsMod["skills/<br/>6 custom · 15 vendored upstream"]:::impl
    end

    schemas["schemas/<br/>7 hand-off JSON Schemas"]:::store
    schemasPlanned["repo-analysis · review · failure-analysis<br/>schemas (spec pack only)"]:::planned
    scripts["scripts/<br/>qa-manual · qa-review · qa-approve · qa-automation<br/>mcp-server · lib/runtime · check-ollama · probe-browser · validate-artifact"]:::impl

    agentsMod -->|"useTool()"| toolsMod
    agentsMod -->|"useModel('ollama/qwen3:14b')"| provMod
    agentsMod -->|"browserTools() → useTool()"| connMod
    agentsMod -->|"useSkill()"| skillsMod
    toolsMod -->|"path containment + root guards"| libMod
    libMod -->|"validate before write"| schemas
    schemasPlanned -.->|"copied in when those agents land"| schemas
    scripts -.->|"verify the stack, model-free"| connMod
```

Every agent file imports the Ollama provider for its side effect
(`import '../providers/ollama.ts'`), because `flue run` loads only the agent module — there is
no shared `app.ts` in this project yet.

`qa-workspace/target-repo/` is shown dashed because no target repository has been placed
there yet, so the repo-read and test-write tools have nothing real to act on. Legend and
component status: [README.md](README.md). Current orchestration:
[two-phase-workflow.md](two-phase-workflow.md).
