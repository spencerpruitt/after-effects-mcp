"use strict";
const shared = require("./_shared.js");
const { baseName, dirName } = require("../core/util.js");

const FRAME_FORMATS = ["bmp", "dpx", "gif", "jpg", "exr", "png", "tga", "tif"];

module.exports = {
  name: "exportSequence",
  mutating: false,
  targetless: false,
  async run(ctx, args) {
    const a = args || {};
    let output = shared.requireString(ctx, a.output, "output");
    if (!shared.isAbsolute(output)) throw shared.badArgs(ctx, `output must be an absolute path, got "${output}"`);
    // Path check first, before any lookup or export call (spec Q15).
    ctx.assertWritable(output);
    const isFrame = a.frame !== undefined && a.frame !== null;
    const { sequence: seq } = await shared.refs.resolveSequence(ctx, a.sequence);

    if (isFrame) {
      let format = a.format === undefined || a.format === null ? shared.extOf(output) : String(a.format).toLowerCase().replace(/^\./, "");
      if (format === "jpeg") format = "jpg";
      if (format === "tiff") format = "tif";
      if (!FRAME_FORMATS.includes(format)) throw shared.badArgs(ctx, `format must be one of ${FRAME_FORMATS.join(", ")}`);
      const ext = shared.extOf(output);
      if (!ext) output = `${output}.${format}`;
      else if ((ext === "jpeg" ? "jpg" : ext === "tiff" ? "tif" : ext) !== format) throw shared.badArgs(ctx, `output extension .${ext} does not match format ${format}`);
      ctx.assertWritable(output);
      const tb = await shared.sequenceTimebase(ctx, seq);
      const at = shared.parseTicks(ctx, a.frame, tb, "frame");
      const size = await seq.getFrameSize();
      const dir = dirName(output);
      // Exporter.exportSequenceFrame(sequence, time, filename, filepath, w, h) takes the bare file name plus the
      // directory with a trailing separator (live, 26.5.2: a 640x360 PNG landed at the requested path).
      const ok = await ctx.ppro.Exporter.exportSequenceFrame(seq, shared.tick(ctx, at), baseName(output), dir + (output.includes("\\") ? "\\" : "/"), size.width, size.height);
      if (!ok) throw new Error(`Premiere could not export the frame to "${output}"`);
      return { sequence: seq.name, output, kind: "frame", format, frame: shared.fmt(ctx, at, tb), width: size.width, height: size.height };
    }

    const preset = shared.requireString(ctx, a.preset, "preset");
    if (shared.extOf(preset) !== "epr") throw shared.badArgs(ctx, `preset must be an .epr file, got "${preset}"`);
    const mode = shared.oneOf(ctx, a.mode, "mode", ["direct", "queue-ame"], "direct");
    const range = shared.oneOf(ctx, a.range, "range", ["full", "workarea"], "full");
    if (!(await ctx.pathExists(preset))) throw ctx.fail("FILE_NOT_FOUND", `No export preset at "${preset}"`);
    const EM = ctx.ppro.EncoderManager;
    const manager = EM.getManager();
    if (mode === "queue-ame" && !manager.isAMEInstalled) throw ctx.fail("UNSUPPORTED", "Adobe Media Encoder is not installed");
    if (!shared.extOf(output)) {
      let ext = null;
      try {
        ext = await EM.getExportFileExtension(seq, preset);
      } catch (e) {
        ext = null;
      }
      if (ext) output = `${output}.${String(ext).replace(/^\./, "")}`;
      ctx.assertWritable(output);
    }
    const ET = ctx.ppro.Constants.ExportType;
    // SPIKE: exportFull=false is assumed to export the work area / in-out range; verify which one it is
    // (WorkAreaUtils exists since 26.5 if the range has to be set explicitly). Also verify whether IMMEDIATELY
    // resolves only after the file is written, and that an existing output file is overwritten without a dialog.
    const ok = await manager.exportSequence(seq, mode === "direct" ? ET.IMMEDIATELY : ET.QUEUE_TO_AME, output, preset, range === "full");
    if (!ok) throw new Error(`Premiere could not ${mode === "direct" ? "export" : "queue"} "${seq.name}" to "${output}"`);
    return { sequence: seq.name, output, kind: "video", mode, range, preset, queued: mode === "queue-ame" };
  },
};
