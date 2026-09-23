# Semantic validation between artifacts

Schema validation proves an artifact has the right *shape*. It cannot tell whether the content
is true. On 2026-09-21 a run against `http://localhost:4444/` produced three schema-valid
artifacts where the downstream two invented evidence IDs, routes, credentials, error text, and
an entire password-reset flow, and asserted that a password field discovery had observed was
missing. This layer rejects that class of output before it is written.

Code: `src/lib/semantic-validate.ts` (pure, deterministic, no I/O); the approval gate applies the same rules in `src/lib/phase1-gate.ts`.
Wired in: `src/lib/qa-artifacts.ts` → `writeQaArtifact()`.
Tests: `test/semantic-validate.test.ts`, `test/phase1.test.ts` and `test/phase2.test.ts`;
fixtures in `test/fixtures/`.

```bash
npm test   # 104 tests — semantic-validate, phase1, phase2
```

---

## Where it runs

```text
agent calls write_qa_artifact(name, data)
        │
        ├─ 1. JSON schema          (schemas/*.schema.json)          -> reject: schema errors
        ├─ 2. semantic validation  (upstream artifacts read FROM DISK) -> reject: grouped errors
        └─ 3. write                                                  -> only if both pass
```

The upstream artifacts are loaded by host code, never supplied by the model, so an agent cannot
validate against evidence it made up. A rejected write changes nothing on disk — a previous good
artifact is never overwritten by a bad one. The agent receives the error report as the tool
result and retries; no human approval is involved.

| Writing | Checked against |
|---|---|
| `discovered-behavior` | itself (internal consistency) |
| `requirements-analysis` | `discovered-behavior` |
| `test-cases` | `requirements-analysis` + `discovered-behavior`, **and** re-checks that the requirements are still consistent with the current discovery |
| `automation-prioritization` | `test-cases` (coverage and consistency), plus hard facts against discovery and requirements |
| `test-cases-review` | `test-cases` and `automation-prioritization` |
| `repo-analysis` | the target repository **on disk** — not an upstream artifact |

---

## Rules

### Evidence references

| Code | Rejects |
|---|---|
| `UNKNOWN_EVIDENCE_ID` | An ID that does not exist upstream (`RA001`). Requirements must cite behavior IDs; tests may cite acceptance-point, business-rule, or behavior IDs. |
| `MISSING_EVIDENCE` | An acceptance point, rule, or test case with an empty `evidenceIds`. |
| `NOT_EVIDENCE` | Citing an open-question ID; or basing a requirement solely on behaviors that are `suspectedIssue: true`, or solely `INFERRED` (the evidence policy, enforced). |
| `EVIDENCE_MISMATCH` | The cited evidence shares **no content words** with the claim — e.g. "username textbox accepts input" citing "error shown for invalid credentials". |

### No new facts

Applies to statements, risks, titles, steps, preconditions, expected results, automation
reasons, and test data. **Not** to `openQuestions`, which is exactly where unknowns belong.

| Code | Rejects |
|---|---|
| `UNSUPPORTED_FACT` | A URL or route discovery never visited (`/login`, `/dashboard`). |
| | A quoted string absent from upstream evidence (`'Forgot password'`). |
| | A quoted string presented as **exact message text** (`error message 'Invalid credentials'`) unless discovery itself quoted that text. Describing an error is not recording its wording. |
| | A feature from a fixed vocabulary with no upstream mention: dashboard, password reset, email verification, lockout, new-device checks, MFA, captcha, remember-me, attempt limits, session timeout, SSO, registration, profile/settings, admin area. |
| `FABRICATED_CREDENTIAL` | Any email address not present upstream — in any field, including open questions. |
| | A non-placeholder value under a credential-like `testData` key (`password`, `email`, `user…`, `token`, …), and that same value anywhere else in the test. |
| | A quoted value following "password" / "pin" / "token". |

**Accepted placeholders:** `VALID_USERNAME`, `INVALID_PASSWORD` (UPPER_SNAKE), `<password>`,
`{{user}}`, `${PASSWORD}`, the empty string, and phrasing such as *"requires configured test
credentials"*.

### Contradictions

Checked against high-confidence `OBSERVED`/`CONFIRMED` behaviors **and** discovery's area notes.
Applies everywhere, including open questions.

| Code | Rejects |
|---|---|
| `CONTRADICTS_UPSTREAM` | Negated existence of something observed: *"missing password field"*, *"there is no login button"*, *"X is not present"*. Observed things are extracted as `<modifier> <ui-noun>` phrases — "username/password fields" yields both a username field and a password field. |
| | A blanket no-effect claim about an action discovery saw produce an effect: *"Sign In does not trigger authentication"* when an error for invalid credentials was observed. **Scoped claims pass**: *"does nothing when the credentials are empty"* is consistent with a disabled button. |

Sign in / log in / authentication are treated as one action; so are sign up / register.

### Phase 1 end state — prioritization and review

