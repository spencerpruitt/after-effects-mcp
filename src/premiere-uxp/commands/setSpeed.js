"use strict";
const shared = require("./_shared.js");

// Spike result (Premiere 26.5.2): UXP has no speed or time-remapping setter on track items (only getSpeed /
// isSpeedReversed). The server routes premiere-set-speed to the CEP sidecar (prx setSpeed, spec section 8), so
// this only answers a setSpeed sent to the panel directly. Always refuses, so it runs as the precheck: core then
// skips the pre-run save and backup.
async function refuse(ctx, args) {
  const a = args || {};
  if (typeof a.percent !== "number" || !isFinite(a.percent) || a.percent <= 0 || a.percent > 10000) {
    throw shared.badArgs(ctx, "percent must be a number > 0 and <= 10000");
  }
  shared.optBool(ctx, a.reverse, "reverse", false);
  shared.optBool(ctx, a.ripple, "ripple", true);
  shared.optBool(ctx, a.maintainPitch, "maintainPitch", true);
  const { sequence: seq } = await shared.refs.resolveSequence(ctx, a.sequence);
  const tb = await shared.sequenceTimebase(ctx, seq);
  const t = await shared.getTrack(ctx, seq, a.track);
  const target = shared.pickItem(ctx, await shared.clipItems(ctx, t.track), { index: a.index }, tb, t.label);
  let current = null;
  try {
    current = await target.ti.getSpeed();
  } catch (e) {
    /* ignore */
  }
  throw ctx.fail("NEEDS_SIDECAR_UNAVAILABLE", "Changing clip speed is not available through UXP: it is routed to the sidecar (premiere-set-speed sends it to the CEP sidecar; install it with npm run install-premiere-sidecar if it is unavailable).", {
    track: t.label,
    index: target.index,
    currentSpeed: current,
  });
}

module.exports = {
  name: "setSpeed",
  mutating: true,
  targetless: false,
  precheck: refuse,
  run: refuse,
};
