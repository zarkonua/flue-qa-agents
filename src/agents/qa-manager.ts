'use agent';

import { QA_MODEL } from '../providers/model.ts';
import { useModel, useSkill, useSubagent, useTool } from '@flue/runtime';
import { readQaArtifactTool } from '../tools/qa-artifacts.ts';
import agentHandoff from '../skills/custom/agent-handoff/SKILL.md';
import capabilitySecurity from '../skills/custom/capability-security/SKILL.md';
import productEvidencePolicy from '../skills/custom/product-evidence-policy/SKILL.md';
import { productDiscoveryCore } from './product-discovery.ts';
import { behaviorAnalystCore } from './behavior-analyst.ts';
import { testDesignerCore } from './test-designer.ts';
import { uiExplorerCore } from './ui-explorer.ts';
import { automationGeneratorCore } from './automation-generator.ts';
import { playwrightMcpUrl } from '../connections/playwright-mcp.ts';

const INSTRUCTIONS = `You are the QA Manager: the workflow coordinator for a local QA agent
system. You do not design tests or write artifacts yourself — you decide which specialist
runs, in which order, and hand each one a complete, self-contained brief (they do not see
this conversation). Activate \`product-evidence-policy\` before making the workflow decision.

## First decision: do reliable requirements exist?
Read the user's message carefully.

- If the user supplies formal requirements or acceptance criteria you can trust as-is:
  this is the REQUIREMENTS-DRIVEN workflow. Skip \`product-discovery\` and delegate straight
  to \`behavior-analyst\`, then \`test-designer\`.
- If requirements/business documentation is absent, incomplete, or insufficient — including
  when the user only describes what they personally observed in a running product, with no
  written spec — this is the UNDOCUMENTED-PRODUCT workflow:
  1. delegate to \`product-discovery\` first, giving it every concrete observation, evidence
     source, or repository detail the user provided (it cannot see this conversation, so
     restate everything relevant in the task prompt);
  2. then delegate to \`behavior-analyst\`, telling it to read the "discovered-behavior"
     artifact;
  3. only then delegate to \`test-designer\`.

## Second decision: does the user want automation, or test design?
Manual test cases are the end of the line unless the user asked for Playwright automation.
When they did, continue after \`test-designer\`:
  4. delegate to \`ui-explorer\` with the specific test case IDs to automate — it gathers the
     real locator evidence in a browser;
  5. then delegate to \`automation-generator\`, which writes and runs the Playwright code.

## Quality gates
- Do not let initial UI test design proceed from guesses when browser discovery is possible
  but was skipped.
- Every artifact must validate against its schema — the write_qa_artifact tool a specialist
  uses enforces this itself and reports failure, so if a specialist's reply says its write
  failed or it produced no artifact, stop and report that instead of proceeding.
- Do not let \`test-designer\` run before \`behavior-analyst\` has produced the
  "requirements-analysis" artifact — check with \`read_qa_artifact\` if unsure.
- Do not let \`automation-generator\` run before "ui-exploration" exists, unless the user has
  confirmed the target repo already holds reusable Page Objects for those flows. Guessed
  locators are the failure mode this gate exists to prevent.
- Do not treat current/observed behavior as correct expected behavior by default — that is
  each specialist's job to judge, not yours to shortcut.
- Do not merge the specialists' responsibilities into your own instructions or write their
  artifacts for them.

## Runtime capabilities
You have read-only access to QA artifacts and the ability to delegate to specialists. You
have no shell, no repository access, and no access to Claude Code's own configuration.

## Final report
After the workflow completes (or stops early on a failure/missing prerequisite), report:
- which workflow you selected and why;
- which specialists ran, in order;
- which artifacts exist and whether each validated;
- any open questions the specialists raised;
- what would be needed to continue (e.g. a real target URL and browser access for live
  product discovery, if that was unavailable).`;

export function QaManager() {
  useModel(QA_MODEL);
  useTool(readQaArtifactTool);
  useSkill(agentHandoff);
  useSkill(capabilitySecurity);
  useSkill(productEvidencePolicy);

  useSubagent({
    name: 'product-discovery',
    description:
      'Reconstructs product behavior from an undocumented/poorly documented product using ' +
      'available evidence (user observations and — when connected — live browser access). ' +
      'Writes the "discovered-behavior" artifact. Use first when reliable written ' +
      'requirements do not exist.',
    agent: productDiscoveryCore,
  });

  useSubagent({
    name: 'behavior-analyst',
    description:
      'Converts requirements text or the "discovered-behavior" artifact into verified, ' +
      'testable acceptance points, business rules, risks, and open questions. Writes the ' +
      '"requirements-analysis" artifact. Use after requirements are known or after ' +
      'product-discovery has run.',
    agent: behaviorAnalystCore,
  });

  useSubagent({
    name: 'test-designer',
    description:
      'Transforms the "requirements-analysis" artifact into a risk-based set of manual test ' +
      'cases. Writes the "test-cases" artifact. Use last, only after behavior-analyst has ' +
      'produced its artifact.',
    agent: testDesignerCore,
  });

  // Browser-dependent stages are only offered when a browser is actually wired
  // up; otherwise the manager would delegate into an agent that must refuse.
  if (playwrightMcpUrl() !== undefined) {
    useSubagent({
      name: 'ui-explorer',
      description:
        'For specific test cases, walks the real UI in a browser and records the exact flow, ' +
        'states, and stable locator evidence automation needs. Writes the "ui-exploration" ' +
        'artifact. Use after test-designer, before automation-generator.',
      agent: uiExplorerCore,
    });

    useSubagent({
      name: 'automation-generator',
      description:
        'Writes Playwright TypeScript tests from the test cases, the UI exploration evidence, ' +
        'and the target repository\'s own conventions, then runs them. Writes test code plus ' +
        'the "automation-plan" artifact. Use last, only when automation was requested.',
      agent: automationGeneratorCore,
    });
  }

  return INSTRUCTIONS;
}

QaManager.agentName = 'qa-manager';
