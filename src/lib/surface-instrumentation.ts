// Host-side surface tracking for Product Discovery.
//
// Discovery's completeness rule is "account for every location on the surface".
// Host code builds that surface once, from the links on the entry page — so an
// application whose landing page is a sign-in form yields a surface of exactly
// one location, and accounting for it is satisfied without ever seeing the
// product. Everything past the login is reached by *doing* something, which no
// entry-page parse can predict.
//
// This closes that hole: every browser tool result is read on the way back, and
// the page it lands on — plus the same-origin links that page renders — joins
// the surface the agent must account for. The rule the model already obeys then
// carries it past the login, instead of a paragraph of prose asking it to go.
//
// Why an execution interceptor rather than a wrapped tool: MCP tool definitions
// returned by `createMcpConnection` do not execute through their own `run` —
// Flue routes them through an internal adapter, and calling `run` throws
// "[flue] MCP tools execute through the internal adapter." Wrapping `run` is
// therefore dead code: the browser still works and the surface silently never
// grows, which is exactly the bug this file replaces. `instrument()` wraps the
// execution itself, so it sees MCP results the same as any other tool's.
//
// Read-only with respect to the agent: `next()`'s value is returned untouched,
// and a failure here never fails a browser call. The agent learns what it owes
// when `write_qa_artifact` rejects an unaccounted location — the same
// correction loop every other completeness rule already uses.
//
// Imported for its side effect by the agents that redraw the surface, in the
// same style as the provider registration. UI Explorer and Failure Analyzer
// work against a surface a discovery run already established; they do not
// import this.

import { instrument } from '@flue/runtime';
import { absorbBrowserResult, readSurface, writeSurface } from './discovery-surface.ts';

/** Tool names whose results describe a page. Flue namespaces MCP tools. */
function isBrowserTool(name: string): boolean {
  return name.includes('browser_');
}

/**
 * Whatever shape the tool returns, as text we can scan.
 *
 * Every string in the result, in order, joined by newlines. Deliberately not
 * `JSON.stringify`: that splices the envelope's own punctuation into the text,
 * so the snapshot's last `/url:` line ends up carrying `"}]}}` and the page is
 * recorded under a URL-encoded corruption of its path. Collecting the strings
 * themselves keeps each one, and its newlines, exactly as the server sent it.
 */
export function resultText(result: unknown): string {
  const parts: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    // Bounded: a tool result is a small envelope, and an unbounded walk over an
    // unknown shape is not something a browser call should pay for.
    if (depth > 8 || parts.length > 500) return;
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) visit(item, depth + 1);
  };
  visit(result, 0);
  return parts.join('\n');
}

/** Fold one browser result into the persisted surface. Never throws. */
export function absorbIntoSurface(result: unknown): string[] {
  try {
    const surface = readSurface();
    if (surface === undefined) return [];
    const text = resultText(result);
    if (text === '') return [];
    // Persist on any change, not only on an added location: an off-origin page
    // records an external origin and adds nothing, and a page found past the
    // cap bumps `overflow`. Writing only when `added` was non-empty dropped
    // both — the run then reported no external origins it had actually visited.
    const before = JSON.stringify(surface);
    const added = absorbBrowserResult(surface, text);
    if (JSON.stringify(surface) !== before) writeSurface(surface);
    return added.map((l) => l.url);
  } catch {
    // Bookkeeping must never cost the agent a browser call. A surface that
    // failed to grow degrades to the old behaviour; a failed navigation would
    // end the run.
    return [];
  }
}

let installed = false;

/**
 * Install the interceptor. Idempotent, so importing this module from more than
 * one place cannot double-count a result.
 */
export function trackDiscoverySurface(): void {
  if (installed) return;
  installed = true;
  instrument({
    observe: () => {},
    interceptor: async (operation, _ctx, next) => {
      const result = await next();
      if (operation.type === 'tool' && isBrowserTool(operation.toolName)) absorbIntoSurface(result);
      return result;
    },
    dispose: () => {},
  });
}

trackDiscoverySurface();
