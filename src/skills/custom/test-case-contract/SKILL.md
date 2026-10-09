---
name: test-case-contract
description: Required structure and writing rules for manual test cases (title, preconditions, steps, priority, evidenceIds). Use when writing test-cases.json.
license: MIT
---

# Test Case Contract

All manual/hybrid test cases must validate against:
`schemas/test-cases.schema.json`

## Required fields
- id
- title
- evidenceIds
- priority
- types
- preconditions
- testData
- steps
- expectedResult
- automationCandidate
- automationReason
- tags
- testLevel

## Test level
`testLevel` is `UI` or `API` — the level the case is exercised at. The run's coverage mode
(stated in your opening message) decides which values are allowed.

- `API`: steps are requests, expected results are responses. The case cites a documented API
  operation (`API-n`), or a requirement that cites one, and uses only what that operation declares.
- `UI`: steps act on the interface, expected results are what it shows. The case cites
  something observed in the interface.

Do not write the same scenario at both levels.

## Titles
Describe observable behavior.

Good:
`Booking is rejected when checkout precedes check-in`

Bad:
`Check booking`

## Preconditions
Contain only state required before the first action.

## Test data
Use semantic placeholders, not secrets or real production PII.

## Steps
Each step:
- one logical action/event
- one observable expected result

Avoid:
`Works correctly`

Prefer:
`Inline validation is displayed and the request is not submitted.`

## Priority
- P0: core business, data integrity, auth/permission, destructive or release-blocking
- P1: important primary path/high-risk failure
- P2: secondary behavior
- P3: low-risk edge/support behavior

Priority must be risk-based.

## Deduplication
Do not create separate cases for variations with identical behavior when data-driven/parameterized coverage is sufficient.

## Unknown behavior
If expected behavior is not evidenced:
- add an open question;
- do not invent the expected result.
