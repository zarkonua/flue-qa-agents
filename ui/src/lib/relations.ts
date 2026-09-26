// Bug <-> test case links. Only what an artifact states: a bug report names
// the test cases it came from (`sourceTestCaseIds`). Nothing is inferred from
// similar titles, shared words or shared areas.

export interface BugRow {
  id: string;
  relatedTestCaseIds: string[];
}

export function bugsForCase(bugs: BugRow[], caseId: string): string[] {
  return bugs.filter((b) => b.relatedTestCaseIds.includes(caseId)).map((b) => b.id);
}

export function casesForBug(bug: BugRow, activeCaseIds: ReadonlySet<string>): { id: string; active: boolean }[] {
  return bug.relatedTestCaseIds.map((id) => ({ id, active: activeCaseIds.has(id) }));
}
