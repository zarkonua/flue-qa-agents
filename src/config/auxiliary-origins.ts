// Trusted auxiliary origins: test infrastructure the product needs, but is not.
//
// A mailbox such as MailHog is the common case. An account cannot be confirmed
// without reading the mail, so a strict same-origin rule silently blocks every
// authenticated flow behind a confirmation step — and discovery finishes at the
// sign-up form having never seen the product.
//
// Host configuration only. The model is told which origins exist and what they
// may be used for; it can never nominate one, and an origin that is not
// configured stays blocked exactly as before. Kept out of `discovery-surface`
// on purpose: Product Discovery reads this to build its prompt, and must not
// import a module that can read or write the surface file.

import { envString } from './env.ts';

/**
 * Origins that are not the product but are part of its test infrastructure —
 * a MailHog inbox is the common case: an account cannot be confirmed without
 * reading the mail, so same-origin-only silently blocks every authenticated
 * flow behind a confirmation step.
 *
 * Host configuration only. The model never nominates a trusted origin, and an
 * origin that is not configured stays blocked exactly as before.
 *
 *     QA_DISCOVERY_AUX_ORIGINS="http://localhost:8025,http://localhost:1080"
 */
export function auxiliaryOrigins(): string[] {
  const raw = envString('QA_DISCOVERY_AUX_ORIGINS');
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (trimmed === '') continue;
    try {
      out.push(new URL(trimmed).origin);
    } catch {
      throw new Error(`QA_DISCOVERY_AUX_ORIGINS contains "${trimmed}", which is not a URL.`);
    }
  }
  return [...new Set(out)];
}

/**
 * The auxiliary origins this run may pass through, read from trusted host
 * configuration.
 *
 * Injected rather than asked for: the model cannot nominate a trusted origin,
 * and with none configured it is told so explicitly — otherwise a run blocked
 * at a confirmation step has no way to know whether the mailbox was withheld
 * or simply never existed.
 */
export function auxiliaryOriginsNote(target: string): string {
  const origins = auxiliaryOrigins();
  if (origins.length === 0) {
    return `\n\n## Trusted auxiliary origins\nNone are configured. Do not leave ${target}'s origin. ` +
      `If a flow cannot be completed without one — a confirmation mail, for example — record that location ` +
      `BLOCKED with reason POST_AUTH_DISCOVERY_BLOCKED and say which step needed it.`;
  }
  return `\n\n## Trusted auxiliary origins\n${origins.map((o) => `- ${o}`).join('\n')}\n\n` +
    `You may visit these ONLY when a product flow cannot continue without them — reading a confirmation ` +
    `link or code is the usual case. They are test infrastructure, NOT the product under test: take what ` +
    `the flow needs, return to the product immediately, and never describe them as product areas, features ` +
    `or behaviors. The host rejects an artifact that does. Any other origin remains off limits.`;
}
