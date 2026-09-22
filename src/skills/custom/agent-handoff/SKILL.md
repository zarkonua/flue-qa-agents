---
name: agent-handoff
description: Rules for how QA agents hand off structured .qa/*.json artifacts to each other. Use whenever writing or reading a .qa artifact, or deciding what counts as an open question.
license: MIT
---

# Agent Hand-off Contract

Agents communicate through compact structured artifacts.

## Undocumented product sequence
1. Product Discovery → `.qa/discovered-behavior.json`
2. Behavior Analyst → `.qa/requirements-analysis.json`
3. Test Designer → `.qa/test-cases.json`
4. Repo Analyzer → `.qa/repo-analysis.json`
5. UI Explorer → `.qa/ui-exploration.json`
6. Automation Generator → code + `.qa/automation-plan.json`
7. Reviewer → `.qa/review.json`
8. Failure Analyzer → `.qa/failures/<id>.json`

## Rules
- Validate JSON against the matching schema before handoff (the `write_qa_artifact` tool does this for you and refuses an invalid write).
- Preserve stable IDs.
- Include evidence/source IDs.
- Do not copy entire repository files into handoff artifacts.
- Keep artifacts compact for an 8192-token model.
- Record uncertainty explicitly.
- A generated artifact never overrides a higher-quality source.
