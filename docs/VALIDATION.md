# Validation

What the deterministic checks guarantee before an artifact reaches disk — and what they do
not. The executable reference is `src/lib/semantic-validate.ts` and `test/*.test.ts`.

## Two layers, then the write

```text
agent calls write_qa_artifact(name, data)
   1. JSON Schema        schemas/<name>.schema.json      -> reject: shape errors (Ajv, Draft 2020-12)
   2. semantic checks    evidence read by HOST code      -> reject: grouped errors
   3. completion gate    discovered-behavior only        -> reject: what is still unresolved
   4. write                                              -> only if all pass
```

Artifact schemas are validated with Ajv against JSON Schema Draft 2020-12, in strict mode and
reporting every error in one pass (`src/lib/schema-validation.ts`). Each schema file is compiled
once per process. Validation never changes the object — no type coercion, no defaults, no
removal of unknown properties — so what passed is exactly what is written.

The completion gate is a separate layer on purpose: an artifact can be well-formed and fully
supported while the run that produced it clicked Sign In, never looked, and stopped. See
[Discovery: finalizing is gated](#discovery-finalizing-is-gated).

Schema validation proves the artifact has the right *shape*. Semantic validation asks whether
the content is *supported*. The evidence is always loaded by host code, never supplied by the
model, so an agent cannot validate against evidence of its own invention. A rejected write
changes nothing on disk — a previous good artifact is never overwritten by a bad one — and
the agent receives the grouped errors as the tool result and retries. No human is involved.

| Writing | Checked against |
|---|---|
| `discovered-behavior` | itself (internal consistency) |
| `requirements-analysis` | `discovered-behavior` |
| `test-cases` | `requirements-analysis` + `discovered-behavior`, and re-checks that the requirements are still consistent with the current discovery |
| `automation-prioritization` | `test-cases`; hard facts against discovery and requirements |
| `defect-analysis` (and every `bugs/BUG-NNN.json`) | `discovered-behavior`, `requirements-analysis`, `test-cases` — see [Defects](#defects-expected-must-be-supported-actual-must-be-observed) |
| `test-cases-review` | `test-cases` and `automation-prioritization` |
| `repo-analysis` | the target repository **on disk** |

The orchestrator repeats both layers from disk after each stage, and additionally requires the
file to have been written *during that attempt* — an artifact left by an earlier run can never
make a failed attempt look successful.

## Discovery: the surface must be accounted for

Product Discovery does not decide for itself when it has seen enough: nothing downstream can
recover from a thin discovery, because the Behavior Analyst and Test Designer can only work with
what was observed.

Host code establishes the surface before the agent runs. The preflight snapshot of the
entry page is parsed for the `/url:` entries Playwright emits for links; same-origin links are
normalised, deduplicated and capped, and obviously session-ending or destructive ones are
pre-marked `SKIPPED_WITH_REASON`. The result is written to `discovery-surface.json` for the current run.

Every location on that surface must reach a terminal state in the artifact:

| Status | Means |
|---|---|
| `EXPLORED` | navigated there and snapshotted it |
| `BLOCKED` | tried and could not — a reason is required |
| `SKIPPED_WITH_REASON` | deliberately not followed — a reason is required |

A location the artifact never mentions is a rejected write. There is **no** minimum number of
behaviors: how much discovery is enough follows from the surface, not from the model's
judgement.

The surface is **not fixed for the run**. Every browser result the agent gets is read by host
code on the way back: the page the session landed on, and the same-origin links that page
renders, join the list that must be accounted for (same origin rule, same `MAX_LOCATIONS` cap,
same pre-skipping of destructive links). This is what carries the rule past a sign-in — an
application whose landing page is a login form offers one location, and without this,
accounting for that one location satisfies every host-enforced rule while the product itself
goes unseen.

A location the artifact *itself* names — in an area's routes, in a behavior, or in an
observation — must also reach a terminal state. A run that recorded "navigated to
/account/notes" while listing only the entry page is rejected (`UNACCOUNTED_LOCATION`).

Only an off-origin or malformed URL is rejected outright. Pages on a configured auxiliary
origin (a test mailbox) are infrastructure: they may be reported — without an area — but are
never *required* in `locations`.

## Discovery: finalizing is gated

Product Discovery's `write_qa_artifact("discovered-behavior")` is its proposal to finish. Once
the artifact passes schema and semantic validation, the **Discovery Completion Gate**
(`src/lib/discovery-completion.ts`) asks one more question: *is there host-recorded evidence
that exploration is unfinished?* If so, nothing is written and the agent receives numbered
reasons, each with a stable code, and continues in the same conversation.

The evidence is the browser's own reports, read by the host interceptor as they pass — never
the model's reasoning. Every action result names the Playwright code it ran
(`getByRole('button', { name: 'Sign In' }).click()`) and nothing about the outcome; only
`browser_snapshot` shows the resulting page. So the host records each **state-changing action**
(a click on a button, link, tab or checkbox; Enter or Escape; a selection; a navigation) and
marks it verified at the next snapshot. Typing and focusing a field are not state-changing.

| Code | Rejected when |
|---|---|
| `UNVERIFIED_ACTION_OUTCOME` | A state-changing action has no snapshot after it: its result was never seen. |
| `UNVERIFIED_EXPLORED_LOCATION` | A location reported `EXPLORED` was never shown by a snapshot in this run. |
| `UNRESOLVED_AUTH_STATE` | A sign-in form was seen, no signed-in state was (a sign-out control, or the same route without the form), and no location is recorded `BLOCKED` with a reason. |
| `UNEXPLORED_REACHABLE_AREA` | A product state the run reached offers controls no exercised state offered, nothing was done there, and its location is not `BLOCKED`/`SKIPPED_WITH_REASON`. Links to other origins are left to the next rule. |
| `UNEXPLORED_RELEVANT_NAVIGATION` | A link absent before a state-changing action and present right after it, while the sign-in flow is unresolved, was never followed. On the product or a configured auxiliary origin it must be followed — `BLOCKED` is not accepted while it is reachable. On any other origin the agent is told not to follow it and to record `BLOCKED` naming the origin, and the run prints a hint to add it to `QA_DISCOVERY_AUX_ORIGINS`. It replaces `UNRESOLVED_AUTH_STATE` when both describe the same open flow. |

| `BLOCKED_WITHOUT_EVIDENCE` | The open sign-in flow is resolved `BLOCKED`, but no executed attempt at it shows the whole chain: input entered in that form, the action performed, its result inspected, and a visible change (a status/alert message, a control appearing or disappearing, a new link, a page change). A browser call that failed on its arguments is never recorded, so tool errors can never support `BLOCKED`. Success is not required — an application that visibly answers a real attempt with an error has blocked it. It replaces `UNRESOLVED_AUTH_STATE` when the only answer given was an unsupported `BLOCKED`. |

**Host-observed changes.** On the first snapshot after a state-changing action, the host
compares it with the previous one and appends a short, separately labelled block to the tool
result — never an edit to the browser's text: new links (with scope, token-free), new
status/alert messages, controls that appeared or disappeared, and a page change. Bounded to a
few lines; an action that changed nothing gets one line saying so. Controls are compared by
role and normalised name, so a list gaining rows is not a change. The same comparison, as
counts, is the "visible outcome" `BLOCKED_WITHOUT_EVIDENCE` requires.

**Newly exposed navigation.** Every link target a snapshot renders is recorded with its scope
(product, configured auxiliary, other) and, when it first appears in the snapshot right after a
state-changing action, the action that exposed it. Links on the entry page are the baseline and
are never "exposed", so a footer or social link never blocks anything; nor does a link that
appears when no flow is open. A target counts as followed once the session reaches it — for
another origin, anywhere on that origin. Only the location identity is stored (query values
dropped, opaque path segments redacted), so a one-time token in a continuation link never
reaches the surface, the run record or a trace.

What the gate never does: count. There is no minimum of behaviours, pages, observations or
tool calls — an application with one behaviour, observed, finalizes on the first attempt.
`BLOCKED` and `SKIPPED_WITH_REASON` with a reason are always acceptable answers; the gate only
refuses *silence* about something the browser showed.

Bounded: after 5 rejections in one agent attempt the gate tells the agent to stop and reply
BLOCKED, and the stage's existing bounded attempts take over. Exhaustion never turns a
rejection into a pass. Only runs whose orchestrator turned tracking on are gated
(`qa:manual`); every verdict is kept on the surface (`discovery-surface.json` →
`completion.attempts`), in `phase1-run.json`, and in the trace.

## Browser evidence the model does not supply

A snapshot says nothing about a console error, a 404 on a background image, or a request that
never completed. Asking the model to notice those makes evidence a matter of attention, and a
model asked "were there console errors?" can answer "no" without having looked.

So the host collects them. After Discovery passes, while the browser is still up, host code
opens its **own** session and replays the locations the artifact reports as `EXPLORED`,
recording console and network facts per page load into `discovery-evidence.json`.

It cannot read the agent's session: @playwright/mcp isolates sessions, so a second connection
sees an empty context — collecting there would report "no errors" as a fact. Flue also refuses
direct MCP invocation from host code, so the agent's connection cannot be borrowed.

`discovery-evidence` is in the **read** picklist and absent from the **write** picklist, so
`write_qa_artifact` rejects the name at its input schema before `run()` executes. A model may
interpret these facts; it cannot author, amend or contradict them.

Two limits travel with the artifact in its own `coverageNote`:

- **Page-load only** — an error raised only when a form is submitted is not captured.
- **The session is unauthenticated** — for a location behind a sign-in this describes what an
  anonymous visitor receives, which may be a logged-out view served under the same URL.

A finding at a URL carrying a one-time credential (`confirm_code`, `token`, `reset_token`, …)
is kept but marked `replaySuspect`, with a `replayCaveat` on the location: discovery spends
such a token, so replaying it produces a real failure that is an artifact of the replay.

## Analysis: no discovered behavior may vanish

The same rule as the surface, one stage later. A run once analysed fourteen of fifteen
behaviors and validated cleanly, because every statement it *did* write was well evidenced —
the dropped one was a suspected issue nothing objected to losing. Per-item checks cannot see
silence.

Every discovered behavior must be either cited as evidence by an acceptance point or business
rule, or listed in `excludedBehaviors` with a reason. A behavior that cannot become a
requirement — a suspected issue, or an `INFERRED` one — is excluded and raised as an open
question; that is what the error message tells the agent to do.

Acceptance points and business rules may carry `validationType`
(`UI | API | VISUAL | CONTRACT | MANUAL | UNKNOWN`). It is optional: omitting it means
undecided, `UNKNOWN` means considered and unsettled by the evidence. Stating a type the
evidence does not support is the failure mode being guarded against, not a missing field.

## Coverage: the other direction

Evidence validation asks *"is this test case supported?"*. That alone cannot make a suite
complete — a run once produced a handful of individually valid cases while leaving five
business rules untested, and nothing objected.

So each test case carries two distinct claims:

- **`evidenceIds`** — what supports it: acceptance point, business rule or behavior IDs;
- **`covers`** — which requirements it *demonstrates*: acceptance point and business rule IDs
  only, never a behavior and never an open question.

Every **testable requirement** must appear in some case's `covers`. Acceptance points and
business rules both count; open questions never do. A requirement is testable unless the
Behavior Analyst marked it `testable: false` with a `notTestableReason` — that judgement is
recorded in the artifact, not inferred by the host.

A `covers` claim must also be *true*, not merely present: the case must cite the requirement
itself, or a behavior that requirement rests on. Without that a case can list a requirement it
never exercises, and the count rises while nothing is tested. One case may cover several
requirements only when it genuinely shares their evidence.

Suite size follows from coverage. There is no minimum number of test cases anywhere.

The counts (`coverage` in `phase1-run.json`) are computed from the two artifacts, never taken
from a total the model reports about itself. Alongside them the host records the suite's
**scenario shape** — how many cases of each `type`, how many cover more than one requirement —
because complete coverage made entirely of happy paths is not a good suite, and a percentage
cannot say so.

## Coverage modes and test levels

A run is Automatic, UI only or API only (`src/lib/coverage-mode.ts`), and every test case states
`testLevel`: `UI` or `API`. The mode is written by the host to `run-config.json` and the API
documentation it read to `api-discovery.json`; every validation — an agent's write, a refresh, a
proposal applied from the workspace, the approval — reads both from disk
(`readCoverageContext`), so none of them depends on what a model was told. Tested in
`test/coverage-modes.test.ts` and `test/api-discovery.test.ts`.

**Documented operations are evidence, and the only API evidence.** `src/lib/api-discovery.ts`
parses the document deterministically and gives each operation an id (`API-1` …). A requirement
or a test case may cite one exactly as it cites a behavior, and its statement must say what that
operation declares. Anything else is refused:

- an `API-n` id the document does not contain, or any `API-n` id in UI-only mode or when there is
  no documentation → `UNKNOWN_EVIDENCE_ID`;
- a path the document does not declare, or a method it does not declare for that path
  (`PUT /notes` where only `GET` and `POST` exist) → `UNSUPPORTED_FACT`. A concrete path under a
  documented template (`/notes/42` for `/notes/{id}`) is supported.

**A level must be allowed by the mode and supported by the case's own evidence.**

| Rule | Code |
|---|---|
| UI only: no `API` case. API only: no `UI` case, and none without a level. | `TEST_LEVEL_OUT_OF_MODE` |
| An `API` case must cite a documented operation, directly or through a requirement that cites one. | `UNSUPPORTED_TEST_LEVEL` |
| A `UI` case may not rest only on documentation: something it cites must have been observed in the interface. | `UNSUPPORTED_TEST_LEVEL` |
| Automatic: two cases at different levels with the same `covers` and the same `types` are one scenario written twice. | `DUPLICATE_ACROSS_LEVELS` |
| An `API` case is not automated through `UI`, `UI_API` or `VISUAL`; a `UI` case not through `API` alone. | `CONTRADICTORY_STRATEGY` |

**Scope.** In API-only mode a requirement owes a test case only if it cites a documented
operation; one that rests on UI behavior alone is *out of scope* — reported as such in the
coverage counts, not as uncovered and not as untestable. UI only and Automatic leave nothing out.

**Unavailable documentation.** `api-discovery.json` then has status `UNAVAILABLE` with the
reason, and no operation is citable: Automatic degrades to UI-level cases, and API only does not
start.

**Backward compatibility.** A case with no `testLevel` is `UI`; a workspace with no
`run-config.json` is Automatic with no API documentation. A suite written before this feature
therefore validates exactly as it did, and a strategy chosen for a case that states no level is
never contradicted by a default it did not see.

## Live API validation: executed and checked, or not validated

`src/lib/api-validation.ts`, host code with no model in it, calls the documented API and writes
`api-validation.json`. Tested in `test/api-validation.test.ts` against a real HTTP server.

**Evidence classes are assigned by the host.** `DOCUMENTED` — declared, never called. `OBSERVED` —
a real response was captured. `VALIDATED` — a real response was captured, its status is one the
documentation declares, it is the kind of response the probe set out to check, and no check
failed; and no response of that operation contradicted the documentation. Nothing becomes
`VALIDATED` without a request that was actually sent. Each API-level test case carries
`apiEvidence`, set by the host on every write from the operations it rests on — a model's own
value is overwritten, so a documentation-only scenario is marked as one whether or not anyone
says so.

**Checks per response:** the status against the documented responses (exact code, `2XX` range,
`default`); the content type against the documented media types; a JSON body against the documented
schema (Ajv, with `$ref`s inlined and `nullable` / OpenAPI 3.0 bounds translated); response headers
the documentation marks required.

**Findings are classified by the host, and a model cannot upgrade them.**

| Finding | Classification |
|---|---|
| success status the documentation does not declare · body that breaks its schema or is not valid JSON · undeclared content type · missing required header · a secured operation answering without credentials · a body without its required fields accepted | `CONTRACT_VIOLATION` |
| any 5xx · a refusal the documentation does not list (typically an undocumented 401) · an unexpected rejection of a generated request · a timeout | `POTENTIAL_ISSUE` |

In defect analysis a documented operation is a `CONFIRMED` behavior, an executed probe an
`OBSERVED` one. Every probe with a contract violation must appear in a finding
(`UNANALYZED_SUSPECTED_ISSUE`), and a finding resting only on probes the host called potential
issues may not be `CONFIRMED_DEFECT` (`UNSUPPORTED_EXPECTED`). What a probe really returned may be
stated by a requirement or a test case citing that operation; an operation that was not called
has only its documentation.

**What may be sent** is policy, enforced before a request is built:

- only to the resolved base URL, whose host is the documentation's, the target's, or one in
  `QA_API_ALLOWED_HOSTS`; never to a link-local, metadata or unspecified address, including a
  name that resolves to one; redirects are recorded as the response and never followed;
- `GET` / `HEAD` / `OPTIONS` by default — but not one whose path or operation id names an action;
- anything else only when that exact operation (`METHOD /path`) was approved for the run and the
  documentation declares it; `PUT`, `PATCH` and `DELETE` only against a resource the run itself
  created; nothing state-changing at all in a production environment;
- within a request budget, with a timeout each, stopping on a `429` or repeated connection failures.

**Nothing sensitive is stored.** Credentials come from host configuration, are attached only to
requests for the base URL's origin, and are replaced in the stored request. Response bodies are
truncated and stored with the value of every secret-named field, and anything shaped like a JWT,
replaced; a cookie is recorded only as present.

**API discovery is independent of UI discovery.** It is host code with its own completion
criteria (`apiDiscoveryCompletion`): documentation read, at least one operation, every operation
called or skipped with a reason; a live observation is optional. None of them reads the discovery
surface, the observation ledger or the UI completion gate, and the UI gate reads nothing of the
API's. A run with no interface to explore — API only, or Automatic with no application URL that
answers — never starts a browser or Playwright MCP, needs no `TARGET_URL`, and gets a host-written,
empty `discovered-behavior.json`. A finding whose actual result is only a documented operation
has observed nothing (`UNOBSERVED_ACTUAL`): a documentation assumption is never a confirmed defect.

**Unavailable is a state.** A disallowed host, an unreachable API, a failed sign-in or missing
parameters never fail the run: the artifact says `UNAVAILABLE` / `PARTIAL` or names the skip
reason per operation, and everything not called stays `DOCUMENTED`.

## Automation strategy: only capabilities that were observed

Prioritization records four separate judgements, and none may be copied from another: test
priority (`P0`-`P3`), `executionMode`, `automationPriority`, and `automationStrategy`
(`UI | API | UI_API | VISUAL | MANUAL | UNKNOWN`). A `P0` case may be MANUAL; a HIGH-priority
automation may have an `UNKNOWN` strategy.

The strategy may not contradict the mode, and may not name a capability this run did not
observe. The host derives what was observed from upstream facts only — a requirement typed
`API`/`CONTRACT`/`VISUAL`, browser evidence that recorded real HTTP requests, or API
documentation the host itself read. A test case's own wording is not evidence that an API
exists, and in a UI-only run nothing is automated through one.

## Defects: expected must be supported, actual must be observed

`src/lib/defects.ts`, applied to every `defect-analysis` write, re-applied to every bug report
file at approval (so a person's edits are held to the same rules), and to every decision and edit
from the workspace or `qa:defects` — one service, `src/lib/defect-review.ts`, behind both —
edit before it is saved.

    SUPPORTED EXPECTED + OBSERVED ACTUAL + CLEAR CONTRADICTION = CONFIRMED_DEFECT
    INFERRED EXPECTED  + OBSERVED ACTUAL                        = POTENTIAL_DEFECT

A finding's `sourceBehaviorIds` are the **actual** side. Its expectation comes through
`sourceAcceptancePointIds` / `sourceBusinessRuleIds`, and the host derives its **expected
basis** from what those requirements rest on — the model's claim is never used:

| Basis | When |
|---|---|
| `CONFIRMED_REQUIREMENT` | a cited requirement rests on a CONFIRMED behavior (one the run was given) |
| `EVIDENCED_REQUIREMENT` | a cited requirement rests on an OBSERVED, non-suspected behavior that is **not** one of the actual behaviors |
| `INFERRED` | requirements are cited, but rest only on inference or on the actual behavior itself — that restates the actual, it does not contradict it |
| `NONE` | no requirement is cited |

`CONFIRMED_DEFECT` needs `CONFIRMED_REQUIREMENT` or `EVIDENCED_REQUIREMENT`. Every
CONFIRMED/POTENTIAL defect needs at least one OBSERVED behavior of the product (not only of a
trusted auxiliary origin), and `title`, `severity`, `steps`, `expected`, `actual`; the other
classifications carry none of those. `actual` must share content with the cited behaviors and
a supported `expected` with the cited requirements, and the two may not say the same thing.
All text is fact-checked like a test case: no route, quoted message, feature or credential
without an upstream mention.

**Duplicates.** Two defect findings are one when they cite the same OBSERVED behavior as their
actual, or when they concern the same area and their title + expected + actual overlap by at
least half their content words, compared canonically (so *log in*, *sign in* and
*authenticate* are the same word). The fix is one finding citing every behavior and test case.

**Completeness.** Every behavior discovery marked `suspectedIssue` must appear in some finding.

**Host-owned fields.** Summary, bug report ids (`BUG-001…` in finding order), expected basis,
the evidence list, the environment (target, `Chromium`) and priority (`UNASSIGNED`) are set by
the host. The analyzer's schema has no `priority` field; a bug report whose priority is not
`UNASSIGNED` must record that a person set it (`qa:defects -- edit --priority`).

**Files.** `bugs/<id>.json`, where the id must match `^BUG-[0-9]{3,}$` before it becomes a file
name. A write validates every report before touching any file, and removes reports the new
analysis no longer produces. Everything persisted passes the redaction layer, which also
replaces opaque path segments inside URLs quoted in prose.

What this cannot do: judge whether a contradiction is *real*. Word overlap proves the expected
and actual sides are about the right evidence, not that they conflict. That is why every
report goes in front of a person before approval.

## Review workspace: proposals are re-validated, never trusted

A change proposal from the workspace's QA agent is an input, not a result. Every time it is
shown and again when a person applies it, `src/review/test-case-changes.ts` recomputes:

- **Stale** — the SHA-256 of `test-cases.json` must equal the proposal's base hash. Otherwise:
  conflict, nothing written. Proposals are never rebased or merged.
- **Shape** — an update keeps its target's id; new cases get host-assigned ids above every id
  the suite or its review history has used (a deleted id is never reissued); the candidate
  suite must match `test-cases.schema.json`.
- **Evidence** — the candidate suite runs through the same semantic validation as a Test
  Designer write. A finding counts against the proposal when it is in a case the proposal
  changes, or suite-wide and not already present, so an unrelated problem cannot block a good
  change. `UNCOVERED_ACCEPTANCE_POINT` is reported as impact and accepted by applying.
- **Unresolved issues** — any entry disables Apply.

The proposal file itself is schema-checked when read; a hand-edited file is refused or
re-validated like any other. The write is `replaceTestCases`: redaction, schema, semantic
validation, then an atomic replace.

## Write boundaries: who may write what

Enforced by input schemas and fixed roots, before any code that could write runs:

- **One artifact per agent.** `write_qa_artifact` is built per agent from a picklist
  (`writeQaArtifactToolFor`); any other name is rejected at the tool's input schema. Host-only
  files — `discovery-evidence`, `api-discovery`, `api-validation`, `run-config`,
  `phase1-approval.json`, `automation-project-contract`, review workflow state — are in no agent's
  picklist. `api-discovery` and `api-validation` are readable by the agents; `run-config` is not
  even that. In API-only mode `discovered-behavior` is written by the host, empty.
- **No paths from a model.** Every root (`QA_ARTIFACT_ROOT`, `QA_TARGET_REPO_ROOT`,
  `QA_MCP_OUTPUT_ROOT`, test write/result roots) comes from host configuration, must be absolute
  and outside this project, and is checked at load time (`src/lib/trusted-roots.ts`). Repo tools
  accept repo-relative paths only and refuse `..` escapes and symlinks out.
- **The focused review agent** has two tools: read its one host-assigned request, submit a
  proposal for it. It holds no artifact write tool.
- **Freshness.** A stage passes only on an artifact written during that attempt; an artifact
  left by an earlier run cannot make a failed attempt look successful.

## Approval: bound to content, human-only

`approvePhase1()` (`src/lib/phase1-gate.ts`), behind both `npm run qa:approve` and the
workspace's button:

- records the SHA-256 of the exact bytes of the five Phase 1 artifacts and of every bug report
  — any later change, even whitespace, makes the approval stale and Phase 2 refuses, naming the
  file;
- re-runs schema and semantic validation first: structural codes (listed under
  [Phase 1 codes](#phase-1-codes)) can never be approved; other findings need
  `--accept-findings`, which only the terminal offers, and are recorded in the approval;
- excludes the advisory `test-cases-review.json`;
- is unreachable from agents: no tool can name the approval file.

Derived artifacts carry their own freshness: `phase1-dependencies.json` records the input hashes
prioritization and defect analysis were generated from, so a changed test case marks them STALE
with the specific reason.

## Workspace API: fixed operations only

`src/ui-server/server.ts` exposes fixed resources and operations. Every mutation takes a small
JSON body checked against a strict schema; ids are pattern-checked before use; no request can
name a path, file, artifact, command, script or agent (tested in `test/ui-server.test.ts`). A
non-GET request whose `Origin` does not match the host is refused — enforced in code, not yet
covered by a test. Errors never return a stack or a path.

## Run history: read-only, path-free, parameterised

`src/ui-server/runs-api.ts` and `src/history/` (tested in `test/runs-api.test.ts` and
`test/history.test.ts`):

- The Runs API is GET-only. A historical snapshot has no decision, edit, apply or approve route.
- An archived file is read from a run id (pattern-checked, and recorded) and an artifact type
  (a closed list): the host builds the file name, requires it in that run's artifact index, and
  resolves it with `resolveInsideRoot` (realpath). A stored `relative_path` is checked, never used.
- Every SQL value is a bound parameter; filters are closed lists or bounded strings; unknown query
  parameters are refused. Closed columns (run kind, status) also carry CHECK constraints.
- Everything stored passes the same redaction as artifacts and traces: targets lose credentials,
  query and fragment; error text keeps its first line only, with secrets and opaque ids removed.

## Run control: a typed request, never a command

`src/run-control/` and `src/ui-server/run-control-api.ts` (tested in `test/run-control.test.ts`):

- `POST /api/runs` takes a strict object — pipeline, target, model, fresh browser, and optionally
  coverage mode, API documentation URL, the live-validation switch, an API base URL and a list of
  approved operations; unknown keys (a command, an env, a path) are refused. `target` may be
  omitted only when the run has API documentation and is not UI only; the runner is then given an
  empty `TARGET_URL`, so the server's own cannot put a browser back into the run. An approval must match
  `METHOD /path`, is refused in a production environment, and is honoured by the runner only if the
  documentation declares that operation. API credentials are never part of a request: they exist
  only in the host's environment, and the page is told whether they are configured.
  Each picked value must be one the host configured; the runner receives the host's value, not the
  browser's string. The API documentation URL is the one typed value: it must be an http(s) URL
  without embedded credentials, at most 500 characters, is dropped in UI-only mode, and is only
  ever fetched by host code with GET. It is stored and shown without its query string.
- The RunController forks one fixed script with fixed flags (`--run-id` must match the run-id
  pattern, which the runner checks again) and sets exactly eight environment keys: `TARGET_URL`,
  `QA_MODEL`, `QA_FRESH_BROWSER`, `QA_COVERAGE_MODE`, `QA_API_DOCS_URL`, `QA_API_LIVE_VALIDATION`,
  `QA_API_BASE_URL`, `QA_API_APPROVED_OPERATIONS` (always set — empty when nothing was chosen — so
  the server's own environment can never supply a documentation URL or an approval).
- Cancel takes a run id only. It reaches the process this controller started (IPC, then its own
  process group) and the browser server that run reported owning — never a pid from a request.
- The run lock is the only concurrency control: a start is refused while any live process holds it.
- Every event passes `normalizeEvent`: a closed set of fields, bounded, each string redacted
  (URLs, `name=value` / `name: value` pairs with sensitive names, key-shaped strings, stack lines).
  Tool events are built from the tool's name and outcome only; arguments and results never reach them.

## Redaction

`src/lib/redaction.ts` normalises locations and removes secrets before anything is persisted:
query values and opaque path segments that look like one-time codes or tokens are replaced, in
URLs and in prose. Traces pass through `src/observability/content-policy.ts`, which also masks
the configured API keys and key-shaped strings. Location identity ignores query values, so one
flow reached twice is one location.

## Phase 1 codes

| Code | Rejects |
|---|---|
| `UNKNOWN_EVIDENCE_ID` | An ID that does not exist upstream |
| `MISSING_EVIDENCE` | A claim with an empty `evidenceIds` |
| `NOT_EVIDENCE` | Citing an open question, or resting only on suspected/inferred behavior |
| `EVIDENCE_MISMATCH` | Cited evidence sharing no content with the claim |
| `UNSUPPORTED_FACT` | A route, quoted UI string, exact error text, or product feature with no upstream mention |
| `FABRICATED_CREDENTIAL` | An email or a non-placeholder credential value |
| `CONTRADICTS_UPSTREAM` | Denying something observed, or a blanket no-effect claim against an observed effect |
| `UNKNOWN_TEST_CASE` | Referencing a test case that does not exist |
| `MISSING_PRIORITIZATION` | A test case with no entry — MANUAL ones included |
| `DUPLICATE_PRIORITIZATION` | Two entries for one test case |
| `INCONSISTENT_PRIORITY` | `MANUAL` + `HIGH`, or `AUTOMATION` + `NONE` |
| `SUMMARY_MISMATCH` | Review counts that disagree with the prioritization or the defect analysis; a host-owned defect field that disagrees with what the host computes |
| `INCONSISTENT_STATUS` | `APPROVED` with a blocker, or `CHANGES_REQUESTED` with nothing requested |
| `DUPLICATE_ID` / `UNKNOWN_AREA` | Repeated IDs; a behavior in an undeclared area |
| `MISSING_COVERAGE` | A test case whose `covers` is empty — it demonstrates no requirement. |
| `UNKNOWN_COVERAGE_ID` | A `covers` entry that is not a real acceptance point or business rule. |
| `UNCOVERED_ACCEPTANCE_POINT` | A testable requirement that no test case covers. The error names the ID. |
| `UNEXPLORED_LOCATION` | A location on the host-established surface with no terminal state in the artifact. |
| `UNACCOUNTED_LOCATION` | A page the artifact itself refers to — a route, a behavior, an observation — with no terminal state in `locations`. |
| `UNKNOWN_LOCATION` | A reported location outside the application's origin, or not a URL. |
| `UNKNOWN_OBSERVATION` | A behavior citing an observation ID the ledger does not contain. |
| `UNACCOUNTED_OBSERVATION` | A recorded observation that reaches no behavior and is not excluded with a reason. |
| `UNANALYZED_BEHAVIOR` | A discovered behavior neither cited as evidence nor excluded with a reason. |
| `UNKNOWN_BEHAVIOR_REFERENCE` | An `excludedBehaviors` ID that does not exist upstream, or is also cited as evidence. |
| `CONTRADICTORY_VALIDATION_TYPE` | `testable: false` together with a `UI`/`API`/`VISUAL`/`CONTRACT` validation type. |
| `COVERAGE_NOT_EVIDENCED` | A `covers` entry whose requirement's evidence the case never cites. |
| `CONTRADICTORY_STRATEGY` | An automation strategy that contradicts the execution mode. |
| `UNSUPPORTED_STRATEGY` | A strategy naming a capability (`API`, `UI_API`, `VISUAL`) this run did not observe. |
| `TEST_LEVEL_OUT_OF_MODE` | A test case whose level the run's coverage mode does not allow. |
| `UNSUPPORTED_TEST_LEVEL` | An `API` case citing no documented operation, or a `UI` case resting only on API documentation. |
| `DUPLICATE_ACROSS_LEVELS` | The same scenario — same `covers`, same `types` — written at both UI and API level. |
| `MISSING_UPSTREAM` / `UPSTREAM_INVALID` | An input artifact is absent, or no longer consistent with the current discovery. The agent is told it cannot fix this and must stop |
| `UNOBSERVED_ACTUAL` | A defect whose cited behaviors include nothing OBSERVED |
| `UNSUPPORTED_EXPECTED` | `CONFIRMED_DEFECT` whose expected basis is `INFERRED` or `NONE` |
| `INCOMPLETE_DEFECT` | A defect missing bug fields, a non-defect carrying them, expected equal to actual, or a bug report file missing or not in the analysis |
| `DUPLICATE_DEFECT` | Two findings describing the same mismatch |
| `UNANALYZED_SUSPECTED_ISSUE` | A `suspectedIssue` behavior no finding cites |
| `AUXILIARY_AS_PRODUCT` (defects) | A defect resting only on test-infrastructure behavior, or placing the bug on an auxiliary origin |

`qa:approve` treats the structural ones (`MISSING_UPSTREAM`, `UNKNOWN_TEST_CASE`,
`MISSING_PRIORITIZATION`, `DUPLICATE_PRIORITIZATION`, `INCONSISTENT_PRIORITY`,
`DUPLICATE_ID`) as never overridable. The rest can be accepted deliberately with
`--accept-findings`, and the accepted findings are recorded in the approval.

## Repo Analyzer codes

Same rule, pointed at a filesystem. Facts come from `src/lib/repo-evidence.ts`, which scans a
fixed list of directory names at the top level only, bounded at 400 entries.

| Code | Rejects |
|---|---|
| `UNKNOWN_PATH` | Any path the analysis names that is not in the repository |
| `BAD_PATH` | An absolute path, a `..` escape, or a file where a directory is required |
| `DUPLICATE_PATH` | The same directory described twice |
| `UNKNOWN_SCRIPT` / `UNKNOWN_DEPENDENCY` | A script or package not in the repository's `package.json` |
| `NOT_A_LITERAL` | A `baseURL` copied as source (`process.env.BASE_URL ?? …`) rather than a value |
| `EMPTY_ANALYSIS` | `layout` and `keyFiles` both empty |
| `UNEXPLORED_DIRECTORY` | A directory whose name says it holds automation that the analysis never describes |
| `UNINSPECTED_DIRECTORY` | A directory called testDir/pageObjects/fixtures/apiClients/testData/auth that names no real file inside itself — listing a directory is not reading one |

The last two have a deliberate escape hatch: naming the path in `unknowns` with a reason
satisfies both. A repository may hold something the agent cannot make sense of, and saying so
is an analysis; silently skipping it is not.

## What this does not guarantee

Validation proves the output is **supported**. It cannot prove it is **complete, correct or
useful**. Known gaps, all of which pass today:

- **Partial-overlap evidence.** A claim sharing words with its cited evidence passes even when
  it asserts something different.
- **Unquoted inventions.** Only *quoted* strings are checked, so a wrong button name or an
  invented number (`locks after 3 attempts`) passes.
- **Paraphrased contradictions.** Only negated existence and blanket no-effect are detected.
- **A closed feature vocabulary.** An invented feature outside the fixed list passes.
- **Prose is never fact-checked** — `purpose`, `rule`, `risks`, `unknowns`, and prioritization
  reasons are judgements, and checking them would reject reasonable wording.
- **Discovery depth behind a control the agent never uses.** The surface grows from every
  page the browser actually reaches, so signing in enlarges the job rather than completing it.
  What it cannot do is force the first step: a state reachable only by pressing a button the
  agent never presses is never rendered, never seen by the host, and so never joins the list.
  The completeness rule compounds exploration; it does not start it.
- **The completion gate reads English accessible names.** Sign-in and sign-out controls are
  recognised by name (`Sign in`, `Log out`, a `Password` field). An auth form it does not
  recognise is simply not gated on — the gate fails open, never closed.
- **The completion gate sees states, not intentions.** It cannot know that a feature exists
  until the browser shows it; a product title mentioning "Notes" is not evidence of a Notes
  area. It also cannot tell that an observation was recorded *before* the action it
  describes.
- **Depth.** Coverage is checked against the requirements that were *written down*. If the
  Behavior Analyst never derived a requirement, nothing demands a test for it — a thin
  discovery still yields a thin suite, honestly labelled as fully covered.
- **Coverage is a claim, not a proof.** The host checks that a case names a requirement, not
  that its steps genuinely exercise it. A case can over-claim.
- **Requirements-driven mode is unchecked.** With no discovery artifact there is no evidence
  set, so requirements-analysis semantic checks are skipped entirely.
- **Discovery notes are trusted.** They feed the contradiction check without a confidence
  field, so a wrong note forces downstream agreement.

The natural next step for the first four is a constrained model-based check — asking only
"does evidence X support claim Y" after the deterministic rules pass. That trades determinism
for coverage and has deliberately not been added.

```bash
npm test     # the validators, both gates, the workspace and the review workflow are covered directly
```
