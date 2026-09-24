// Phase 1 review UI. Plain ES modules, no build step.
//
// The server hands over one assembled view model; everything here is rendering
// and client-side filtering. This file never fetches an artifact by name, never
// constructs a path, and never posts anything but the two fixed actions.

const app = document.getElementById('app');
const state = { model: null, root: '', priority: 'ALL', mode: 'ALL', ap: 'ALL', strategy: 'ALL', tab: 'cases', query: '', busy: false, flash: null };

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function load() {
  const res = await fetch('/api/review');
  const body = await res.json();
  state.model = body.model;
  state.root = body.artifactRoot ?? '';
  render();
}

async function post(path) {
  state.busy = true;
  render();
  try {
    const res = await fetch(path, { method: 'POST' });
    return { status: res.status, body: await res.json() };
  } finally {
    state.busy = false;
  }
}

async function approve() {
  const { body } = await post('/api/approve');
  state.flash = body.ok
    ? { kind: 'ok', title: 'Phase 1 approved', detail: `by ${body.approval.approvedBy} at ${body.approval.approvedAt}` }
    : { kind: 'bad', title: 'Not approved', reason: body.reason, ...body };
  await load();
}

async function reprioritize() {
  const { body } = await post('/api/reprioritize');
  state.flash = body.ok
    ? { kind: 'ok', title: 'Re-prioritized', detail: 'Stage 4 re-ran and the artifact re-validated.' }
    : { kind: 'bad', title: 'Re-prioritization failed', output: body.output };
  await load();
}

// ---------------------------------------------------------------------------

