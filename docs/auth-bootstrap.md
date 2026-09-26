# Authentication bootstrap

The state a QA run's browser starts in. Optional; the default is unchanged behaviour.

```bash
QA_AUTH_MODE=none            # default
QA_AUTH_MODE=credentials     # + QA_AUTH_USER_EMAIL, QA_AUTH_USER_PASSWORD
QA_AUTH_MODE=storage_state   # + QA_AUTH_STORAGE_STATE
```

Two different things, kept apart on purpose:

- **Auth bootstrap** prepares the browser, or an account, so discovery can start from a
  chosen state.
- **Auth discovery** tests authentication itself: sign-up, sign-in, activation, password
  flows.

A bootstrap is a starting state, not a finding. A loaded session may have expired, and
whether the run is signed in is only ever what the application shows. Product Discovery
still observes everything, no behaviour is created because a bootstrap was configured, and
the Discovery Completion Gate does not read the auth mode: a run that lands on a sign-in
form is judged exactly as it would be without a bootstrap.

## Which mode

| Goal | Mode |
|---|---|
| Test sign-up, sign-in, activation, password flows | `none` (plus `QA_DISCOVERY_AUX_ORIGINS` if a mailbox is needed) |
| Discovery should sign in normally, with an account that already exists | `credentials` |
| Discover the product behind sign-in; fast local-model iteration; model comparisons | `storage_state` |

`storage_state` is preferred whenever authentication itself is not under test.

### Model benchmarking

For comparing models on anything other than authentication, use `storage_state`. Every
model then starts from the same application state: same account, same entry URL, same tools,
same prompts. Registration, activation mail and a model's skill at auth forms stop being part
of the comparison, and a model that stalls at sign-up can no longer score lower for reasons
that have nothing to do with discovering the product.

## `none`

The browser starts signed out, and Product Discovery handles authentication itself, as it
always has. Nothing else is needed. The prompt is byte-for-byte what it was before this
feature existed.

## `storage_state`

```bash
QA_AUTH_MODE=storage_state
QA_AUTH_STORAGE_STATE=.qa/auth/default-user.json   # relative paths resolve against this project
```

The host starts Playwright MCP with `--storage-state <path>` alongside its `--isolated` flag.
Each MCP client (the host's preflight, every discovery attempt, the evidence collector) then
gets a **fresh** `browser.newContext({ storageState })`: Playwright's native mechanism. The
host never reads, parses or replays the file.

- The file is an **input template**. Playwright only reads it, and an isolated context lives
  in memory and is discarded. A run that signs out, or changes cookies or local storage,
  never changes the file or the next run's starting state.
- Navigation still begins at `TARGET_URL`. What the stored session exposes from there is up to
  the application.
- The file must exist before the run starts; otherwise the run stops with exit code 2 and
  `[flue] Auth storage state file was not found: <path>`. Only the path is ever printed.
- It may not live in the browser's output directory (`QA_MCP_OUTPUT_ROOT`), where a browser
  tool's `filename` could overwrite it.
- An expired session is not an error. The application shows sign-in, and discovery treats
  that as any other sign-in flow; no credentials are available to it in this mode.

### Creating a storage state

This project does not write auth state; a QA run never overwrites it. Create one with
Playwright's own tooling, as a confirmed test user:

```bash
# Opens a browser. Sign in by hand, then close the window; the state is saved on exit.
npx playwright codegen --save-storage=.qa/auth/default-user.json http://localhost:4444/
```

Or from a script: sign in with `page`, then `await context.storageState({ path })`.
`.qa/` is git-ignored here, as are `storage-state*.json`, `*.storagestate.json` and `.auth/`.

## `credentials`

```bash
QA_AUTH_MODE=credentials
QA_AUTH_USER_EMAIL=qa-user@example.test
QA_AUTH_USER_PASSWORD=...
```

For an account that already exists. The values are never given to the model. The host
writes them into a private dotenv file (a `0700` temporary directory, file mode `0600`,
outside every agent-reachable root) and starts Playwright MCP with `--secrets <file>`. The
server reads the file once at startup, and the host deletes it as soon as the server answers.

From then on, Playwright MCP's own secret handling applies:

- Product Discovery is told to type the **references** `QA_AUTH_USER_EMAIL` and
  `QA_AUTH_USER_PASSWORD` as field values. When `browser_type` or `browser_fill_form` gets text
  equal to a reference, the browser fills the real value instead.
- Every tool result the server returns has the values replaced by
  `<secret>QA_AUTH_USER_EMAIL</secret>` / `<secret>QA_AUTH_USER_PASSWORD</secret>`. That
  includes an application that echoes them back onto the page.

So the model's prompt, its tool arguments and every result it reads carry names, never
values. Everything built from those results carries names too: the surface, delta hints,
completion-gate metadata, observations and artifacts. As a second line:

- the values are masked in every Langfuse string (four characters or longer), whatever path
  they took;
- they are removed from the environment of `npx playwright test` runs that Phase 2's
  `run_playwright_test` starts, since model-written test code could print `process.env`.

Sign-up with invented data is still auth discovery. `credentials` makes an account available;
it does not stop discovery from exploring the forms around it.

The review workspace's QA agent never uses a browser, so no bootstrap applies to it; it works
from the evidence the last discovery run recorded.

## Telemetry

The trace root and `phase1-run.json` record the mode, never an account, path, cookie or token:

| Field | Meaning |
|---|---|
| `authBootstrapMode` | `none`, `credentials` or `storage_state` |
| `authBootstrapConfigured` | a mode other than `none` |
| `authStorageStateLoaded` | the browser was started with a storage state: applied, which is not the same as valid |
| `configuredTestUserAvailable` | a test account was available to the browser |

There is deliberately no "auth succeeded" field. The completion metrics
(`authFormSeen`, `authenticatedStateSeen`) are the evidence of what actually happened.

## Browser lifecycle

A bootstrap is a launch argument, so a run with a mode other than `none` always starts its own
Playwright MCP server, as `--fresh-browser` does. It is applied once, at startup. After that
the application state belongs to the run: signing out, expiry or switching users are not
undone, and nothing is reapplied mid-run.

`npm run mcp:playwright` on its own starts a server with no bootstrap. A run in a bootstrap mode
replaces it.

## Future: named profiles

The environment is parsed in one place (`readAuthBootstrap` in
`src/config/auth-bootstrap.ts`) into a runtime value (`AuthBootstrapConfig`) that the host
passes around. A later profile file can produce the same value per profile, without touching
how it is applied:

```yaml
profiles:
  authenticated:
    auth: { mode: storage_state, storageState: .qa/auth/default-user.json }
  fresh-user:
    auth: { mode: none }
```

## Limits

- One account. Several roles means several storage-state files and several runs, for now.
- Entry is always `TARGET_URL`; there is no per-mode start URL.
- The values are masked in traces only when four characters or longer; the browser's own
  redaction has no minimum.
- The browser's redaction is by exact value. A page that transforms a value (upper-cases it,
  shows part of it) is not caught by it.
