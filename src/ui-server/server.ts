// The host API behind the QA Review Workspace (`npm run qa:ui`).
//
// The browser gets fixed resources and fixed operations, never a file:
//
//   GET  /api/overview                          GET  /api/bugs, /api/bugs/:id
//   GET  /api/test-cases, /api/test-cases/:id   GET  /api/reviews, /api/reviews/:id
//   POST /api/reviews                           POST /api/reviews/:id/process
//   POST /api/proposals/:id/apply | reject | request-changes
//   POST /api/bugs/:id/accept | reject | downgrade | request-changes
//   POST /api/bugs/:id/edit/preview, /api/bugs/:id/edit
//   POST /api/phase1/refresh                    POST /api/phase1/approve
//
// Every mutation takes a small JSON body checked against a strict schema; ids
// are pattern-checked before use; nothing in a request names a path, an
// artifact, a command, a script or an agent. The canonical suite is changed
// only by `applyProposal`, after a person clicked Apply, and approval only by
// `approvePhase1` — the same function as `npm run qa:approve`.
//
// Bound to 127.0.0.1 by default; there is no login.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative, resolve } from 'node:path';
import * as v from 'valibot';
import {
  listBugReportIds,
  QA_ARTIFACT_ROOT,
  qaArtifactPath,
  readBugReport,
  readQaArtifact,
} from '../lib/qa-artifacts.ts';
import { approvePhase1, inspectPhase1 } from '../lib/phase1-gate.ts';
import { buildReviewModel } from '../lib/review-view.ts';
import { dependencyState } from '../lib/phase1-dependencies.ts';
import {
  bugReportSha256,
  decide,
  DefectReviewConflictError,
  DefectReviewError,
  edit as editBug,
  EDITABLE_BUG_FIELDS,
  previewEdit,
} from '../lib/defect-review.ts';
import { SemanticValidationError } from '../lib/qa-artifacts.ts';
import type { BugReport, DefectAnalysis } from '../lib/defects.ts';
import type {
  AutomationPrioritization,
  DiscoveredBehavior,
  RequirementsAnalysis,
  TestCases,
} from '../lib/semantic-validate.ts';
import {
  OPERATIONS,
  PROPOSAL_ID,
  REQUEST_ID,
  ReviewStoreError,
  type BugReviewEvent,
  type ChangeProposal,
  type ChangeRequest,
  type ReviewStore,
} from '../review/review-store.ts';
import {
  applyProposal,
  beginProcessing,
  createChangeRequest,
  finishProcessing,
  recoverInterrupted,
  rejectProposal,
  requestProposalChanges,
  ReviewConflictError,
  ReviewInputError,
  validateProposal,
  type Workspace,
} from '../review/test-case-changes.ts';

export const MAX_BODY_BYTES = 64 * 1024;
const CASE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const BUG_ID = /^BUG-[0-9]{3,}$/;

export interface UiServerOptions {
  store: ReviewStore;
  workspace: Workspace;
  /** Runs the review agent for a request. Injected so tests fake the model, never the host. */
  runReviewAgent: (request: ChangeRequest) => Promise<void>;
  /**
   * The dependency refresh (Automation Prioritizer, then Defect Analyzer). `start`
   * returns once it has begun; `status` is the persisted state of the last one.
   */
  refresh: { start: () => Promise<void>; status: () => RefreshStatus };
  /** Called after a person's bug decision or edit is written — for metrics. */
  onBugEvent?: (event: BugReviewEvent & { bugId: string }) => void | Promise<void>;
  /** Built UI directory; absent means the API alone. */
  uiDir?: string;
}

