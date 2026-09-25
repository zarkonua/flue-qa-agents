// What a browser action did, read from the browser's own report of it.
//
// Every Playwright MCP action result carries the code it ran:
//
//     ### Ran Playwright code
//     ```js
//     await page.getByRole('button', { name: 'Sign In' }).click();
//     ```
//     ### Page
//     - Page URL: http://localhost:4444/
//
// and nothing else about the outcome — the page tree after the action is only
// a link to a file the agent cannot open. So after a click, the agent has *no*
// evidence of what happened until it takes a `browser_snapshot`. A measured
// run clicked, never looked, and finalized: the click's outcome is simply not
// in its context.
//
// This module classifies an action from that code, deterministically. It never
// reads the model's reasoning, and it does not treat every click alike: focusing
// a text field changes nothing worth verifying, submitting a form does.

/** Roles whose activation is expected to change what the product shows. */
const ACTIVATING_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'option',
  'treeitem',
]);

/** Keys whose press submits, confirms or dismisses. Tab and arrows only move focus. */
const ACTIVATING_KEYS = new Set(['enter', 'escape', 'space', ' ']);

export type ActionKind = 'navigate' | 'activate' | 'submit' | 'select' | 'toggle' | 'key';

export interface ClassifiedAction {
  kind: ActionKind;
  /** Role and accessible name of the element acted on, when the code names them. */
  role?: string;
  name?: string;
  /** For a navigation: where it went. */
  url?: string;
  /** Short, human-readable description for feedback: `click on button "Sign In"`. */
  label: string;
}

/** The `### Ran Playwright code` block of an MCP result, or ''. */
export function ranCode(text: string): string {
  const match = /###\s*Ran Playwright code\s*\n```[a-z]*\n([\s\S]*?)```/i.exec(text);
  return match ? match[1] : '';
}

/** Did the tool report an error instead of performing the action? */
export function isErrorResult(text: string): boolean {
  return /^\s*###\s*Error\b/m.test(text);
}

function unquote(raw: string): string {
  return raw.replace(/\\(['"`\\])/g, '$1');
}

/** Role and name from the first `getByRole('role', { name: 'Name' })` in a line. */
function roleTarget(line: string): { role?: string; name?: string } {
  const role = /getByRole\(\s*['"`]([a-z]+)['"`]/.exec(line)?.[1];
  const name = /name:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(line)?.[2];
  return { role, name: name === undefined ? undefined : unquote(name) };
}

function describe(verb: string, target: { role?: string; name?: string }): string {
  if (target.role && target.name) return `${verb} on ${target.role} "${target.name}"`;
  if (target.role) return `${verb} on a ${target.role}`;
  if (target.name) return `${verb} on "${target.name}"`;
  return `${verb} on an element`;
}

/**
 * The state-changing action a browser tool result reports, or undefined when
 * the call changed nothing worth verifying (a snapshot, typing into a field,
 * focusing an input) or did not happen at all (an error result).
 */
export function classifyBrowserAction(toolName: string, text: string): ClassifiedAction | undefined {
  const tool = toolName.replace(/^mcp__[a-z0-9_-]+__/i, '');
  if (tool === 'browser_snapshot') return undefined;
  if (isErrorResult(text)) return undefined;
  const code = ranCode(text);

  if (tool === 'browser_navigate') {
    const url = /page\.goto\(\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(code)?.[2];
    // A navigation lands on a page whose content the result does not show.
    return { kind: 'navigate', url: url && unquote(url), label: url ? `navigation to ${unquote(url)}` : 'a navigation' };
  }

  for (const line of code.split('\n')) {
    const target = roleTarget(line);
    if (/\.(dbl)?click\(/.test(line)) {
      // An element acted on through getByText/locator has no stated role;
      // treat it as activating rather than guess that it was harmless.
      if (target.role === undefined || ACTIVATING_ROLES.has(target.role)) {
        return { kind: 'activate', ...target, label: describe('click', target) };
      }
      continue; // clicking into a text field, a combobox: focus, not a transition
    }
    if (/\.selectOption\(/.test(line)) return { kind: 'select', ...target, label: describe('selection', target) };
    if (/\.(check|uncheck|setChecked)\(/.test(line)) return { kind: 'toggle', ...target, label: describe('toggle', target) };
    const pressed = /\.press\(\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(line)?.[2];
    if (pressed !== undefined && ACTIVATING_KEYS.has(pressed.toLowerCase())) {
      const onField = /getByRole|locator|getBy/.test(line);
      return onField
        ? { kind: 'submit', ...target, label: describe(`${pressed} key`, target) }
        : { kind: 'key', label: `${pressed} key` };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Authentication, as the page's own controls show it
// ---------------------------------------------------------------------------
//
// Accessible names, not model prose: `textbox "Password"`, `button "Sign In"`,
// `button "Log out"`. English-language patterns — a limitation stated in
// docs/VALIDATION.md, and one that fails safe: an unrecognised auth form is
// simply not gated on.

const SIGN_IN_NAME = /\b(sign|log)[\s-]?(in|on)\b|\bsign[\s-]?up\b|\bregister\b|\bcreate (an )?account\b/i;
const SIGN_OUT_NAME = /\b(sign|log)[\s-]?(out|off)\b/i;

export interface AuthSignals {
  /** A password field next to a sign-in / sign-up control. */
  authForm: boolean;
  /** A sign-out control: the strongest evidence of an authenticated session. */
  signOut: boolean;
  /** Any password field at all. */
  password: boolean;
  /** Any sign-in / sign-up control. */
  signIn: boolean;
}

/** Auth signals in one accessibility snapshot. */
export function authSignals(snapshot: string): AuthSignals {
  let password = false;
  let signIn = false;
  let signOut = false;
  for (const line of snapshot.split('\n')) {
    const match = /^\s*-\s*([a-z]+)(?:\s+"([^"]*)")?/.exec(line);
    if (!match) continue;
    const [, role, name = ''] = match;
    if (role === 'textbox' && /password/i.test(name)) password = true;
    if (role === 'button' || role === 'link' || role === 'menuitem') {
      if (SIGN_OUT_NAME.test(name)) signOut = true;
      else if (SIGN_IN_NAME.test(name)) signIn = true;
    }
  }
  return { authForm: password && signIn, signOut, password, signIn };
}

/** Is this action an attempt to sign in or register? */
export function isAuthAction(action: ClassifiedAction): boolean {
  return action.kind !== 'navigate' && !!action.name && SIGN_IN_NAME.test(action.name) && !SIGN_OUT_NAME.test(action.name);
}
