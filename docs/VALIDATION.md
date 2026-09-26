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
| `test-cases-review` | `test-cases` and `automation-prioritization` |
| `repo-analysis` | the target repository **on disk** |

The orchestrator repeats both layers from disk after each stage, and additionally requires the
file to have been written *during that attempt* — an artifact left by an earlier run can never
make a failed attempt look successful.

## Discovery: the surface must be accounted for

Product Discovery used to decide for itself when it had seen enough — its prompt said two or
three observed states was a complete artifact. Nothing downstream can recover from that: the
Behavior Analyst and Test Designer can only work with what was observed.

Host code now establishes the surface before the agent runs. The preflight snapshot of the
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

## Automation strategy: only capabilities that were observed

Prioritization records four separate judgements, and none may be copied from another: test
priority (`P0`-`P3`), `executionMode`, `automationPriority`, and `automationStrategy`
(`UI | API | UI_API | VISUAL | MANUAL | UNKNOWN`). A `P0` case may be MANUAL; a HIGH-priority
automation may have an `UNKNOWN` strategy.

The strategy may not contradict the mode, and may not name a capability this run did not
observe. The host derives what was observed from upstream facts only — a requirement typed
`API`/`CONTRACT`/`VISUAL`, or browser evidence that recorded real HTTP requests. A test
case's own wording is not evidence that an API exists.

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
analysis no longer produces. Everything persisted passes the redaction layer, which now also
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
- **Discovery depth behind a control the agent never uses.** The surface now grows from every
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
npm test     # 118 tests; the validators and both gates are covered directly
```
