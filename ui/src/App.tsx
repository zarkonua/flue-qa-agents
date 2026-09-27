import { NavLink, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api/client.ts';
import { Phase1Badge } from './components/Phase1Status.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { TestCasesPage } from './pages/TestCasesPage.tsx';
import { TestCasePage } from './pages/TestCasePage.tsx';
import { BugsPage } from './pages/BugsPage.tsx';
import { BugPage } from './pages/BugPage.tsx';
import { ReviewsPage } from './pages/ReviewsPage.tsx';
import { ReviewPage } from './pages/ReviewPage.tsx';
import { RunsPage } from './pages/RunsPage.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { RunArtifactPage, RunBugPage, RunBugsPage, RunTestCasesPage } from './pages/RunSnapshotPages.tsx';

export function App() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 5000 });
  const c = overview.data?.counts;
  return (
    <div className="shell">
      <header className="top">
        <strong className="brand">QA Workspace</strong>
        <nav>
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/test-cases">Test Cases{c ? ` (${c.testCases})` : ''}</NavLink>
          <NavLink to="/bugs">Bugs{c ? ` (${c.bugs})` : ''}</NavLink>
          <NavLink to="/reviews">Reviews{c ? ` (${c.pendingReviews})` : ''}</NavLink>
          <NavLink to="/runs">Runs</NavLink>
        </nav>
        {overview.data && <Phase1Badge phase1={overview.data.phase1} />}
      </header>
      <main>
        {overview.error && <p className="notice bad">Cannot reach the host: {(overview.error as Error).message}</p>}
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/test-cases" element={<TestCasesPage />} />
          <Route path="/test-cases/:id" element={<TestCasePage />} />
          <Route path="/bugs" element={<BugsPage />} />
          <Route path="/bugs/:id" element={<BugPage />} />
          <Route path="/reviews" element={<ReviewsPage />} />
          <Route path="/reviews/:id" element={<ReviewPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/runs/:id/test-cases" element={<RunTestCasesPage />} />
          <Route path="/runs/:id/bugs" element={<RunBugsPage />} />
          <Route path="/runs/:id/bugs/:bugId" element={<RunBugPage />} />
          <Route path="/runs/:id/artifacts/:type" element={<RunArtifactPage />} />
          <Route path="*" element={<p>Not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}
