"use strict";
// One undo step: project.lockedAccess(() => project.executeTransaction(cb, "MCP: " + name)).
// Both callbacks are synchronous in the Premiere UXP API (Project.lockedAccess: "() => void",
// executeTransaction: "(compoundAction) => void"), and await is not allowed inside them. Since 26.3,
// create*Action calls must happen inside lockedAccess, so fn runs inside both. Callers build anything
// that needs an await BEFORE calling transaction; a callback that returns a Promise is an error.

const ASYNC_MESSAGE = "transaction callback must be synchronous; do async work before calling transaction, then create and add actions synchronously inside it";

function isThenable(v) {
  return v !== null && (typeof v === "object" || typeof v === "function") && typeof v.then === "function";
}

const UNDO_PREFIX = "MCP: ";

// name: the undo label without prefix. counters (optional): { undoSteps } is incremented when it commits.
function runTransaction(project, name, fn, counters) {
  const undoString = UNDO_PREFIX + String(name);
  let value;
  let error = null;
  let ok;
  try {
    project.lockedAccess(() => {
      ok = project.executeTransaction((compound) => {
        try {
          value = fn(compound, project);
        } catch (e) {
          error = e;
          throw e;
        }
        if (isThenable(value)) {
          // Swallow the orphaned promise's rejection; the transaction is refused either way.
          value.then(null, () => {});
          error = new Error(ASYNC_MESSAGE);
          throw error;
        }
      }, undoString);
    });
  } catch (e) {
    if (!error) error = e;
  }
  if (error) throw error;
  const committed = ok !== false;
  if (committed && counters) counters.undoSteps++;
  return { committed, value };
}

module.exports = { runTransaction, ASYNC_MESSAGE, UNDO_PREFIX };
