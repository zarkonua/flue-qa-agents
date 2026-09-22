---
name: project-rules
description: Product-specific verified rules for this project (domains, roles, data rules). Use once populated for the actual target product; this is a template until then.
license: MIT
---

# Project Rules — TEMPLATE

This file is product-specific and should be filled from verified evidence.

Do not put generic QA guidance here.

## Domains
Example:
- Authentication
- Booking
- Payments
- Admin

## Rules
For each rule include:
- id
- statement
- source
- status: CONFIRMED / OBSERVED / INFERRED
- lastVerified

## Roles / permissions
List verified capabilities and restrictions.

## Data rules
- allowed environments
- test accounts
- seed/reset mechanisms
- cleanup restrictions
- forbidden production data

## External dependencies
List integrations and test/sandbox behavior.

## Unknowns
Keep unresolved product questions explicit.
