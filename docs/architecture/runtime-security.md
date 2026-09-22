# Runtime Capability and Security Model

Runtime agents have **no shell, no filesystem API, and no path to `.claude/`**. A configured
working directory is not a security boundary — an unrestricted shell can `cd ..` around it —
so instead of a sandbox the agents get **narrow, host-controlled tools**, each mounted only on
the agents whose role needs it.

Source of truth: `src/lib/trusted-roots.ts`, `src/lib/qa-artifacts.ts`,
`src/connections/playwright-mcp.ts`, `src/skills/custom/capability-security/SKILL.md`, and
`../flue-qa-agents-spec-v4/docs/AGENT_SANDBOX_AND_TOOLS.md`.

## 1. Trust zones and the tool gateway

```mermaid
flowchart TB
    classDef agent fill:#ddd6fe,stroke:#6d28d9,color:#1f2937
    classDef gate fill:#fef3c7,stroke:#b45309,color:#1f2937
    classDef artifact fill:#a7f3d0,stroke:#047857,color:#1f2937
    classDef blocked fill:#fecaca,stroke:#b91c1c,color:#1f2937
    classDef operator fill:#fed7aa,stroke:#c2410c,color:#1f2937

    operator["Operator layer — human + Claude Code<br/>full shell, full filesystem, its own browser<br/>NOT a runtime agent capability"]:::operator

    subgraph runtime["Runtime agents — untrusted, model-driven"]
        direction TB
        agents["QA Manager · Product Discovery · Behavior Analyst<br/>Test Designer · UI Explorer · Automation Generator<br/><b>no shell · no file API · no path argument anywhere</b>"]:::agent
    end

    subgraph trusted["Trusted host code — src/lib, src/tools"]
        direction TB
        rootguard["load-time root guards — once per root, at import<br/>1. absolute for this platform<br/>2. outside the control plane<br/>else throw, never relocate"]:::gate
        names["tool input: a logical artifact name from a fixed<br/>picklist, or a repo-<i>relative</i> path — never a real path"]:::gate
        resolve["resolveInsideRoot() — per call<br/>rejects absolute and Windows-style paths, .. escapes,<br/>.claude / .git / .env / key files at any depth,<br/>symlinks pointing out of the root"]:::gate
        schema{"write_qa_artifact only:<br/>valid against<br/>schemas/*.schema.json?"}:::gate
        rootguard -.->|"establishes the roots"| resolve
        names --> resolve
        resolve --> schema
    end

    subgraph ws["~/projects/qa-workspace — the only writable region"]
        direction TB
        qa[(".qa/ — QA_ARTIFACT_ROOT")]:::artifact
        tests[("target-repo/{tests,e2e,pages,fixtures,helpers}<br/>QA_TEST_WRITE_ROOTS — .ts/.tsx only")]:::artifact
        results[("target-repo/{test-results,playwright-report,blob-report}<br/>QA_TEST_RESULTS_ROOTS — read only")]:::artifact
    end

    subgraph cpz["~/projects/flue-qa-agents — control plane"]
        direction TB
        cpfiles[".claude/settings.local.json<br/>agent source · schemas · skills · security code"]:::blocked
    end

    reject>"call refused,<br/>error returned to the agent"]:::blocked
    noshell>"no generic shell · no arbitrary command input<br/>no arbitrary code execution"]:::blocked

    operator -.->|"authors and runs the system"| agents
    agents -->|"every capability goes through a narrow tool"| names
    schema -->|"valid"| qa
    schema -->|"invalid"| reject
    resolve -->|"write_test_file"| tests
    resolve -->|"read_test_results"| results
    resolve -->|"escape attempt"| reject
    agents -.-x noshell
    agents -.-x cpz
```

**Why `.claude/` is unreachable:** not by a permission rule, but because no tool can resolve
there. The artifact root is resolved relative to the module (not the current working
directory) and every root is checked at load time to be absolute *and* outside the directory
that holds `.claude/` and the security code — the process throws rather than silently
relocating. Containment is then re-checked per path with a separator-aware test, not a string
prefix.

## 2. Browser capability — per-role allowlists

The `@playwright/mcp` server exposes **25 tools**. No agent gets all of them; each role gets
the smallest set that does its job. `npm run check:playwright` verifies the allowlisted names
against the running server and reports which arbitrary-code tools the server offers and we
decline.

```mermaid
flowchart LR
    classDef agent fill:#ddd6fe,stroke:#6d28d9,color:#1f2937
    classDef planagent fill:#f9fafb,stroke:#9ca3af,color:#6b7280,stroke-dasharray:5 3
    classDef allow fill:#a7f3d0,stroke:#047857,color:#1f2937
    classDef blocked fill:#fecaca,stroke:#b91c1c,color:#1f2937
    classDef authoring fill:#bfdbfe,stroke:#1d4ed8,color:#1f2937

    server["@playwright/mcp · localhost:8931/mcp<br/>25 tools exposed"]:::allow

    discovery["Product Discovery"]:::agent
    explorer["UI Explorer"]:::agent
    analyzer["Failure Analyzer<br/>PLANNED"]:::planagent
    generator["Automation Generator"]:::agent
    reviewer["Reviewer — PLANNED"]:::planagent

    dset["discoveryBrowser · 13 tools<br/>navigate · navigate_back · snapshot<br/>click · type · fill_form · select_option<br/>press_key · wait_for · handle_dialog<br/>console_messages · network_requests · close"]:::allow
    uset["uiExplorerBrowser · 12 tools<br/>discovery set minus dialog/console/network<br/>plus <b>find</b> (locator evidence)<br/>plus take_screenshot"]:::allow
    fset["failureAnalysisBrowser · 9 tools<br/>leanest set — reproduce one step<br/>navigate · snapshot · click · type · wait_for<br/>console_messages · network_requests<br/>take_screenshot · close"]:::allow

    forbidden["<b>NEVER mounted, for any role</b><br/>browser_evaluate — arbitrary JS in the page<br/>browser_run_code_unsafe — arbitrary JS against<br/>Playwright objects, reaches the filesystem<br/>via storageState({ path })<br/>browser_file_upload — reads local files by path"]:::blocked

    cliPath["Playwright CLI / @playwright/test<br/>run_playwright_test · run_typecheck<br/>host-built argv, no command input"]:::authoring

    server --> dset
    server --> uset
    server --> fset
    server --x forbidden
    dset --> discovery
    uset --> explorer
    fset -.-> analyzer
    cliPath --> generator
    cliPath -.-> reviewer
```

