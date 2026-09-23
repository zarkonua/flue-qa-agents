# Validation

What the deterministic checks guarantee before an artifact reaches disk — and what they do
not. The executable reference is `src/lib/semantic-validate.ts` and `test/*.test.ts`.

## Two layers, then the write

```text
agent calls write_qa_artifact(name, data)
   1. JSON Schema        schemas/<name>.schema.json      -> reject: shape errors
   2. semantic checks    evidence read by HOST code      -> reject: grouped errors
   3. write                                              -> only if both pass
```

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
pre-marked `SKIPPED`. The result is written to `discovery-surface.json` for the current run.

Every location on that surface must reach a terminal state in the artifact:

| Status | Means |
|---|---|
| `VISITED` | navigated there and snapshotted it |
| `UNREACHABLE` | tried and could not — a reason is required |
| `SKIPPED` | deliberately not followed — a reason is required |

A location the artifact never mentions is a rejected write. There is **no** minimum number of
behaviors: how much discovery is enough follows from the surface, not from the model's
judgement.

A same-origin location the agent reaches that was *not* on the host's list is accepted and
recorded — most applications only reveal their real surface after signing in. Only an
off-origin or malformed URL is rejected.

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

Suite size follows from coverage. There is no minimum number of test cases anywhere.

The counts (`coverage` in `phase1-run.json`) are computed from the two artifacts, never taken
from a total the model reports about itself.

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
| `SUMMARY_MISMATCH` | Review counts that disagree with the prioritization |
| `INCONSISTENT_STATUS` | `APPROVED` with a blocker, or `CHANGES_REQUESTED` with nothing requested |
| `DUPLICATE_ID` / `UNKNOWN_AREA` | Repeated IDs; a behavior in an undeclared area |
| `MISSING_COVERAGE` | A test case whose `covers` is empty — it demonstrates no requirement. |
| `UNKNOWN_COVERAGE_ID` | A `covers` entry that is not a real acceptance point or business rule. |
| `UNCOVERED_ACCEPTANCE_POINT` | A testable requirement that no test case covers. The error names the ID. |
| `UNEXPLORED_LOCATION` | A location on the host-established surface with no terminal state in the artifact. |
| `UNKNOWN_LOCATION` | A reported location outside the application's origin, or not a URL. |
| `MISSING_UPSTREAM` / `UPSTREAM_INVALID` | An input artifact is absent, or no longer consistent with the current discovery. The agent is told it cannot fix this and must stop |

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
- **Discovery depth beyond the entry page.** The surface is built from links on the entry
  page. An application whose navigation happens after sign-in, or through buttons rather than
  links, contributes only its entry page — the completeness rule then adds no pressure, and
  depth still rests on the agent's exploration.
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