Added with the two-phase workflow. These are the invariants Phase 2 depends on, so `qa:approve`
treats the first four as structural and refuses to approve regardless of any override flag.

| Code | Rejects |
|---|---|
| `UNKNOWN_TEST_CASE` | A prioritization entry, review issue or suggested change naming a test case that does not exist. The reviewer may use the literal `SUITE` for a finding about the whole suite. |
| `MISSING_PRIORITIZATION` | A test case with no entry. Every case is classified — **MANUAL ones included; none may be dropped.** |
| `DUPLICATE_PRIORITIZATION` | More than one entry for the same test case. |
| `INCONSISTENT_PRIORITY` | `MANUAL` with `HIGH` automation priority, or `AUTOMATION` with `NONE`. |
| `SUMMARY_MISMATCH` | Review counts that do not equal the counts computed from the prioritization. The error states the correct numbers. |
| `INCONSISTENT_STATUS` | A review `APPROVED` while listing a BLOCKER or MAJOR issue, or `CHANGES_REQUESTED` with nothing requested. |

Two deliberate limits here:

- **Prioritization reasons are judgements, so only hard facts are checked** in them — invented
  routes and account emails. The feature vocabulary and quoted-text rules are *not* applied,
  because a sentence like "depends on the email confirmation flow" is a reasonable judgement
  about an observed flow that the fixed vocabulary would wrongly reject.
- **Review prose is not fact-checked at all.** A reviewer flagging an invented `/dashboard`
  necessarily has to mention `/dashboard`. The reviewer only proposes; a person decides.

`MANUAL` with `LOW` or `MEDIUM` is permitted: the rule forbids only `MANUAL` + `HIGH`. The
Prioritizer's prompt steers MANUAL cases to `NONE`.

### Phase 2 — repo-analysis

The same rule, pointed at a filesystem instead of an upstream artifact. Facts about the
repository are gathered by host code (`src/lib/repo-evidence.ts`) and handed to the pure
validator, so an agent cannot assert a path into existence.

| Code | Rejects |
|---|---|
| `UNKNOWN_PATH` | Any path the analysis names that is not in the repository — layout paths, `examples`, `keyFiles`, every `evidencePath`, and the Playwright/TypeScript config paths. `./tests` and `tests/` are the same path as `tests`. |
| `BAD_PATH` | An absolute path, a `..` escape, or a file where the field names a directory (`playwright.testDir`). |
| `DUPLICATE_PATH` | The same directory described twice in `layout`. |
| `UNKNOWN_SCRIPT` | A script name that is not in the repository's `package.json`. Skipped entirely when the repo has no `package.json`. |
| `UNKNOWN_DEPENDENCY` | A package that is in neither `dependencies` nor `devDependencies`. |
| `NOT_A_LITERAL` | A `playwright.baseURL` copied as source rather than a value — `process.env.BASE_URL ?? '…'`. Observed in the first live run. |
| `EMPTY_ANALYSIS` | `layout` and `keyFiles` both empty: an analysis that says nothing. |
| `UNEXPLORED_DIRECTORY` | A directory in the repository whose **name** says it holds automation (`tests`, `pages`, `fixtures`, `api`, `data`, `auth`, `helpers`, …) that the analysis never describes in `layout` or `keyFiles`, and never mentions in `unknowns`. |
| `UNINSPECTED_DIRECTORY` | A `layout` entry of kind `testDir`, `pageObjects`, `fixtures`, `apiClients`, `testData` or `auth` that names **no real file inside itself** — not in `examples`, not as a convention's `evidencePath`, not in `keyFiles`. Listing a directory is not reading one. |
| `MISSING_UPSTREAM` | The target repository does not exist. A host configuration problem; the agent is told it cannot fix it. |

Prose is **not** fact-checked here: `purpose`, `rule`, `risks` and `unknowns` are judgements
about code the agent did read, and the Phase 1 vocabulary rules would reject reasonable
wording. A path is checkable; an opinion about a directory is not.

### Completeness — proving it looked, not only that it was truthful

The first seven rules prove that what the analysis says is **true**. The last two prove it
**looked**, which is a different failure: the first live runs named only real paths and still
missed the repository's API client and test-data module entirely.

Both stay deterministic, and neither infers architecture:

- the directory list is a **fixed set of names** (`src/lib/repo-evidence.ts`), scanned at the
  top level only and bounded at 400 entries. It says a directory is *worth an opinion*, never
  what that directory *is* — the agent still assigns the `kind`;
- "did you inspect it" is answered by *"did you name a file inside it"*, checked against the
  filesystem. A file the agent never opened is one it cannot name a real path for.

**There is an escape hatch, by design.** Naming the directory in `unknowns` with a reason
satisfies both rules. A repository may genuinely contain a directory the agent cannot make
sense of; saying so is an analysis, silently skipping it is not.

### Integrity

