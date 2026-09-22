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