function visible() {
  const q = state.query.trim().toLowerCase();
  return state.model.testCases.filter((tc) => {
    if (state.priority !== 'ALL' && tc.priority !== state.priority) return false;
    if (state.mode !== 'ALL' && tc.executionMode !== state.mode) return false;
    if (state.ap !== 'ALL' && tc.automationPriority !== state.ap) return false;
    if (state.strategy !== 'ALL' && tc.automationStrategy !== state.strategy) return false;
    if (!q) return true;
    const hay = [
      tc.id, tc.title, tc.expectedResult, tc.automationReason, tc.prioritizationReason,
      tc.automationStrategy, tc.strategyReason,
      ...tc.types, ...tc.tags, ...tc.preconditions,
      ...tc.covers.map((c) => `${c.id} ${c.statement ?? ''}`),
      ...tc.evidenceIds,
      ...tc.steps.flatMap((s) => [s.action, s.expected]),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

const chip = (label, key, value, current) =>
  `<button class="chip" data-filter="${key}" data-value="${esc(value)}" aria-pressed="${current === value}">${esc(label)}</button>`;

function summaryPanels(m) {
  const c = m.counts;
  const prio = ['P0', 'P1', 'P2', 'P3'].filter((p) => m.priorityCounts[p]);
  const cov = m.coverage;
  return `
    <div class="summary">
      <div class="panel">
        <h3>Test cases</h3>
        <div class="big">${m.testCases.length}</div>
        ${m.feature ? `<div class="detail" style="color:var(--muted);font-size:.82rem">${esc(m.feature)}</div>` : ''}
      </div>
      <div class="panel">
        <h3>Product priority</h3>
        <div class="rows">${prio.length
          ? prio.map((p) => `<b>${p}</b><span class="v">${m.priorityCounts[p]}</span>`).join('')
          : '<span class="v">—</span>'}</div>
      </div>
      <div class="panel">
        <h3>Execution</h3>
        <div class="rows">${c
          ? `<b>AUTOMATION</b><span class="v">${c.automation}</span><b>MANUAL</b><span class="v">${c.manual}</span>`
          : '<span style="color:var(--muted)">not prioritized yet</span>'}</div>
      </div>
      <div class="panel">
        <h3>Automation priority</h3>
        <div class="rows">${c
          ? `<b>HIGH</b><span class="v">${c.automationHigh}</span><b>MEDIUM</b><span class="v">${c.automationMedium}</span><b>LOW</b><span class="v">${c.automationLow}</span><b>NONE</b><span class="v">${c.manual}</span>`
          : '<span style="color:var(--muted)">—</span>'}</div>
      </div>
      ${cov ? `
      <div class="panel">
        <h3>Requirement coverage</h3>
        <div class="big">${cov.covered} / ${cov.testable}</div>
        <div style="color:var(--muted);font-size:.82rem">
          ${cov.uncovered === 0 ? 'all testable requirements covered' : `${cov.uncovered} uncovered`}
          ${cov.exempt ? ` · ${cov.exempt} not testable` : ''}
        </div>
      </div>` : ''}
    </div>`;
}

function approvalPanel(m) {
  const a = m.approval;
  const canApprove = m.hasPhase1 && m.blocking.length === 0 && m.schemaErrors.length === 0 && m.findings.length === 0;
  const why = !m.hasPhase1 ? 'Phase 1 is incomplete'
    : m.schemaErrors.length ? 'artifacts fail their schema'
    : m.blocking.length ? 'structural problems cannot be approved'
    : m.findings.length ? 'semantic findings must be resolved first'
    : '';
  return `
    <div class="panel approval">
      <div>
        <h3>Approval</h3>
        <div class="state ${a.state}">${a.state === 'NONE' ? 'NOT APPROVED' : a.state === 'STALE' ? 'APPROVAL STALE' : 'APPROVED'}</div>
        ${a.approvedAt ? `<div class="detail">by ${esc(a.approvedBy)} at ${esc(a.approvedAt)}${a.acceptedFindings ? ` · ${a.acceptedFindings} accepted finding(s)` : ''}</div>` : ''}
        ${a.state === 'STALE' ? `<div class="detail">changed since approval: <code>${a.changed.map(esc).join(', ')}</code></div>` : ''}
      </div>
      <div class="spacer"></div>
      <button id="reprioritize" ${state.busy ? 'disabled' : ''} title="Re-runs stage 4 only — the same as npm run qa:prioritize. Takes a few minutes.">Re-prioritize</button>
      <button id="approve" class="primary" ${canApprove && !state.busy ? '' : 'disabled'} title="${esc(canApprove ? 'Identical to npm run qa:approve' : why)}">
        ${state.busy ? 'Working…' : a.state === 'APPROVED' ? 'Re-approve' : 'Approve Phase 1'}
      </button>
    </div>`;
}

function problems(m) {
  let html = '';
  if (m.schemaErrors.length) {
    html += `<div class="notice bad"><h3>Artifacts do not match their schema</h3><ul>${m.schemaErrors
      .flatMap((s) => s.errors.slice(0, 6).map((e) => `<li><code>${esc(s.artifact)}</code>: ${esc(e)}</li>`))
      .join('')}</ul><p>The data below is not shown while an artifact is invalid.</p></div>`;
  }
  if (m.blocking.length) {
    html += `<div class="notice bad"><h3>Structural problems — these can never be approved</h3><ul>${m.blocking
      .map((f) => `<li><code>${esc(f.artifact)}</code> <b>${esc(f.code)}</b> at <code>${esc(f.path)}</code>${f.value ? ` = <code>${esc(f.value)}</code>` : ''}${f.details ? `<br><span style="color:var(--muted)">${esc(f.details)}</span>` : ''}</li>`)
      .join('')}</ul></div>`;
  }
  if (m.findings.length) {
    html += `<div class="notice warn"><h3>${m.findings.length} semantic finding(s) block approval</h3><ul>${m.findings
      .slice(0, 12)
      .map((f) => `<li><code>${esc(f.artifact)}</code> <b>${esc(f.code)}</b>${f.value ? ` <code>${esc(f.value)}</code>` : ''}${f.details ? `<br><span style="color:var(--muted)">${esc(f.details)}</span>` : ''}</li>`)
      .join('')}</ul>${m.findings.length > 12 ? `<p>…and ${m.findings.length - 12} more.</p>` : ''}
      <p>If these come from your own deliberate edits, approve from the terminal with
      <code>npm run qa:approve -- --accept-findings</code>; that override is not available here on purpose.</p></div>`;
  }
  if (m.coverage && m.coverage.uncovered > 0) {
    html += `<div class="notice warn"><h3>${m.coverage.uncovered} requirement(s) have no test case</h3>
      <p><code>${m.coverage.uncoveredIds.map(esc).join(', ')}</code></p></div>`;
  }
  return html;
}

function caseCard(tc) {
  const ap = tc.automationPriority;
  return `
    <article class="card">
      <header>
        <span class="cid">${esc(tc.id)}</span>
        <span class="ctitle">${esc(tc.title)}</span>
        <span class="badges">
          <span class="badge b-${esc(tc.priority)}">${esc(tc.priority)}</span>
          ${tc.executionMode ? `<span class="badge b-${esc(tc.executionMode)}">${esc(tc.executionMode)}</span>` : ''}
          ${ap ? `<span class="badge b-ap">AUTO ${esc(ap)}</span>` : ''}
          ${tc.automationStrategy ? `<span class="badge b-strategy" title="${esc(tc.strategyReason ?? 'automation strategy')}">via ${esc(tc.automationStrategy)}</span>` : ''}
          ${tc.reviewIssues.length ? `<span class="badge b-issue">${tc.reviewIssues.length} review issue${tc.reviewIssues.length > 1 ? 's' : ''}</span>` : ''}
        </span>
      </header>

      <div class="meta">
        ${tc.covers.map((c) => `<span class="tag cover" title="${esc(c.statement ?? 'requirement')}">covers ${esc(c.id)}</span>`).join('')}
        ${tc.types.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
        ${tc.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}
      </div>

      ${tc.reviewIssues.map((i) => `<div class="case-issue"><span class="sev">${esc(i.severity)}</span>${esc(i.message)}</div>`).join('')}

      <details>
        <summary>Steps, data and evidence</summary>
        ${tc.preconditions.length ? `<div class="field"><div class="k">Preconditions</div><ul>${tc.preconditions.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
        ${tc.steps.length ? `<div class="field"><div class="k">Steps</div><ol>${tc.steps.map((s) => `<li>${esc(s.action)}<span class="exp">${esc(s.expected)}</span></li>`).join('')}</ol></div>` : ''}
        <div class="field"><div class="k">Expected result</div><p>${esc(tc.expectedResult)}</p></div>
        ${Object.keys(tc.testData).length ? `<div class="field"><div class="k">Test data</div><div class="kv">${Object.entries(tc.testData).map(([k, v]) => `<span class="k2">${esc(k)}</span><span>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span>`).join('')}</div></div>` : ''}
        ${tc.covers.length ? `<div class="field"><div class="k">Covers</div><ul>${tc.covers.map((c) => `<li><code>${esc(c.id)}</code> ${esc(c.statement ?? '')}</li>`).join('')}</ul></div>` : ''}
        <div class="field"><div class="k">Evidence</div><div class="meta">${tc.evidenceIds.map((e) => `<span class="tag evidence">${esc(e)}</span>`).join('') || '<span class="empty">none</span>'}</div></div>
        ${tc.prioritizationReason ? `<div class="field"><div class="k">Why this execution mode</div><p>${esc(tc.prioritizationReason)}${tc.blockingFactors?.length ? ` <span style="color:var(--muted)">(blocked by: ${tc.blockingFactors.map(esc).join(', ')})</span>` : ''}</p></div>` : ''}
        ${tc.automationReason ? `<div class="field"><div class="k">Designer's automation note</div><p>${esc(tc.automationReason)}</p></div>` : ''}
        ${tc.strategyReason ? `<div class="field"><div class="k">Why this automation strategy</div><p>${esc(tc.strategyReason)}</p></div>` : ''}
      </details>
    </article>`;
}

/** Strategy chips, shown only once the prioritizer has assigned any. */
function strategyChips(m) {
  const present = [...new Set(m.testCases.map((tc) => tc.automationStrategy).filter(Boolean))].sort();
  if (present.length === 0) return '';
  return `<span class="group-label">Strategy</span>${['ALL', ...present].map((s) => chip(s, 'strategy', s, state.strategy)).join('')}`;
}

/**
 * Coverage from the requirement's side.
 *
 * The cards answer "what does this case cover?". A reviewer's question is the
 * reverse — "is this requirement tested, and by what?" — and answering it from
 * the cards means reading all of them. Both views come from the same two
 * artifacts, so they cannot disagree.
 */
function requirementsSection(m) {
  if (!m.requirements.length) return '';
  const a = m.analysisCoverage;
  const row = (r) => {
    const uncovered = r.testable && r.coveredBy.length === 0;
    return `
      <tr class="${uncovered ? 'uncovered' : ''}">
        <td><code>${esc(r.id)}</code></td>
        <td>${esc(r.statement)}
          ${r.notTestableReason ? `<div class="why">not testable: ${esc(r.notTestableReason)}</div>` : ''}
          ${r.validationTypeReason ? `<div class="why">${esc(r.validationTypeReason)}</div>` : ''}</td>
        <td>${r.validationType ? `<span class="tag">${esc(r.validationType)}</span>` : '<span class="empty">—</span>'}</td>
        <td>${r.evidenceIds.map((e) => `<span class="tag evidence">${esc(e)}</span>`).join('') || '<span class="empty">—</span>'}</td>
        <td>${
          r.coveredBy.length
            ? r.coveredBy.map((id) => `<span class="tag cover">${esc(id)}</span>`).join('')
            : r.testable
              ? '<span class="badge b-issue">uncovered</span>'
              : '<span class="empty">exempt</span>'
        }</td>
      </tr>`;
  };
  return `
    <h2>Requirements</h2>
    ${a ? `<p class="sub">${a.analyzed} of ${a.behaviors} discovered behaviour(s) analysed${a.excluded ? `, ${a.excluded} excluded with a reason` : ''}${a.unaccounted ? ` — <strong>${a.unaccounted} unaccounted</strong>` : ''}. ${a.openQuestions} open question(s).</p>` : ''}
    ${m.scenarioDiversityNote ? `<div class="notice">${esc(m.scenarioDiversityNote)}</div>` : ''}
    <table class="reqs">
      <thead><tr><th>ID</th><th>Statement</th><th>Validation</th><th>Evidence</th><th>Covered by</th></tr></thead>
      <tbody>${m.requirements.map(row).join('')}</tbody>
    </table>`;
}

function reviewSection(m) {
  if (!m.review) return '';
  const r = m.review;
  return `
    <h2>AI review</h2>
    <div class="advisory">
      <span class="stamp">ADVISORY — NOT APPROVAL</span>
      <div><b>${esc(r.status)}</b>${r.olderThanTestCases ? ' <span style="color:var(--warn)">· older than the current test cases</span>' : ''}</div>
      ${r.issues.length ? `<table><thead><tr><th>Case</th><th>Severity</th><th>Issue</th></tr></thead><tbody>${r.issues
        .map((i) => `<tr><td><code>${esc(i.testCaseId)}</code></td><td>${esc(i.severity)}</td><td>${esc(i.message)}</td></tr>`)
        .join('')}</tbody></table>` : '<p class="empty">No issues raised.</p>'}
      ${r.suggestedChanges.length ? `<table><thead><tr><th>Case</th><th>Field</th><th>Suggested change</th></tr></thead><tbody>${r.suggestedChanges
        .map((s) => `<tr><td><code>${esc(s.testCaseId)}</code></td><td>${esc(s.field ?? '')}</td><td>${esc(s.change)}${s.rationale ? `<br><span style="color:var(--muted)">${esc(s.rationale)}</span>` : ''}</td></tr>`)
        .join('')}</tbody></table>` : ''}
      <p class="empty">Suggestions are not applied automatically. Edit <code>test-cases.json</code> yourself, then re-prioritize.</p>
    </div>`;
}

function flashNotice() {
  const f = state.flash;
  if (!f) return '';
  if (f.kind === 'ok') return `<div class="notice ok"><h3>${esc(f.title)}</h3><p>${esc(f.detail ?? '')}</p></div>`;
  const lines = [
    ...(f.missing ?? []).map((n) => `missing: ${n}`),
    ...(f.blocking ?? []).map((x) => `${x.artifact}: ${x.code} at ${x.path}`),
    ...(f.findings ?? []).map((x) => `${x.artifact}: ${x.code} at ${x.path}`),
  ];
  return `<div class="notice bad"><h3>${esc(f.title)}</h3>
    ${f.reason ? `<p>Reason: <b>${esc(f.reason)}</b></p>` : ''}
    ${lines.length ? `<ul>${lines.slice(0, 15).map((l) => `<li><code>${esc(l)}</code></li>`).join('')}</ul>` : ''}
    ${f.output ? `<pre>${esc(f.output)}</pre>` : ''}</div>`;
}

function render() {
  const m = state.model;
  if (!m) return;

  if (!m.hasPhase1 && m.testCases.length === 0) {
    app.innerHTML = `
      <h1>Phase 1 Review</h1>
      <p class="sub">Artifacts: <code>${esc(state.root)}</code></p>
      ${flashNotice()}
      <div class="notice warn">
        <h3>No Phase 1 artifacts found</h3>
        <p>Missing: <code>${m.missing.map(esc).join(', ') || 'everything'}</code></p>
        <p>Run:</p><pre>npm run qa:manual</pre>
      </div>
      ${problems(m)}`;
    return;
  }

  const shown = visible();
  app.innerHTML = `
    <h1>Phase 1 Review</h1>
    <p class="sub">Artifacts: <code>${esc(state.root)}</code></p>
    ${flashNotice()}
    ${summaryPanels(m)}
    <div class="summary" style="margin-top:12px">${approvalPanel(m)}</div>
    ${problems(m)}

    <h2>Test cases</h2>
    <div class="filters">
      <span class="group-label">Priority</span>
      ${['ALL', 'P0', 'P1', 'P2', 'P3'].map((p) => chip(p, 'priority', p, state.priority)).join('')}
      <span class="group-label">Execution</span>
      ${['ALL', 'AUTOMATION', 'MANUAL'].map((p) => chip(p, 'mode', p, state.mode)).join('')}
      <span class="group-label">Auto</span>
      ${['ALL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'].map((p) => chip(p, 'ap', p, state.ap)).join('')}
      ${strategyChips(m)}
      <input id="q" type="search" placeholder="Search id, title, steps, covers…" value="${esc(state.query)}">
      <span class="count">${shown.length} of ${m.testCases.length}</span>
    </div>
    <div class="cards">${shown.map(caseCard).join('') || '<p class="empty">No test case matches these filters.</p>'}</div>

    ${requirementsSection(m)}
    ${reviewSection(m)}
    <footer>Approving here calls the same host code as <code>npm run qa:approve</code>. Read-only otherwise.</footer>`;

  for (const el of app.querySelectorAll('[data-filter]')) {
    el.addEventListener('click', () => {
      state[el.dataset.filter] = el.dataset.value;
      render();
    });
  }
  const q = app.querySelector('#q');
  if (q) {
    q.addEventListener('input', () => {
      state.query = q.value;
      const at = q.selectionStart;
      render();
      const next = app.querySelector('#q');
      next.focus();
      next.setSelectionRange(at, at);
    });
  }
  app.querySelector('#approve')?.addEventListener('click', approve);
  app.querySelector('#reprioritize')?.addEventListener('click', reprioritize);
}

load().catch((error) => {
  app.innerHTML = `<div class="notice bad"><h3>Could not load the review data</h3><p>${esc(error.message)}</p></div>`;
});
