# Bad run — 2026-09-21, target http://localhost:4444/

Verbatim copies of the three artifacts from an `npm run qa` run whose downstream stages
introduced unsupported facts. They are the regression baseline for
`src/lib/semantic-validate.ts` — do not "fix" them.

- `discovered-behavior.json` — mostly grounded. Observed a login form with username/password
  fields, a disabled Login button with no credentials, an error for invalid credentials.
- `requirements-analysis.json` — mismatched evidence (AC-2 "username textbox accepts input"
  cites BEH-2 "error for invalid credentials"), and asserts a *missing password field*,
  contradicting discovery. Note: written 17 minutes **before** this discovery file, i.e.
  against an earlier discovery run — the exact staleness `UPSTREAM_INVALID` exists to catch.
- `test-cases.json` — invented evidence IDs `RA001`–`RA003`, routes `/login` and `/dashboard`,
  credentials `user@example.com` / `Passw0rd!` / `wrongpassword`, error text
  `'Invalid credentials'`, and an entire password-reset flow.
