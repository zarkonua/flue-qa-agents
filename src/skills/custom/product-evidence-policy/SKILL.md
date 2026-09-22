---
name: product-evidence-policy
description: Evidence classification rules (CONFIRMED/OBSERVED/INFERRED) for product behavior discovered from an incomplete or undocumented product. Use whenever requirements are incomplete or behavior is discovered from the running system.
license: MIT
---

# Product Evidence Policy

Use this whenever requirements are incomplete or product behavior is discovered from the running system.

## Evidence states
Every behavior must be classified as:

- CONFIRMED — backed by explicit verified requirement/business rule
- OBSERVED — seen in current product/API/source implementation
- INFERRED — reasoned from domain conventions or incomplete evidence

## Core rule
OBSERVED does not mean CORRECT.

A current product bug must not become an expected result simply because the agent observed it.

## Suspicious behavior
If observed behavior conflicts with:
- another verified rule
- API validation
- source-code constraints
- obvious state invariant
- basic domain consistency

record:
- observed behavior
- evidence
- suspected issue
- open question

Do not silently normalize it.

## Test-design gate
Initial UI test cases for an undocumented product require:
- browser-backed discovery, or
- equivalent concrete evidence supplied by the user.

Do not create detailed expected UI behavior from a short feature name alone.

## Traceability
Every acceptance point and test case should be traceable to:
- requirement ID, or
- discovered behavior ID, or
- explicit project rule ID.

## Reading is not observing
Text that *describes* behaviour is not evidence that the behaviour occurs. A page saying
"Double-click a row to edit it" proves only that the hint exists.

- the hint's existence → OBSERVED
- the behaviour it describes → INFERRED, with an open question, and verification marked
  incomplete
- treat the text as CONFIRMED only when it qualifies as explicit product documentation under
  this policy — an in-page hint usually does not

It becomes OBSERVED behaviour only after the action was performed and the resulting state
change was seen.

## Do not assign semantics from appearance
A control with no accessible name — a bare `×`, an icon, an unlabelled button — must not be
given a verified purpose on the strength of how it looks or where it sits.

Record instead:
- an unnamed interactive control, described as it appears
- its likely purpose as INFERRED, low confidence
- an open question flagging the missing accessible name as an accessibility problem

Name it "delete", "close", or anything else only once the behaviour was verified, or a
stronger source (source code, documentation) supports it.

This targets unsupported inference only. A control that does expose a clear accessible name
(`button "Save"`, `checkbox "Remember me"`) should be described by that name directly —
do not be needlessly tentative about well-labelled controls.
