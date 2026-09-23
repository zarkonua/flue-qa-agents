// One orchestrated agent stage: run it, then prove from disk that it worked.
//
// Extracted from the Phase 1 orchestrator so Phase 2 runs stages the same way
// rather than growing a second, subtly different copy. The behaviour here is
// exactly what ten Phase 1 trials measured:
//
//   - a stage passes only if its artifact was written DURING that attempt and
//     re-validates from disk (schema + semantic). Agent text claiming success
//     is never evidence;
//   - retries alternate. Even attempts CONTINUE the same conversation with a
//     correction naming what went wrong, keeping what the agent already read;
//     odd attempts start FRESH, because back-to-back failures were observed
//     within one conversation.
//
// Trusted host code. No runtime agent can call any of it.

import { existsSync, statSync } from 'node:fs';
import { runAgent } from './runtime.mjs';

/**
 * Why an artifact is not usable, or undefined if it is: exists, parses,
 * schema-valid, and (unless `semantic: false`) semantically valid.
 *
 * Takes the loaded `qa-artifacts` module so this file stays free of import-time
 * side effects and is easy to test.
 */
export function makeArtifactProblem(qa) {
  return function artifactProblem(name, { semantic: checkSemantic = true } = {}) {
    let data;
    try {
      data = qa.readQaArtifact(name);
    } catch (error) {
      return `${name}.json is not valid JSON (${error.message}).`;
    }
    if (data === undefined) return `${name}.json does not exist.`;
    const schema = qa.schemaErrorsFor(name, data);
    if (schema.length > 0) return `${name}.json fails its schema: ${schema[0]}`;
    if (!checkSemantic) return undefined;
    const semantic = qa.semanticErrorsFor(name, data);
    if (semantic.length > 0) return `${name}.json fails semantic validation: ${semantic[0].code} at ${semantic[0].path}`;
    return undefined;
  };
}

/**
 * Was this artifact written during the attempt that started at `startedMs`?
 *
 * The one-second slack absorbs filesystem timestamp granularity. An artifact
 * left by an earlier run — or by an earlier attempt of this one — is not fresh,
 * so a stale file on disk can never make a failed attempt look successful.
 */
export function wasWrittenDuring(path, startedMs) {
  return existsSync(path) && statSync(path).mtimeMs >= startedMs - 1000;
}

/** The corrective message for a retry, naming exactly what the last attempt got wrong. */
export function retryMessage(stage, problem) {
  if (problem && /was not written/.test(problem)) {
    return (
      `Nothing was saved: your last turn ended without a successful write_qa_artifact call, so ` +
      `"${stage.artifact}" does not exist. Call write_qa_artifact now with name "${stage.artifact}" ` +
      'and the complete object. Do not reply in prose until the tool reports success.'
    );
  }
  return (
    `The "${stage.artifact}" artifact you wrote failed host validation: ${problem}. ` +
    `Fix it and call write_qa_artifact again with name "${stage.artifact}" and the complete object.`
  );
}

/**
 * Run one stage to success or exhaustion, appending to `entry` as it goes.
 *
 * @param {object}   o
 * @param {object}   o.stage           { key, label, agent, artifact, message }
 * @param {object}   o.entry           run-log entry, mutated in place
 * @param {number}   o.attempts        bounded attempts
 * @param {string}   o.idPrefix        conversation id prefix, e.g. 'p1' or 'p2'
 * @param {string}   o.stamp           run stamp, shared by every stage of a run
 * @param {Function} o.artifactProblem from `makeArtifactProblem`
 * @param {Function} o.qaArtifactPath  `qa.qaArtifactPath`
 * @param {Function} [o.onProgress]    called after each attempt (to persist the log)
 * @returns {Promise<boolean>} whether the stage passed
 */
export async function runStage({ stage, entry, attempts, idPrefix, stamp, artifactProblem, qaArtifactPath, onProgress }) {
  let passed = false;
  let lastProblem;
  let id;
  entry.conversationIds = [];

  for (let attempt = 1; attempt <= attempts && !passed; attempt += 1) {
    const resume = attempt % 2 === 0;
    if (!resume) {
      id = `${idPrefix}-${stage.key}-${stamp}-${attempt}`;
      entry.conversationIds.push(id);
    }
    console.log(
      `\n=== ${stage.label} — attempt ${attempt}/${attempts}` +
        `${resume ? ' (continuing, with correction)' : attempt > 1 ? ' (fresh conversation)' : ''} ===\n`,
    );
    const started = Date.now();
    const message = resume ? retryMessage(stage, lastProblem) : stage.message;
    const exitCode = await runAgent(stage.agent, message, id, { resume });

    const path = qaArtifactPath(stage.artifact);
    // Fresh = written during this attempt. A file from before cannot pass.
    const fresh = wasWrittenDuring(path, started);
    const problem = fresh ? artifactProblem(stage.artifact) : `${stage.artifact}.json was not written by this attempt.`;
    passed = fresh && problem === undefined;
    lastProblem = problem;

    entry.attempts.push({
      attempt,
      resumed: resume,
      conversationId: id,
      agentExitCode: exitCode,
      seconds: Math.round((Date.now() - started) / 1000),
      passed,
      problem: problem ?? null,
    });
    onProgress?.();
    console.log(`\n--- ${stage.label}: ${passed ? 'artifact written and valid' : `FAILED — ${problem}`}`);
  }

  entry.passed = passed;
  return passed;
}