export interface RefreshStatus {
  status: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  stages?: { stage: string; passed: boolean; attempts: number }[];
  reconciliation?: unknown;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Request bodies — strict: an unknown key is an error, not ignored
// ---------------------------------------------------------------------------

const text = (max: number) => v.pipe(v.string(), v.maxLength(max));
const step = v.strictObject({ action: text(2000), expected: text(2000) });
const manualEdits = v.strictObject({
  title: v.optional(text(300)),
  priority: v.optional(v.picklist(['P0', 'P1', 'P2', 'P3'])),
  types: v.optional(v.pipe(v.array(text(40)), v.maxLength(12))),
  preconditions: v.optional(v.pipe(v.array(text(1000)), v.maxLength(30))),
  testData: v.optional(v.record(text(80), v.union([v.string(), v.number(), v.boolean()]))),
  steps: v.optional(v.pipe(v.array(step), v.maxLength(50))),
  expectedResult: v.optional(text(4000)),
  automationCandidate: v.optional(v.boolean()),
  automationReason: v.optional(text(2000)),
  tags: v.optional(v.pipe(v.array(text(60)), v.maxLength(20))),
});
const CreateReviewBody = v.strictObject({
  operation: v.picklist(OPERATIONS),
  targetTestCaseId: v.optional(v.pipe(v.string(), v.regex(CASE_ID))),
  humanComment: v.optional(text(4000)),
  manualEdits: v.optional(manualEdits),
});
const NoteBody = v.strictObject({ note: v.optional(text(4000)) });
const sha256 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const BugDecisionBody = v.strictObject({ note: v.optional(text(4000)), baseSha256: v.optional(sha256) });
const BugRequestChangesBody = v.strictObject({ note: v.pipe(text(4000), v.minLength(1)), baseSha256: v.optional(sha256) });
const bugChanges = v.strictObject({
  title: v.optional(v.pipe(text(300), v.minLength(1))),
  severity: v.optional(v.picklist(['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'TRIVIAL'])),
  priority: v.optional(v.picklist(['UNASSIGNED', 'P0', 'P1', 'P2', 'P3'])),
  steps: v.optional(v.pipe(v.array(text(2000)), v.minLength(1), v.maxLength(50))),
});
const BugPreviewBody = v.strictObject({ changes: bugChanges });
const BugEditBody = v.strictObject({ changes: bugChanges, baseSha256: sha256, note: v.optional(text(4000)) });
const RequiredNoteBody = v.strictObject({ note: v.pipe(text(4000), v.minLength(1)) });
const EmptyBody = v.strictObject({});

async function body<T>(req: IncomingMessage, schema: v.GenericSchema<unknown, T>): Promise<T> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'Send JSON (content-type: application/json).');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, `Request body is larger than ${MAX_BODY_BYTES} bytes.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `Request body is larger than ${MAX_BODY_BYTES} bytes.`);
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = size === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
  const result = v.safeParse(schema, parsed);
  if (!result.success) {
    const issue = result.issues[0];
    const where = issue.path?.map((p) => p.key).join('.') || 'body';
    throw new HttpError(400, `Invalid request at ${where}: ${issue.message}`);
  }
  return result.output;
}

function id(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) throw new HttpError(400, `Not a valid ${what} id.`);
  return value;
}

// ---------------------------------------------------------------------------
// Read models — assembled here, from artifacts and workflow state
// ---------------------------------------------------------------------------

const read = <T>(name: Parameters<typeof readQaArtifact>[0]) => {
  try {
    return readQaArtifact(name) as T | undefined;
  } catch {
    return undefined;
  }
};

function mtime(name: Parameters<typeof qaArtifactPath>[0]): number | undefined {
  const path = qaArtifactPath(name);
  return existsSync(path) ? statSync(path).mtimeMs : undefined;
}

/** The editable part of a bug report, for a before/after diff. */
function editableView(b: BugReport): Record<string, unknown> {
  return Object.fromEntries(EDITABLE_BUG_FIELDS.map((f) => [f, b[f]]));
}

/**
 * Phase 1 health: every artifact and whether it still matches what it was
 * derived from. Test cases are the source; prioritization and defect analysis
 * derive from them; the approval hashes everything, bug reports included.
 */
function phase1Health(ws: Workspace, allBugs: BugReport[], refresh: RefreshStatus) {
  const suite = ws.readTestCases();
  const p = read<AutomationPrioritization>('automation-prioritization');
  const analysis = read<DefectAnalysis>('defect-analysis');
  const prioritization = dependencyState('automation-prioritization');
  const defects = dependencyState('defect-analysis');
  const approval = buildReviewModel().approval;
  // The advisory review restates prioritization and defect counts; it is behind once any of them moved.
  const reviewTime = mtime('test-cases-review');
  const newest = Math.max(mtime('test-cases') ?? 0, mtime('automation-prioritization') ?? 0, mtime('defect-analysis') ?? 0);
  const changed = [...new Set([...prioritization.changedCases.modified, ...prioritization.changedCases.added, ...prioritization.changedCases.removed])];
  return {
    testCases: { state: suite ? 'CURRENT' : 'MISSING', count: suite?.testCases.length ?? 0 },
    prioritization: { ...prioritization, automationCandidates: p?.cases.filter((c) => c.executionMode === 'AUTOMATION').length ?? 0 },
    defectAnalysis: { ...defects, confirmed: analysis?.summary?.confirmed ?? 0, potential: analysis?.summary?.potential ?? 0 },
    review: { state: reviewTime === undefined ? 'MISSING' : reviewTime < newest ? 'STALE' : 'CURRENT' },
    approval,
    refresh,
    refreshNeeded: prioritization.state !== 'CURRENT' || defects.state !== 'CURRENT',
    // Bugs that name a test case the suite changed since defect analysis ran.
    bugsReferencingChangedCases: allBugs.filter((b) => (b.sourceTestCaseIds ?? []).some((t) => changed.includes(t))).map((b) => b.id),
    // Human decisions a regenerated defect analysis could supersede.
    decidedBugs: allBugs.filter((b) => b.review.decision !== 'PENDING').map((b) => b.id),
  };
}

function bugs(ws: Workspace): BugReport[] {
  try {
    return ws.listBugs ? ws.listBugs() : listBugReportIds().map((b) => readBugReport(b)).filter((b): b is BugReport => b !== undefined);
  } catch {
    return [];
  }
}

/** Explicit references only: a bug names the test cases it came from. Nothing is inferred. */
function bugsForCase(all: BugReport[], caseId: string): string[] {
  return all.filter((b) => (b.sourceTestCaseIds ?? []).includes(caseId)).map((b) => b.id);
}

const OPEN_STATUSES = new Set(['PENDING', 'PROCESSING', 'PROPOSAL_READY', 'CHANGES_REQUESTED', 'FAILED']);

async function openRequestFor(store: ReviewStore, caseId: string): Promise<ChangeRequest | undefined> {
  return (await store.listRequests()).filter((r) => r.targetTestCaseId === caseId && OPEN_STATUSES.has(r.status)).at(-1);
}

async function proposalView(ws: Workspace, p: ChangeProposal) {
  return { ...p, validation: p.status === 'READY' ? validateProposal(ws, p) : undefined };
}

// ---------------------------------------------------------------------------
// Static UI — a fixed file map built once; the URL can never name a file
// ---------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function staticFiles(dir: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!dir || !existsSync(dir)) return map;
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (TYPES[extname(f)]) map.set(`/${relative(dir, p).split('\\').join('/')}`, p);
    }
  };
  walk(resolve(dir));
  return map;
}

// ---------------------------------------------------------------------------

export async function createUiServer(options: UiServerOptions): Promise<Server> {
  const { store, workspace: ws } = options;
  await recoverInterrupted(store);
  const files = staticFiles(options.uiDir);
  const jobs = new Set<string>();
  const bugOptions = { via: 'ui' as const, store, onEvent: options.onBugEvent };

  const handlers: [string, RegExp, (m: RegExpExecArray, req: IncomingMessage) => Promise<[number, unknown]>][] = [
    ['GET', /^\/api\/overview$/, async () => {
      const state = inspectPhase1();
      const model = buildReviewModel();
      const suite = ws.readTestCases();
      const allBugs = bugs(ws);
      const requests = await store.listRequests();
      const analysis = read<DefectAnalysis>('defect-analysis');
      return [200, {
        artifactRoot: QA_ARTIFACT_ROOT,
        phase1: { ...model.approval, missing: state.missing, findings: state.findings.length, blocking: state.hard.length + state.schemaErrors.length },
        counts: {
          testCases: suite?.testCases.length ?? 0,
          pendingReviews: requests.filter((r) => OPEN_STATUSES.has(r.status)).length,
          bugs: allBugs.length,
          openBugs: allBugs.filter((b) => b.review.decision !== 'REJECTED').length,
          confirmedBugs: allBugs.filter((b) => b.status === 'CONFIRMED').length,
          potentialBugs: allBugs.filter((b) => b.status === 'POTENTIAL').length,
        },
        defectSummary: analysis?.summary ?? null,
        coverage: model.coverage ?? null,
        // Each requirement with the cases that cover it — the reverse traceability question.
        requirements: model.requirements.map((r) => ({ id: r.id, kind: r.kind, statement: r.statement, testable: r.testable, validationType: r.validationType ?? null, coveredBy: r.coveredBy })),
        health: phase1Health(ws, allBugs, options.refresh.status()),
      }];
    }],

    ['GET', /^\/api\/test-cases$/, async () => {
      const suite = ws.readTestCases();
      const p = read<AutomationPrioritization>('automation-prioritization');
      const allBugs = bugs(ws);
      const requests = await store.listRequests();
      const rows = (suite?.testCases ?? []).map((tc) => {
        const prio = p?.cases.find((c) => c.testCaseId === tc.id);
        const open = requests.filter((r) => r.targetTestCaseId === tc.id && OPEN_STATUSES.has(r.status)).at(-1);
        return {
          id: tc.id, title: tc.title, priority: tc.priority, types: tc.types ?? [], covers: tc.covers ?? [],
          evidenceIds: tc.evidenceIds ?? [], executionMode: prio?.executionMode, automationPriority: prio?.automationPriority,
          automationStrategy: prio?.automationStrategy ?? null, strategyReason: prio?.strategyReason ?? null,
          pendingReview: open ? { id: open.id, status: open.status, operation: open.operation } : null,
          relatedBugIds: bugsForCase(allBugs, tc.id),
        };
      });
      return [200, { testCases: rows }];
    }],

    ['GET', /^\/api\/test-cases\/([^/]+)$/, async (m) => {
      const caseId = id(decodeURIComponent(m[1]), CASE_ID, 'test case');
      const tc = ws.readTestCases()?.testCases.find((c) => c.id === caseId);
      if (!tc) throw new HttpError(404, `No active test case ${caseId}.`);
      const requirements = read<RequirementsAnalysis>('requirements-analysis');
      const discovery = read<DiscoveredBehavior>('discovered-behavior');
      const statements = new Map([...(requirements?.acceptancePoints ?? []), ...(requirements?.businessRules ?? [])].map((r) => [r.id, r.statement]));
      const behaviors = new Map((discovery?.behaviors ?? []).map((b) => [b.id, b]));
      const prio = read<AutomationPrioritization>('automation-prioritization')?.cases.find((c) => c.testCaseId === caseId);
      const reviews = (await store.listRequests()).filter((r) => r.targetTestCaseId === caseId);
      return [200, {
        testCase: tc,
        prioritization: prio ?? null,
        covers: (tc.covers ?? []).map((r) => ({ id: r, statement: statements.get(r) ?? null })),
        evidence: (tc.evidenceIds ?? []).map((b) => ({ id: b, statement: behaviors.get(b)?.statement ?? null, status: behaviors.get(b)?.status ?? null })),
        relatedBugIds: bugsForCase(bugs(ws), caseId),
        reviews: reviews.map((r) => ({ id: r.id, operation: r.operation, status: r.status, updatedAt: r.updatedAt })),
        openReviewId: (await openRequestFor(store, caseId))?.id ?? null,
      }];
    }],

    ['GET', /^\/api\/bugs$/, async () => {
      const suite = new Set((ws.readTestCases()?.testCases ?? []).map((tc) => tc.id));
      return [200, {
        bugs: bugs(ws).map((b) => ({
          id: b.id, title: b.title, status: b.status, severity: b.severity, priority: b.priority, area: b.area ?? null,
          decision: b.review.decision, relatedTestCaseIds: (b.sourceTestCaseIds ?? []).filter((t) => suite.has(t)),
        })),
      }];
    }],

    ['GET', /^\/api\/bugs\/([^/]+)$/, async (m) => {
      const bugId = id(decodeURIComponent(m[1]), BUG_ID, 'bug');
      const bug = bugs(ws).find((b) => b.id === bugId);
      if (!bug) throw new HttpError(404, `No bug report ${bugId}.`);
      const suite = new Set((ws.readTestCases()?.testCases ?? []).map((tc) => tc.id));
      const discovery = read<DiscoveredBehavior>('discovered-behavior');
      const requirements = read<RequirementsAnalysis>('requirements-analysis');
      const behaviors = new Map((discovery?.behaviors ?? []).map((b) => [b.id, b.statement]));
      const statements = new Map([...(requirements?.acceptancePoints ?? []), ...(requirements?.businessRules ?? [])].map((r) => [r.id, r.statement]));
      const finding = read<DefectAnalysis>('defect-analysis')?.findings.find((f) => f.id === bug.origin.findingId);
      return [200, {
        bug,
        sha256: bugReportSha256(bugId),
        classification: finding?.classification ?? null,
        history: await store.listBugReviewEvents(bugId),
        actions: { downgrade: bug.status === 'CONFIRMED' },
        relatedTestCases: (bug.sourceTestCaseIds ?? []).map((t) => ({ id: t, active: suite.has(t) })),
        behaviors: bug.sourceBehaviorIds.map((b) => ({ id: b, statement: behaviors.get(b) ?? null })),
        requirements: [...(bug.sourceAcceptancePointIds ?? []), ...(bug.sourceBusinessRuleIds ?? [])].map((r) => ({ id: r, statement: statements.get(r) ?? null })),
      }];
    }],

    ['GET', /^\/api\/reviews$/, async () => {
      const proposals = await store.listProposals();
      const requests = await store.listRequests();
      return [200, {
        reviews: await Promise.all(requests.map(async (r) => {
          const latest = proposals.find((p) => p.id === r.latestProposalId);
          return {
            id: r.id, operation: r.operation, targetTestCaseId: r.targetTestCaseId ?? null, status: r.status,
            humanComment: r.humanComment ?? null, updatedAt: r.updatedAt, error: r.error ?? null,
            processing: jobs.has(r.id),
            proposal: latest ? { id: latest.id, status: latest.status, validation: latest.status === 'READY' ? validateProposal(ws, latest).status : null } : null,
          };
        })),
      }];
    }],

    ['GET', /^\/api\/reviews\/([^/]+)$/, async (m) => {
      const reqId = id(decodeURIComponent(m[1]), REQUEST_ID, 'review');
      const r = await store.getRequest(reqId);
      if (!r) throw new HttpError(404, `No review ${reqId}.`);
      const proposals = await store.listProposals(reqId);
      const current = r.targetTestCaseId ? ws.readTestCases()?.testCases.find((tc) => tc.id === r.targetTestCaseId) ?? null : null;
      return [200, { request: { ...r, processing: jobs.has(r.id) }, currentCase: current, proposals: await Promise.all(proposals.map((p) => proposalView(ws, p))) }];
    }],

    ['POST', /^\/api\/reviews$/, async (_m, req) => {
      const input = await body(req, CreateReviewBody);
      const request = await createChangeRequest(store, ws, input);
      return [201, { request }];
    }],

    ['POST', /^\/api\/reviews\/([^/]+)\/process$/, async (m, req) => {
      await body(req, EmptyBody);
      const reqId = id(decodeURIComponent(m[1]), REQUEST_ID, 'review');
      if (jobs.has(reqId)) throw new HttpError(409, `Review ${reqId} is already being processed.`);
      // PROCESSING is recorded before the reply, so the page never sees a stale state.
      const started = await beginProcessing(store, reqId);
      jobs.add(reqId);
      // The agent runs after the reply; the page polls. The suite is not touched either way.
      finishProcessing(store, started, options.runReviewAgent)
        .catch((error) => console.error(`[qa:ui] processing ${reqId}:`, (error as Error).message))
        .finally(() => jobs.delete(reqId));
      return [202, { accepted: true, id: reqId }];
    }],

    ['POST', /^\/api\/proposals\/([^/]+)\/apply$/, async (m, req) => {
      await body(req, EmptyBody);
      const result = await applyProposal(store, ws, id(decodeURIComponent(m[1]), PROPOSAL_ID, 'proposal'));
      // What the change invalidated, from the artifact dependencies alone.
      const health = phase1Health(ws, bugs(ws), options.refresh.status());
      const affected = [
        ...(health.prioritization.state !== 'CURRENT' ? ['Automation prioritization'] : []),
        ...(health.defectAnalysis.state !== 'CURRENT' ? ['Defect analysis'] : []),
        ...(health.approval.state === 'STALE' ? ['Phase 1 approval'] : []),
      ];
      return [200, { ...result, affected, bugsReferencingChangedCases: health.bugsReferencingChangedCases, health }];
    }],

    ['POST', /^\/api\/proposals\/([^/]+)\/reject$/, async (m, req) => {
      const { note } = await body(req, NoteBody);
      return [200, { request: await rejectProposal(store, id(decodeURIComponent(m[1]), PROPOSAL_ID, 'proposal'), note) }];
    }],

    ['POST', /^\/api\/proposals\/([^/]+)\/request-changes$/, async (m, req) => {
      const { note } = await body(req, RequiredNoteBody);
      return [200, { request: await requestProposalChanges(store, id(decodeURIComponent(m[1]), PROPOSAL_ID, 'proposal'), note) }];
    }],

    ['POST', /^\/api\/phase1\/refresh$/, async (_m, req) => {
      await body(req, EmptyBody);
      if (options.refresh.status().status === 'RUNNING') throw new HttpError(409, 'A refresh is already running.');
      await options.refresh.start();
      return [202, { accepted: true }];
    }],

    // ---- bug decisions: the same trusted service as `npm run qa:defects` ----

    ['POST', /^\/api\/bugs\/([^/]+)\/(accept|reject|downgrade)$/, async (m, req) => {
      const { note, baseSha256 } = await body(req, BugDecisionBody);
      const bugId = id(decodeURIComponent(m[1]), BUG_ID, 'bug');
      const { bug, event } = await decide(bugId, m[2] as 'accept' | 'reject' | 'downgrade', { ...bugOptions, note, baseSha256 });
      return [200, { bug, event, sha256: bugReportSha256(bugId), phase1: buildReviewModel().approval }];
    }],

    ['POST', /^\/api\/bugs\/([^/]+)\/request-changes$/, async (m, req) => {
      const { note, baseSha256 } = await body(req, BugRequestChangesBody);
      const bugId = id(decodeURIComponent(m[1]), BUG_ID, 'bug');
      const { bug, event } = await decide(bugId, 'request-changes', { ...bugOptions, note, baseSha256 });
      return [200, { bug, event, sha256: bugReportSha256(bugId), phase1: buildReviewModel().approval }];
    }],

    ['POST', /^\/api\/bugs\/([^/]+)\/edit\/preview$/, async (m, req) => {
      const { changes } = await body(req, BugPreviewBody);
      const preview = previewEdit(id(decodeURIComponent(m[1]), BUG_ID, 'bug'), changes);
      return [200, {
        current: editableView(preview.current),
        next: editableView(preview.next),
        changedFields: preview.changedFields,
        problems: preview.problems,
        applicable: preview.problems.length === 0,
        baseSha256: preview.baseSha256,
      }];
    }],

    ['POST', /^\/api\/bugs\/([^/]+)\/edit$/, async (m, req) => {
      const { changes, baseSha256, note } = await body(req, BugEditBody);
      const bugId = id(decodeURIComponent(m[1]), BUG_ID, 'bug');
      const { bug, event } = await editBug(bugId, changes, { ...bugOptions, note, baseSha256 });
      return [200, { bug, event, sha256: bugReportSha256(bugId), phase1: buildReviewModel().approval }];
    }],

    ['POST', /^\/api\/phase1\/approve$/, async (_m, req) => {
      await body(req, EmptyBody);
      // Exactly `npm run qa:approve`. --accept-findings is deliberately not offered here.
      const result = approvePhase1();
      if (!result.ok) {
        return [409, { ok: false, reason: result.reason, missing: result.state.missing, blocking: [...result.state.hard, ...result.state.schemaErrors], findings: result.state.findings }];
      }
      return [200, { ok: true, approval: result.approval }];
    }],

    // The read model of the original review page, kept for the CLI-era consumers and tests.
    ['GET', /^\/api\/review$/, async () => [200, { ok: true, artifactRoot: QA_ARTIFACT_ROOT, model: buildReviewModel() }]],
  ];

  const send = (res: ServerResponse, status: number, payload: string | Buffer, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
    res.end(payload);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      // A page from another origin may not drive this API. Browsers send Origin
      // on cross-site requests; a local tool's own page matches the Host header.
      const origin = req.headers.origin;
      if (req.method !== 'GET' && origin !== undefined) {
        let host: string | undefined;
        try {
          host = new URL(origin).host;
        } catch {
          host = undefined;
        }
        if (host !== req.headers.host) return send(res, 403, JSON.stringify({ error: 'Cross-origin requests are refused.' }));
      }
      if (path.startsWith('/api/')) {
        for (const [method, pattern, handler] of handlers) {
          const m = pattern.exec(path);
          if (!m || req.method !== method) continue;
          const [status, payload] = await handler(m, req);
          return send(res, status, JSON.stringify(payload));
        }
        return send(res, 404, JSON.stringify({ error: 'Not found' }));
      }
      if (req.method !== 'GET') return send(res, 405, JSON.stringify({ error: 'Method not allowed' }));
      const file = files.get(path) ?? (extname(path) === '' ? files.get('/index.html') : undefined);
      if (file) return send(res, 200, readFileSync(file), TYPES[extname(file)]);
      if (files.size === 0) return send(res, 503, 'The workspace UI is not built. Start it with: npm run qa:ui', 'text/plain; charset=utf-8');
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, JSON.stringify({ error: error.message }));
      if (error instanceof ReviewInputError) return send(res, 400, JSON.stringify({ error: error.message }));
      if (error instanceof ReviewConflictError) return send(res, 409, JSON.stringify({ error: error.message }));
      // A review file that is malformed or was edited by hand is refused, never trusted.
      if (error instanceof ReviewStoreError) return send(res, 409, JSON.stringify({ error: error.message }));
      if (error instanceof DefectReviewConflictError) return send(res, 409, JSON.stringify({ error: error.message }));
      if (error instanceof DefectReviewError) return send(res, 400, JSON.stringify({ error: error.message }));
      if (error instanceof SemanticValidationError) return send(res, 409, JSON.stringify({ error: `Not saved — not supported by the evidence: ${error.message}` }));
      console.error(`[qa:ui] ${req.method} ${path}:`, error);
      // Never a stack or a path the browser did not already know.
      return send(res, 500, JSON.stringify({ error: 'Internal error — see the terminal running npm run qa:ui.' }));
    }
  });
}
