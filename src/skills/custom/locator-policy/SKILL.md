---
name: locator-policy
description: Locator selection priority, the evidence gate that must be satisfied before a UI test may be written, and what to do when no stable locator exists. Use whenever recording locator evidence or writing Playwright test code.
license: MIT
---

# Locator Policy

Use this skill whenever you record a locator as evidence or write one into test code.

## Priority order
Pick the highest strategy that identifies the element unambiguously:

1. role + accessible name — `getByRole('button', { name: 'Sign in' })`
2. label — `getByLabel('Email')`
3. test id — `getByTestId('checkout-submit')`
4. placeholder — `getByPlaceholder('Search orders')`
5. stable visible text — `getByText('Order confirmed')`
6. stable CSS — only when nothing above works

## Never use
- XPath, unless genuinely unavoidable
- generated/hashed CSS classes (`.css-1x2y3z`, `.MuiButton-root-347`)
- deep DOM chains (`div > div > span:nth-child(3)`)
- arbitrary `.first()` / `.nth(n)` used to paper over an ambiguous locator
- **invented selectors** — anything not observed in a real snapshot or read out of the repository

A locator that was not observed is a guess, and a guessed locator produces a test that fails
for the wrong reason.

## When no stable locator exists
Do not invent one, and do not fall back to a fragile chain silently. Instead:

1. record the element with `locatorStrategy: "unknown"` and low confidence;
2. record it as a discrepancy/open question;
3. recommend the concrete product fix — an accessible name, a label association, or a
   `data-testid` — naming the element.

Missing accessibility is a finding about the product, not an obstacle to route around.

## Evidence gate before writing a UI test
A final UI test may only be written when **one** of these holds:

- UI Explorer supplied real-browser evidence for that flow (`ui-exploration` artifact), or
- reliable reusable locators / Page Objects already exist in the target repo, found by
  searching it — cite the file paths.

If neither holds: stop, say which flow lacks evidence, and request exploration. Do not write
the test anyway with placeholder locators.

## Confidence
- `high` — observed directly in a snapshot, unambiguous, role/label/test-id based
- `medium` — observed, but the name may be dynamic or the element appears more than once
- `low` — inferred, CSS-based, or not directly confirmed