**Exploration and authoring never merge.** Product Discovery and UI Explorer get the
interactive browser; Automation Generator and Reviewer get the deterministic CLI/test path.
Collapsing these into one unrestricted browser/shell capability is exactly what the spec rules
out. The connection is mounted conditionally on `PLAYWRIGHT_MCP_URL`; when it is set but the
server is unreachable, the run **fails** (`optional: false`) rather than letting the model
quietly fall back to guessing.

## 3. Capability matrix — which agent holds which tool

Regenerated from the `useTool()` calls in `src/agents/*.ts` on 2026-09-22.

| Tool | QA Manager *(exp.)* | Product Discovery | Behavior Analyst | Test Designer | Automation Prioritizer | Test Case Reviewer | UI Explorer | Automation Generator |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `read_qa_artifact` | ● | | ● | ● | ● | ● | ● | ● |
| `write_qa_artifact` — **may write only** | — | `discovered-behavior` | `requirements-analysis` | `test-cases` | `automation-prioritization` | `test-cases-review` | `ui-exploration` | `automation-plan` |
| `read_repo_file` | | | | | | | ● | ● |
| `search_repo` | | | | | | | | ● |
| `write_test_file` | | | | | | | | ● |
| `run_playwright_test` | | | | | | | | ● |
| `run_typecheck` | | | | | | | | ● |
| Playwright MCP (allowlisted) | | 5 tools | | | | | 12 tools | |
| `useSubagent` delegation | ● | | | | | | | |

**Per-agent write restriction.** Each agent's `write_qa_artifact` is built with
`writeQaArtifactToolFor([...])`, whose input schema accepts only the listed artifact name. A
reviewer asking to write `test-cases` is rejected before the tool runs. `phase1-approval.json`
is in no agent's list — only `npm run qa:approve` (host code) writes it.

Mounted on **no agent yet**: `list_repo_directory`, `read_test_results`. Planned and **not
implemented**: `modify_test_file`. Not built: Repo Analyzer, automation-code Reviewer, Failure
Analyzer. Product Discovery no longer mounts `read_qa_artifact` (it is the first stage).

## 3a. Fixed 2026-09-22 — browser agents could write into the control plane

`browser_snapshot` takes a model-chosen `filename`, and `@playwright/mcp` resolved it against
its **working directory** — which was this control-plane project, because the server was
launched from here. Confirmed by 12 agent-written snapshot files in the project root and a
controlled probe.

**Fix.** `scripts/mcp-server.mjs` is the only launcher and runs the server with
**cwd = `MCP_OUTPUT_ROOT`** (validated absolute and outside the control plane);
`scripts/lib/runtime.mjs` refuses to reuse a running server unless it can prove that server's
cwd is outside the control plane, and fails closed if it cannot tell. Verified after the fix:
a relative filename lands in `.mcp-output`, and `../flue-qa-agents/…` and absolute paths into
the project are both refused.

**Lesson.** "The agent has no file tool" was true of our tools and false of a third-party
server's tool arguments. **Any MCP tool accepting a path is a filesystem capability.**

## 4. Configured roots

| Variable | Default | Constraint |
|---|---|---|
| `QA_ARTIFACT_ROOT` | `../qa-workspace/.qa` | absolute; outside the control plane |
| `QA_TARGET_REPO_ROOT` | `../qa-workspace/target-repo` | absolute; outside the control plane; read-only except test roots |
| `QA_TEST_WRITE_ROOTS` | `tests,e2e,pages,fixtures,helpers` | repo-relative; `.ts`/`.tsx` only |
| `QA_TEST_RESULTS_ROOTS` | `test-results,playwright-report,blob-report` | repo-relative; read-only |
| `QA_TYPECHECK_SCRIPT` | unset → `npx tsc --noEmit` | host-configured argv, **no agent input** |
| `QA_TEST_RUN_TIMEOUT_MS` | `600000` | hard kill for a test/typecheck run |
| `PLAYWRIGHT_MCP_URL` | unset → no browser | `default` expands to `http://localhost:8931/mcp` |
| `QA_MCP_OUTPUT_ROOT` | `../qa-workspace/.mcp-output` | Playwright MCP working directory and output — **security boundary** (§3a) |

Both root guards run at load time for *every* root and throw rather than silently relocating.
A leftover Windows `C:\...` value is not absolute on Linux and would otherwise resolve
*inside* this project — which is precisely why the check exists.

Legend and component status: [README.md](README.md). Capability rows for agents that do not
exist yet come from `../flue-qa-agents-spec-v4`. Langfuse, when it lands, needs a decision this
model already implies: trace export belongs in the trusted host layer, not as an agent-visible
capability.