| Code | Rejects |
|---|---|
| `DUPLICATE_ID` | Repeated IDs. |
| `UNKNOWN_AREA` | A discovery behavior in an area not declared in `areas`. |
| `MISSING_UPSTREAM` | Writing test cases before requirements-analysis exists. |
| `UPSTREAM_INVALID` | Writing test cases on top of a requirements-analysis that no longer validates against the current discovery. The bad run had exactly this: its requirements were written 17 minutes *before* the discovery on disk. The Test Designer is told it cannot fix this and must stop. |

---

## What the agent sees

Grouped by rule, one fix instruction per group, repeats collapsed. The bad run's test cases
produce 15 distinct problems in ~305 tokens:

```text
"test-cases" is schema-valid but not supported by upstream evidence, so nothing was written (15 problems):

UNKNOWN_EVIDENCE_ID — cite only IDs that exist upstream: AC-1, AC-2, BEH-1, BEH-2, BEH-3
  - testCases[0].evidenceIds[0] = "RA001"
  ...
FABRICATED_CREDENTIAL — replace with a placeholder: VALID_USERNAME, VALID_PASSWORD, INVALID_PASSWORD
  - testCases[0].preconditions[0] = "user@example.com"
  - testCases[0].steps[0].action = "Passw0rd!"
  ...
UNSUPPORTED_FACT — remove it, describe the outcome generically, or move it to openQuestions
  - testCases[0].steps[1].expected = "/dashboard"
  - testCases[2].steps[0].action = "Forgot password"
  ...
```

Everything fits in one report, so the agent can fix it all in a single retry rather than
finding problems one batch at a time.

---

## Verified live — 2026-09-21, `http://localhost:4444/`

A full `npm run qa` (exit 0, 14.4 min) produced three artifacts that pass schema and semantic
validation. The validator fired **twice** during the run, and both agents corrected themselves
with no human involved — recovered from Flue's run database:

| Agent | Tried to write | Rejected with | Final artifact |
|---|---|---|---|
| Behavior Analyst | a business rule citing `"Authentication notes"` as free-text evidence | `UNKNOWN_EVIDENCE_ID` | `businessRules: []` — the unsupported rule was dropped |
| Test Designer | a third test case citing `OQ-1`, the open question *"what happens after Sign Up?"* | `NOT_EVIDENCE` | 2 test cases; the unknown became open question `(OQ-1)` |

Against the bad run: every evidence ID resolves; no invented routes (the only one is the
visited `http://localhost:4444/`); credentials are `VALID_EMAIL` / `VALID_PASSWORD`; no
password-reset flow; no password-field contradiction. Each acceptance point restates exactly
what its cited behavior says.

**The trade-off is visible too.** Discovery recorded only two behaviors, so the chain now
produces two narrow test cases rather than five imaginative ones. Output depth is capped by
discovery depth — which is correct, but means discovery's thoroughness is now the thing that
limits test coverage.

## Known gaps — too fuzzy for deterministic rules

Each of these passes today. They are listed so nobody mistakes "validated" for "verified true".

1. **Partial-overlap evidence.** AC-1 in the bad run — *"Login button click must trigger
   authentication flow"* citing *"Login button is disabled with no credentials"* — shares
   "login button", so it passes. It asserts a different behavior from its evidence. Word
   overlap cannot see that.
2. **Unquoted invented names.** *"Click the Submit button"* when discovery calls it "Login"
   passes; only *quoted* strings are checked. Checking every noun phrase would drown real
   output in false positives.
3. **Unquoted exact text.** *"shows the Invalid credentials error"* passes because those words
   appear upstream. Only the quoted form is recognised as an exact-text claim.
4. **Paraphrased contradictions.** Only negated existence and blanket no-effect are detected.
   *"The Login button is enabled with no credentials"* against an observed *disabled* one
   passes; so does the bad run's speculative risk *"Authentication flow appears broken"*.
5. **Closed feature vocabulary.** An invented feature outside the list (*"export notes to
   PDF"*) passes the no-new-facts rule.
6. **Unquoted invented values.** *"locks after 3 attempts"* — the number is not checked.
7. **Requirements-driven mode is unchecked.** With no discovery artifact there is no evidence
   set, so requirements-analysis semantic checks are skipped entirely.
8. **Stale discovery in requirements-driven mode.** A discovery left over from an unrelated
   earlier run would be used as evidence. Clear `.qa/` between unrelated targets.
9. **Notes are trusted.** Discovery's area notes feed the contradiction check without a
   confidence field. If discovery wrote a wrong note, downstream is forced to agree with it.

10. **Repo analysis is faithful but not complete.** Every path is proved to exist, but
    nothing detects what the agent *failed* to look at. Both live runs missed an `api/`
    client and a `data/` test-data module that were present, and left `examples` empty for
    directories it had listed. Schema-valid and true is not the same as sufficient.

The natural next step for 1–5 is a constrained model-based check — an LLM asked only *"does
evidence X support claim Y: yes / no / partially"* — run after the deterministic rules pass.
That trades determinism for coverage and was deliberately not added yet.
