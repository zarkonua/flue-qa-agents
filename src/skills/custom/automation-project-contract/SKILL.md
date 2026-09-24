---
name: automation-project-contract
description: Follow the target repository's verified conventions instead of inventing generic structure
---

# The repository has already been read for you

Before you were started, the Repo Analyzer read the target automation repository and the host
projected what it found into `automation-project-contract`. Read it with `read_qa_artifact`.

It tells you where tests live, what the framework config is, which directories hold page
objects, fixtures, helpers, API clients and test data, what conventions a new test must
follow, and which scripts actually exist.

## Use it instead of your defaults

You have seen thousands of automation repositories. This one is not those. A structure that is
idiomatic in general — `tests/`, a `page-objects/` folder, `test.describe` with a `beforeEach`,
importing `@playwright/test` directly — is **wrong here** unless this contract says otherwise.

- Put new files where `testRoot` and `locations` say, not where you would normally put them.
- Import what the conventions say to import. If a convention names a fixture module, use it;
  do not import the framework directly because that is what you usually do.
- Follow the naming, tagging and locator rules in `conventions`. Each one carries the file it
  was read from, so you can check it rather than trust it.
- Run things with the scripts in `scripts`. Every one was verified to exist in the
  repository's own `package.json`.

## Absent means nobody verified it — it does not mean "free choice"

Every field here was checked against the repository on disk. A path that was not there was
dropped, not guessed at. So:

- A **missing** field means the analysis could not establish it.
- `unknowns` lists what the analysis explicitly could not determine.

Neither is permission to invent. If you need something the contract does not give you — a
page-object base class it never found, an auth helper it never saw — record it as a blocker
and say what is missing. Do not create a convention and then follow it.

## Do not re-derive it

Do not go back to the repository to re-read structure the contract already states, and do not
contradict it from memory. If the contract and your instinct disagree, the contract is the
evidence and your instinct is not.

If the contract is absent entirely, the Repo Analyzer has not run. Say so and stop, rather
than proceeding on generic assumptions.
