"use strict";
const shared = require("./_shared.js");

async function safe(fn, dflt) {
  try {
    const v = await fn();
    return v === undefined ? dflt : v;
  } catch (e) {
    return dflt;
  }
}

async function componentNames(chain) {
  if (!chain) return [];
  const out = [];
  const n = chain.getComponentCount();
  for (let i = 0; i < n; i++) {
    const c = chain.getComponentAtIndex(i);
    out.push(await safe(() => c.getDisplayName(), null));
  }
  return out;
}

module.exports = {
  name: "getSequence",
  mutating: false,
  targetless: false,
  async run(ctx, args) {
    const a = args || {};
    const offset = a.offset === undefined || a.offset === null ? 0 : a.offset;
    const limit = a.limit === undefined || a.limit === null ? 200 : a.limit;
    if (!Number.isInteger(offset) || offset < 0) throw shared.badArgs(ctx, "offset must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw shared.badArgs(ctx, "limit must be an integer 1-1000");
    if (a.tracks !== undefined && a.tracks !== null && !Array.isArray(a.tracks)) throw shared.badArgs(ctx, 'tracks must be an array like ["V1","A1"]');
    const { sequence: seq } = await shared.refs.resolveSequence(ctx, a.sequence);
    const tb = await shared.sequenceTimebase(ctx, seq);
    const frame = await safe(() => seq.getFrameSize(), null);
    const vCount = await seq.getVideoTrackCount();
    const aCount = await seq.getAudioTrackCount();
    const wanted = a.tracks ? new Set(a.tracks.map((t) => shared.refs.parseTrackRef(ctx, t).label)) : null;

    const tracks = [];
    const items = [];
    const TT = ctx.ppro.Constants.TrackItemType;
    // Live (26.5.2): getTrackItems(TRANSITION) returns nulls, never transition objects (with or without any
    // transitions on the track), so transitions can't be listed. Readable entries are listed if a later
    // release returns them; nulls are skipped and noted.
    let transitionPlaceholders = 0;
    for (const [type, n] of [["video", vCount], ["audio", aCount]]) {
      for (let i = 0; i < n; i++) {
        const label = (type === "video" ? "V" : "A") + (i + 1);
        const tr = type === "video" ? await seq.getVideoTrack(i) : await seq.getAudioTrack(i);
        const clips = await shared.clipItems(ctx, tr);
        const transitions = [];
        const raw = await safe(() => tr.getTrackItems(TT.TRANSITION, false), []);
        for (const t of Array.from(raw || [])) {
          if (!t) {
            transitionPlaceholders++;
            continue;
          }
          const start = await safe(() => t.getStartTime(), null);
          const end = await safe(() => t.getEndTime(), null);
          transitions.push({
            name: await safe(() => t.getName(), null),
            matchName: await safe(() => t.getMatchName(), null),
            start: start ? shared.fmt(ctx, shared.ticksOf(start), tb) : null,
            end: end ? shared.fmt(ctx, shared.ticksOf(end), tb) : null,
          });
        }
        tracks.push({ track: label, name: tr.name, muted: await safe(() => tr.isMuted(), null), clipCount: clips.length, transitions });
        if (wanted && !wanted.has(label)) continue;
        for (const e of clips) items.push({ label, type, e });
      }
    }

    const page = items.slice(offset, offset + limit);
    const out = [];
    for (const { label, type, e } of page) {
      const ti = e.ti;
      const pi = await safe(() => ti.getProjectItem(), null);
      const clip = pi ? shared.refs.asClip(ctx, pi) : null;
      out.push({
        track: label,
        index: e.index,
        name: await safe(() => ti.getName(), null),
        start: shared.fmt(ctx, e.start, tb),
        end: shared.fmt(ctx, e.end, tb),
        duration: shared.fmt(ctx, e.end - e.start, tb),
        // Track item in/out are media times; shown in the sequence timebase.
        in: shared.fmt(ctx, shared.ticksOf(await safe(() => ti.getInPoint(), null)), tb),
        out: shared.fmt(ctx, shared.ticksOf(await safe(() => ti.getOutPoint(), null)), tb),
        speed: await safe(() => ti.getSpeed(), null),
        reversed: !!(await safe(() => ti.isSpeedReversed(), false)),
        enabled: !(await safe(() => ti.isDisabled(), false)),
        item: pi ? { id: shared.refs.itemId(pi), name: pi.name, mediaPath: clip ? await safe(() => clip.getMediaFilePath(), null) : null } : null,
        effects: type === "video" || type === "audio" ? await componentNames(await safe(() => ti.getComponentChain(), null)) : [],
      });
    }
    return {
      name: seq.name,
      guid: shared.refs.guidString(seq.guid),
      settings: {
        timebase: tb,
        fps: Math.round((tb.fpsNum / tb.fpsDen) * 1000) / 1000,
        frameSize: frame ? { width: frame.width, height: frame.height } : null,
      },
      end: shared.fmt(ctx, shared.ticksOf(await seq.getEndTime()), tb),
      tracks,
      transitionsNote: transitionPlaceholders
        ? "Premiere does not return transition objects to UXP (only empty placeholders), so transitions cannot be listed; tracks[].transitions shows only the ones it does return."
        : undefined,
      indexNote: "index is 0-based within its track, ordered by start time; pass it back as {track, index}.",
      total: items.length,
      offset,
      limit,
      hasMore: offset + page.length < items.length,
      nextOffset: offset + page.length < items.length ? offset + page.length : null,
      items: out,
    };
  },
};
