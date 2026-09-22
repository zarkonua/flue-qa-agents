---
name: capability-security
description: Security rules for what tools/filesystem access an agent may be given, and why this system uses narrow tools instead of a general shell. Use when reasoning about what a tool call can and cannot touch.
license: MIT
---

# Capability Security Skill

Use this skill when assigning tools or filesystem access to an agent.

## Core rule
Give each agent only the capabilities required for its role.

Do not use unrestricted shell/filesystem access as a convenience substitute for narrow tools.

## Control plane separation
Runtime agents must not read or modify Claude Code's control/configuration files such as:
- `.claude/settings.json`
- `.claude/settings.local.json`
- permission rules
- runtime security configuration

These agents have no tool capable of reaching those files at all — it is not merely a rule
they are asked to follow.

## Working directory is not isolation
A configured `cwd` is only a starting directory.
It must not be treated as a filesystem security boundary.

## Prefer narrow tools
Examples:
- read_qa_artifact
- write_qa_artifact
- list_repo_directory
- search_repo
- read_repo_file
- write_test_file
- modify_test_file
- run_playwright_test
- run_typecheck
- read_test_results

## Trusted path roots
Paths must be checked against trusted host-configured roots.
The model must not choose arbitrary absolute roots — every tool call takes a logical
artifact/file name, never a filesystem path, and trusted host code resolves that name
against a fixed root.

## Browser access is not filesystem access
A browser tool lets an agent see and drive a page. It must not become a way to reach the
filesystem or run arbitrary code:

- arbitrary in-page JavaScript (`browser_evaluate`, `browser_run_code_unsafe`) is a general
  code-execution capability and is never mounted;
- file upload by local path (`browser_file_upload`) is a filesystem read and is not mounted
  by default;
- exploration agents get a browser and no repository write access; authoring agents get test
  writes and no interactive browser.

Cookies, tokens, and storage state are sensitive. Authenticated storage state must stay out
of source control and must use test accounts only.

## Execution is host-built, never model-supplied
An agent never supplies a shell command. It may ask for a named operation with at most a
validated relative path — `run_playwright_test(relativeTestPath?)`, `run_typecheck()` — and
trusted host code assembles the real argv and runs it without a shell.

## Default permissions
- browser tools: only for discovery/exploration/failure diagnosis agents
- repository read: only where needed
- repository write: automation generator and guarded failure repair only
- shell: disabled by default
- product source modification: disabled by default
- Claude Code config modification: always disabled for runtime agents
