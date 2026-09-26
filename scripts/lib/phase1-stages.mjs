// The Phase 1 stage list — a closed allowlist, shared by `qa:manual` (the whole
// sequence) and the dependency refresh (prioritization and defect analysis only),
// so both run exactly the same stage definitions.

export const STAGES = [
  {
    key: 'discovery',
    label: 'Product Discovery',
    agent: 'src/agents/product-discovery.ts',
    artifact: 'discovered-behavior',
    browser: true,
    message: 'Begin.',
    // Replaced at run time with the surface briefing, when there is one.
    withSurface: (brief, count) =>
      `Begin.\n\nThe browser found these same-origin locations on the entry page:\n\n${brief}\n\n` +
      `Account for every one before you write — visit it, or record it BLOCKED/SKIPPED_WITH_REASON with a reason. ` +
      `The list grows as you go: a page you reach that is not on it, and the links that page renders, are ` +
      `added to it.` +
      (count <= 1
        ? ` This list is short because the entry page exposes few links; most of this application's ` +
          `surface is reached by USING it — signing in, submitting forms, opening panels. Accounting for ` +
          `this one location is the start of your job, not the end of it: work through the controls you ` +
          `can see and record what each one actually does.`
        : ''),
  },
  {
    key: 'analysis',
    label: 'Behavior Analyst',
    agent: 'src/agents/behavior-analyst.ts',
    artifact: 'requirements-analysis',
    message: 'Read the discovered-behavior artifact and write the requirements-analysis artifact.',
  },
  {
    key: 'design',
    label: 'Test Designer',
    agent: 'src/agents/test-designer.ts',
    artifact: 'test-cases',
    message: 'Read the requirements-analysis and discovered-behavior artifacts and write the test-cases artifact.',
  },
  {
    key: 'prioritization',
    label: 'Automation Prioritizer',
    agent: 'src/agents/automation-prioritizer.ts',
    artifact: 'automation-prioritization',
    message: 'Read the test-cases artifact and write the automation-prioritization artifact.',
  },
  {
    key: 'defects',
    label: 'Defect Analyzer',
    agent: 'src/agents/defect-analyzer.ts',
    artifact: 'defect-analysis',
    message:
      'Read the discovered-behavior, requirements-analysis and test-cases artifacts and write the defect-analysis artifact.',
  },
];
