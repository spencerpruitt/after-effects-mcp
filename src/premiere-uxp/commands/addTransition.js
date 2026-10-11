"use strict";
const shared = require("./_shared.js");

// SPIKE: UXP lists video transitions by match name only. These display-name aliases are assumed from
// Premiere's built-in transitions; verify them against TransitionFactory.getVideoTransitionMatchNames().
const ALIASES = {
  "cross dissolve": ["ADBE Cross Dissolve New", "AE.ADBE Cross Dissolve New"],
  "dip to black": ["ADBE Dip To Black", "AE.ADBE Dip To Black"],
  "dip to white": ["ADBE Dip To White", "AE.ADBE Dip To White"],
  "film dissolve": ["ADBE Film Dissolve", "AE.ADBE Film Dissolve"],
  "additive dissolve": ["ADBE Additive Dissolve", "AE.ADBE Additive Dissolve"],
  "morph cut": ["ADBE Morph Cut", "AE.ADBE Morph Cut"],
};

function squash(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pickMatchName(ctx, type, available) {
  const lower = new Map(available.map((m) => [String(m).toLowerCase(), m]));
  const direct = lower.get(String(type).toLowerCase());
  if (direct) return direct;
  for (const alias of ALIASES[String(type).toLowerCase().trim()] || []) {
    const hit = lower.get(alias.toLowerCase());
    if (hit) return hit;
  }
  const want = squash(type);
  const fuzzy = available.filter((m) => squash(m).includes(want));
  if (fuzzy.length === 1) return fuzzy[0];
  throw shared.badArgs(ctx, `Unknown transition "${type}"${fuzzy.length > 1 ? " (ambiguous)" : ""}. Available: ${available.slice(0, 60).join(", ")}`, {
    available: fuzzy.length > 1 ? fuzzy : available,
  });
}

// Validates and resolves (read-only). Audio tracks refuse here, before core's save and backup.
async function prepare(ctx, args) {
  const a = args || {};
  const edge = shared.oneOf(ctx, a.edge, "edge", ["start", "end", "both"], undefined);
  if (!edge) throw shared.badArgs(ctx, 'edge must be "start", "end" or "both"');
  if (!Number.isInteger(a.durationFrames) || a.durationFrames < 1) throw ctx.fail("BAD_TIME", "durationFrames must be a positive integer");
  const type = a.type === undefined || a.type === null ? "Cross Dissolve" : shared.requireString(ctx, a.type, "type");
  const { sequence: seq } = await shared.refs.resolveSequence(ctx, a.sequence);
  const tb = await shared.sequenceTimebase(ctx, seq);
  const t = await shared.getTrack(ctx, seq, a.track);
  const target = shared.pickItem(ctx, await shared.clipItems(ctx, t.track), { index: a.index }, tb, t.label);
  if (t.type === "audio") {
    // Spike result (26.5.2): TransitionFactory is video-only and audio track items have no transition action.
    // The server routes audio-track premiere-add-transition to the CEP sidecar (prx addAudioTransition).
    throw ctx.fail("NEEDS_SIDECAR_UNAVAILABLE", "Audio transitions are not available through UXP: they are routed to the sidecar (premiere-add-transition on an audio track goes to the CEP sidecar; install it with npm run install-premiere-sidecar if it is unavailable, or use premiere-set-audio fades).");
  }
  return { a, edge, type, seq, tb, t, target };
}

module.exports = {
  name: "addTransition",
  mutating: true,
  targetless: false,
  async precheck(ctx, args) {
    await prepare(ctx, args);
  },
  async run(ctx, args) {
    const { a, edge, type, seq, tb, t, target } = await prepare(ctx, args);
    const durTicks = ctx.time.framesToTicks(a.durationFrames, tb);
    if (durTicks > target.end - target.start) throw ctx.fail("BAD_TIME", "durationFrames is longer than the clip");
    const available = Array.from((await ctx.ppro.TransitionFactory.getVideoTransitionMatchNames()) || []);
    const matchName = pickMatchName(ctx, type, available);
    const edges = edge === "both" ? [true, false] : [edge === "start"];

    await ctx.transaction(`add ${type} (${t.label} clip ${target.index})`, (compound) => {
      for (const applyToStart of edges) {
        const transition = ctx.ppro.TransitionFactory.createVideoTransition(matchName);
        const opts = new ctx.ppro.AddTransitionOptions();
        opts.setApplyToStart(applyToStart);
        opts.setDuration(shared.tick(ctx, durTicks));
        // SPIKE: default alignment / forceSingleSided=false assumed to centre on the cut when a neighbour exists.
        opts.setForceSingleSided(false);
        compound.addAction(target.ti.createAddVideoTransitionAction(transition, opts));
      }
    });
    return { sequence: seq.name, track: t.label, index: target.index, edge, type, matchName, duration: shared.fmt(ctx, durTicks, tb) };
  },
};

module.exports._pickMatchName = pickMatchName;
