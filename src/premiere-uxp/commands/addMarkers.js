"use strict";
const shared = require("./_shared.js");

const TYPES = ["Comment", "Chapter", "Segmentation", "WebLink"];

// SPIKE: Constants.MarkerColor values are assumed to be the indexes Marker.createSetColorByIndexAction takes.
function colorIndex(ctx, color, where) {
  if (Number.isInteger(color) && color >= 0 && color <= 15) return color;
  if (typeof color === "string") {
    const MC = ctx.ppro.Constants.MarkerColor || {};
    const key = color.trim().toUpperCase();
    const v = MC[key] !== undefined ? MC[key] : key === "MAGENTA" ? MC.MAGNETA : undefined;
    if (v !== undefined) return v;
  }
  throw shared.badArgs(ctx, `${where}.color must be green, red, magenta, orange, yellow, blue, cyan or an index 0-15`);
}

module.exports = {
  name: "addMarkers",
  mutating: true,
  targetless: false,
  async run(ctx, args) {
    const a = args || {};
    const target = a.target;
    if (!target || typeof target !== "object") throw shared.badArgs(ctx, "target must be {sequence} or {item}");
    const hasSeq = target.sequence !== undefined && target.sequence !== null;
    const hasItem = target.item !== undefined && target.item !== null;
    if (hasSeq === hasItem) throw shared.badArgs(ctx, "target must have exactly one of sequence or item");
    if (!Array.isArray(a.markers) || !a.markers.length) throw shared.badArgs(ctx, "markers must be a non-empty array");

    let owner;
    let tb;
    let label;
    if (hasSeq) {
      const r = await shared.refs.resolveSequence(ctx, target.sequence);
      owner = r.sequence;
      tb = await shared.sequenceTimebase(ctx, owner);
      label = `sequence ${r.name}`;
    } else {
      const e = await shared.refs.resolveItem(ctx, target.item, { kinds: ["clip"] });
      owner = e.clip;
      tb = await shared.clipTimebase(ctx, e.clip, null);
      label = `item ${e.path}`;
    }

    const plan = a.markers.map((m, i) => {
      const where = `markers[${i}]`;
      if (!m || typeof m !== "object") throw shared.badArgs(ctx, `${where} must be an object`);
      const name = typeof m.name === "string" ? m.name : shared.requireString(ctx, m.name, `${where}.name`);
      if (m.comment !== undefined && m.comment !== null && typeof m.comment !== "string") throw shared.badArgs(ctx, `${where}.comment must be a string`);
      const type = m.type === undefined || m.type === null ? "Comment" : TYPES.find((t) => t.toLowerCase() === String(m.type).toLowerCase());
      if (!type) throw shared.badArgs(ctx, `${where}.type must be one of ${TYPES.join(", ")}`);
      return {
        name,
        comment: m.comment || "",
        type,
        start: shared.parseTicks(ctx, m.at, tb, `${where}.at`),
        duration: m.duration === undefined || m.duration === null ? 0n : shared.parseTicks(ctx, m.duration, tb, `${where}.duration`),
        color: m.color === undefined || m.color === null ? null : colorIndex(ctx, m.color, where),
      };
    });

    const markers = await ctx.ppro.Markers.getMarkers(owner);
    await ctx.transaction(`add ${plan.length} marker(s)`, (compound) => {
      for (const p of plan) {
        compound.addAction(markers.createAddMarkerAction(p.name, p.type, shared.tick(ctx, p.start), shared.tick(ctx, p.duration), p.comment));
      }
    });

    // Colours need the Marker objects, which only exist after the add is committed: second undo step.
    const colored = plan.filter((p) => p.color !== null);
    let colorMisses = 0;
    if (colored.length) {
      const all = Array.from(markers.getMarkers() || []);
      const used = new Set();
      const pairs = [];
      for (const p of colored) {
        const m = all.find((mk) => !used.has(mk) && mk.getName() === p.name && shared.ticksOf(mk.getStart()) === p.start);
        if (m) {
          used.add(m);
          pairs.push([m, p.color]);
        } else colorMisses++;
      }
      if (pairs.length) {
        await ctx.transaction(`colour ${pairs.length} marker(s)`, (compound) => {
          for (const [m, c] of pairs) compound.addAction(m.createSetColorByIndexAction(c));
        });
      }
    }
    const result = {
      target: label,
      added: plan.length,
      markers: plan.map((p) => ({ name: p.name, type: p.type, at: shared.fmt(ctx, p.start, tb), duration: shared.fmt(ctx, p.duration, tb), color: p.color })),
    };
    if (colorMisses) result.colorWarning = `${colorMisses} marker(s) could not be found again to set their colour`;
    return result;
  },
};
