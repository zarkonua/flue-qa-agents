// The Phase 2 stage list, and the closed allowlist that guards it.
//
// In its own module so it can be asserted directly by the tests rather than by
// reading the orchestrator's source: which agents Phase 2 may start is a
// security property, not an implementation detail.
//
// Today Phase 2 is one stage. UI Explorer and Automation Generator exist in
// src/agents/ but are NOT wired to any command: they have never run live, and
// wiring them is a separate, deliberate decision.

export const PHASE2_STAGES = [
  {
    key: 'repo-analyzer',
    label: 'Repo Analyzer',
    agent: 'src/agents/repo-analyzer.ts',
    artifact: 'repo-analysis',
    message:
      'Analyse the target automation repository and write the repo-analysis artifact. ' +
      'Start by listing the repository root.',
  },
];

/** The only agent modules `npm run qa:automation` may start. */
export const PHASE2_AGENTS = new Set(['src/agents/repo-analyzer.ts']);

/** Built, but deliberately not wired to any command yet. Never started from here. */
export const NOT_YET_WIRED = ['src/agents/ui-explorer.ts', 'src/agents/automation-generator.ts'];

/** Artifacts of the stages that are not wired yet. None may appear during a run. */
export const UNWIRED_ARTIFACTS = ['ui-exploration', 'automation-plan'];

/** Throws if the stage list ever names an agent Phase 2 is not allowed to start. */
export function assertWiredStages(stages = PHASE2_STAGES) {
  for (const stage of stages) {
    if (!PHASE2_AGENTS.has(stage.agent) || NOT_YET_WIRED.includes(stage.agent)) {
      throw new Error(`${stage.agent} is not a wired Phase 2 agent.`);
    }
  }
}
