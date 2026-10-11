"use strict";
const shared = require("./_shared.js");

async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    return null;
  }
}

// Clip details: media path, frame rate, in/out (clip's own timebase), media duration.
async function clipDetails(ctx, clip) {
  const MT = shared.mediaTypes(ctx);
  const d = { mediaPath: await safe(() => clip.getMediaFilePath()) };
  const tb = await safe(() => shared.clipTimebase(ctx, clip, null));
  d.frameRate = tb ? Math.round((tb.fpsNum / tb.fpsDen) * 1000) / 1000 : null;
  let inT = await safe(() => clip.getInPoint(MT.VIDEO));
  let outT = await safe(() => clip.getOutPoint(MT.VIDEO));
  if (inT == null || outT == null) {
    inT = await safe(() => clip.getInPoint(MT.AUDIO));
    outT = await safe(() => clip.getOutPoint(MT.AUDIO));
  }
  const media = await safe(() => clip.getMedia());
  const dur = media && typeof media.getDuration === "function" ? await safe(() => media.getDuration()) : null;
  // Unset marks read as -400000 s (live); shown as null.
  const show = (t) => {
    if (t == null) return null;
    const ticks = shared.ticksOf(t);
    if (shared.isUnsetTicks(ticks)) return null;
    return tb ? shared.fmt(ctx, ticks, tb) : { seconds: Number(ticks) / ctx.time.TICKS_PER_SECOND };
  };
  d.in = show(inT);
  d.out = show(outT);
  d.duration = show(dur);
  d.offline = await safe(() => clip.isOffline());
  return d;
}

module.exports = {
  name: "getProjectItems",
  mutating: false,
  targetless: false,
  async run(ctx, args) {
    const a = args || {};
    const recursive = shared.optBool(ctx, a.recursive, "recursive", true);
    const type = shared.oneOf(ctx, a.type, "type", ["clip", "sequence", "bin"], null);
    const { bin, path } = await shared.refs.resolveBin(ctx, a.bin, { create: false });
    const entries = await shared.refs.walk(ctx, bin, { recursive, basePath: path });
    const items = [];
    for (const e of entries) {
      if (type && e.kind !== type) continue;
      const out = { path: e.path, name: e.name, id: e.id, type: e.kind };
      if (e.kind === "clip") Object.assign(out, await clipDetails(ctx, shared.refs.asClip(ctx, e.item)));
      items.push(out);
    }
    return { bin: path, recursive, count: items.length, items };
  },
};
