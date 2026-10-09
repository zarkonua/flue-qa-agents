// Cancellation of a running QA run, requested by the workspace's RunController.
//
// The controller forks the run with an IPC channel and sends { type: 'cancel' }.
// The run then stops the agent it is waiting on and ends at the next stage
// boundary as CANCELLED — archiving what it produced, closing its history, and
// releasing the lock and the browser on its ordinary way out. A run started
// from the terminal has no channel: Ctrl-C there stays INTERRUPTED.
//
// Only the parent that forked this process can send the message; nothing a
// browser sends reaches it except through the controller's own cancel().

import { stopActiveAgent } from './runtime.mjs';

let requested = false;
const listeners = new Set();

export const cancellation = {
  get requested() {
    return requested;
  },
  /** Called once, when cancellation is first requested. */
  onRequest(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function requestCancel() {
  if (requested) return;
  requested = true;
  stopActiveAgent();
  for (const fn of listeners) {
    try { fn(); } catch { /* a listener must not stop cancellation */ }
  }
}

if (typeof process.send === 'function') {
  process.on('message', (message) => {
    if (message && typeof message === 'object' && message.type === 'cancel') requestCancel();
  });
  // The channel must not keep a finished run alive.
  process.channel?.unref();
}

/** Tell the controller which resources this run owns, so it can clean them up if the run cannot. */
export function reportOwned(resources) {
  if (typeof process.send === 'function') {
    try { process.send({ type: 'owned', ...resources }); } catch { /* the controller is gone */ }
  }
}
