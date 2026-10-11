"use strict";
const shared = require("./_shared.js");

// SPIKE: the intrinsic clip Volume "Level" parameter is assumed to use ExtendScript's encoding,
// value = 10^((dB - 15) / 20) (so 0 dB = 0.1778, +6 dB = 0.3548, value 0 = silence). Verify by reading
// getValueAtTime on a clip whose level is set to 0 dB in the UI.
const MAX_DB = 6;
function dbToValue(db) {
  return Math.pow(10, (db - 15) / 20);
}
function valueToDb(v) {
  return v > 0 ? Math.round((20 * Math.log10(v) + 15) * 100) / 100 : null;
}

// The Volume component is found by display name "Volume" (match name containing "Volume" as fallback) and its
// level by param displayName "Level". Live (26.5.2, English UI): display "Volume", match "Internal Volume Mono",
// params "Mute" and "Level". SPIKE: localised UIs may use other display names.
async function findLevelParam(chain) {
  const n = chain.getComponentCount();
  for (let i = 0; i < n; i++) {
    const c = chain.getComponentAtIndex(i);
    let dn = "";
    let mn = "";
    try {
      dn = String((await c.getDisplayName()) || "");
    } catch (e) {
      /* ignore */
    }
    try {
      mn = String((await c.getMatchName()) || "");
    } catch (e) {
      /* ignore */
    }
    if (dn.toLowerCase() !== "volume" && !/volume/i.test(mn)) continue;
    for (let j = 0; j < c.getParamCount(); j++) {
      const p = c.getParam(j);
      if (String(p.displayName || "").toLowerCase() === "level") return p;
    }
  }
  return null;
}

function checkDb(ctx, db, name) {
  if (typeof db !== "number" || !isFinite(db) || db > MAX_DB) throw shared.badArgs(ctx, `${name} must be a number of dB <= +${MAX_DB}`);
  return db;
}

module.exports = {
  name: "setAudio",
  mutating: true,
  targetless: false,
  async run(ctx, args) {
    const a = args || {};
    const hasLevel = a.levelDb !== undefined && a.levelDb !== null;
    const fades = a.fades || null;
    const keyframes = a.keyframes || null;
    if (hasLevel) checkDb(ctx, a.levelDb, "levelDb");
    if (fades !== null && (typeof fades !== "object" || Array.isArray(fades))) throw shared.badArgs(ctx, "fades must be {inFrames?, outFrames?}");
    if (keyframes !== null && (!Array.isArray(keyframes) || !keyframes.length)) throw shared.badArgs(ctx, "keyframes must be a non-empty array of {at, db}");
    const fadeIn = fades && fades.inFrames !== undefined && fades.inFrames !== null ? fades.inFrames : 0;
    const fadeOut = fades && fades.outFrames !== undefined && fades.outFrames !== null ? fades.outFrames : 0;
    for (const [n, v] of [["fades.inFrames", fadeIn], ["fades.outFrames", fadeOut]]) {
      if (!Number.isInteger(v) || v < 0) throw ctx.fail("BAD_TIME", `${n} must be a non-negative integer`);
    }
    const hasFades = fadeIn > 0 || fadeOut > 0;
    if (!hasLevel && !hasFades && !keyframes) throw shared.badArgs(ctx, "Give levelDb, fades and/or keyframes");
    if (hasLevel && keyframes && !hasFades) throw shared.badArgs(ctx, "levelDb and keyframes conflict; put the level into the keyframes (levelDb is the fade base when fades are given)");

    const { sequence: seq } = await shared.refs.resolveSequence(ctx, a.sequence);
    const tb = await shared.sequenceTimebase(ctx, seq);
    const t = await shared.getTrack(ctx, seq, a.track, { expect: "audio", name: "track" });
    const target = shared.pickItem(ctx, await shared.clipItems(ctx, t.track), { index: a.index }, tb, t.label);
    const chain = await target.ti.getComponentChain();
    const param = chain ? await findLevelParam(chain) : null;
    if (!param) throw ctx.fail("UNSUPPORTED", `Could not find the Volume > Level parameter on ${t.label} clip ${target.index}`);

    const dur = target.end - target.start;
    const inPoint = shared.ticksOf(await target.ti.getInPoint());
    // SPIKE: keyframe positions are assumed to be in clip media time (in point + offset into the clip, 100% speed).
    const keyAt = (seqTicks) => inPoint + (seqTicks - target.start);
    const inFadeT = ctx.time.framesToTicks(fadeIn, tb);
    const outFadeT = ctx.time.framesToTicks(fadeOut, tb);
    if (inFadeT + outFadeT > dur) throw ctx.fail("BAD_TIME", "fades are longer than the clip");

    let baseValue = hasLevel ? dbToValue(a.levelDb) : null;
    if (baseValue === null && hasFades) {
      const v = await param.getValueAtTime(shared.tick(ctx, inPoint));
      baseValue = typeof v === "number" ? v : v && typeof v.value === "number" ? v.value : dbToValue(0);
    }

    // Keyframe plan in clip time: [{ ticks, value, db }]
    const keys = [];
    if (fadeIn > 0) keys.push({ ticks: keyAt(target.start), value: 0 }, { ticks: keyAt(target.start + inFadeT), value: baseValue });
    if (fadeOut > 0) keys.push({ ticks: keyAt(target.end - outFadeT), value: baseValue }, { ticks: keyAt(target.end), value: 0 });
    for (let i = 0; i < (keyframes || []).length; i++) {
      const k = keyframes[i];
      if (!k || typeof k !== "object") throw shared.badArgs(ctx, `keyframes[${i}] must be {at, db}`);
      const at = shared.parseTicks(ctx, k.at, tb, `keyframes[${i}].at`);
      if (at < target.start || at > target.end) throw ctx.fail("BAD_TIME", `keyframes[${i}].at is outside the clip`);
      keys.push({ ticks: keyAt(at), value: dbToValue(checkDb(ctx, k.db, `keyframes[${i}].db`)) });
    }
    const timeVarying = keys.length > 0;
    const wasVarying = !!param.isTimeVarying();

    await ctx.transaction(`set audio ${t.label} clip ${target.index}`, (compound) => {
      if (timeVarying) {
        if (!wasVarying) compound.addAction(param.createSetTimeVaryingAction(true));
        for (const k of keys) {
          const kf = param.createKeyframe(k.value);
          kf.position = shared.tick(ctx, k.ticks);
          compound.addAction(param.createAddKeyframeAction(kf));
        }
      } else {
        // A plain level replaces any existing volume keyframes.
        if (wasVarying) compound.addAction(param.createSetTimeVaryingAction(false));
        compound.addAction(param.createSetValueAction(param.createKeyframe(baseValue), true));
      }
    });

    return {
      sequence: seq.name,
      track: t.label,
      index: target.index,
      levelDb: hasLevel ? a.levelDb : baseValue !== null ? valueToDb(baseValue) : null,
      fades: hasFades ? { inFrames: fadeIn, outFrames: fadeOut } : null,
      keyframes: keys.map((k) => ({ at: shared.fmt(ctx, k.ticks - inPoint + target.start, tb), db: valueToDb(k.value) })),
      clearedKeyframes: !timeVarying && wasVarying,
    };
  },
};

module.exports._dbToValue = dbToValue;
