// Time helpers for the Premiere UXP panel. Pure, no host dependencies.
// A timebase is { fpsNum, fpsDen, dropFrame }, e.g. 23.976 -> {24000,1001,false}, 29.97 DF -> {30000,1001,true}.
// Frame counts are plain integers; ticks are BigInt (Premiere: 254016000000 ticks per second).
"use strict";

const TICKS_PER_SECOND = 254016000000;
const TPS = 254016000000n;

function badTime(msg) {
  return Object.assign(new Error(msg), { code: "BAD_TIME" });
}

function toBigInt(v, what) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  throw badTime(`${what} must be an integer tick count, got ${String(v)}`);
}

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

function canDrop(tb) {
  return tb.fpsDen === 1001 && (tb.fpsNum === 30000 || tb.fpsNum === 60000);
}

function timebaseFromTicksPerFrame(ticksPerFrame, dropFrame) {
  const tpf = toBigInt(ticksPerFrame, "ticksPerFrame");
  if (tpf <= 0n) throw badTime(`ticksPerFrame must be positive, got ${tpf}`);
  const g = gcd(TPS, tpf);
  const num = TPS / g;
  const den = tpf / g;
  const tb = { fpsNum: Number(num), fpsDen: Number(den), dropFrame: false };
  tb.dropFrame = !!dropFrame && canDrop(tb);
  return tb;
}

// fps as a float (e.g. FootageInterpretation.getFrameRate() -> 23.976...) -> timebase. NTSC rates snap to N*1000/1001.
function timebaseFromFps(fps, dropFrame) {
  if (typeof fps !== "number" || !isFinite(fps) || fps <= 0) throw badTime(`Invalid frame rate ${String(fps)}`);
  const n = Math.round(fps);
  let tb;
  if (Math.abs(fps - n) < 1e-3) tb = { fpsNum: n, fpsDen: 1, dropFrame: false };
  else if (Math.abs(fps - (Math.round(fps * 1.001) * 1000) / 1001) < 1e-3) tb = { fpsNum: Math.round(fps * 1.001) * 1000, fpsDen: 1001, dropFrame: false };
  else return timebaseFromTicksPerFrame(BigInt(Math.round(TICKS_PER_SECOND / fps)), dropFrame);
  tb.dropFrame = !!dropFrame && canDrop(tb);
  return tb;
}

function checkTimebase(tb) {
  if (!tb || !Number.isInteger(tb.fpsNum) || !Number.isInteger(tb.fpsDen) || tb.fpsNum <= 0 || tb.fpsDen <= 0) {
    throw badTime("Invalid timebase");
  }
}

// Nominal (integer) frames per second used for timecode labels: 23.976 -> 24, 29.97 -> 30.
function nominalFps(tb) {
  return Math.round(tb.fpsNum / tb.fpsDen);
}

function dropCount(tb) {
  return tb.dropFrame && canDrop(tb) ? (tb.fpsNum === 60000 ? 4 : 2) : 0;
}

function checkFrames(frames, allowNegative) {
  if (typeof frames !== "number" || !Number.isInteger(frames)) throw badTime(`frames must be an integer, got ${String(frames)}`);
  if (!allowNegative && frames < 0) throw badTime(`frames must not be negative, got ${frames}`);
}

function framesToTicks(frames, tb) {
  checkTimebase(tb);
  checkFrames(frames, true);
  const n = BigInt(frames) * TPS * BigInt(tb.fpsDen);
  const d = BigInt(tb.fpsNum);
  return roundDiv(n, d);
}

function roundDiv(n, d) {
  // round half away from zero
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (2n * an + ad) / (2n * ad);
  return neg ? -q : q;
}

function ticksToFrames(ticks, tb) {
  checkTimebase(tb);
  const t = toBigInt(ticks, "ticks");
  return Number(roundDiv(t * BigInt(tb.fpsNum), TPS * BigInt(tb.fpsDen)));
}

function pad(n, w) {
  return String(n).padStart(w, "0");
}

function framesToTimecode(frames, tb) {
  checkTimebase(tb);
  checkFrames(frames, false);
  const fps = nominalFps(tb);
  const drop = dropCount(tb);
  let f = frames;
  if (drop) {
    const per10 = fps * 600 - drop * 9;
    const perMin = fps * 60 - drop;
    const d = Math.floor(f / per10);
    const m = f % per10;
    f += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / perMin) : 0);
  }
  const ff = f % fps;
  const totalSec = Math.floor(f / fps);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const fw = fps > 99 ? 3 : 2;
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}${drop ? ";" : ":"}${pad(ff, fw)}`;
}

const TC_RE = /^(\d{2,3})([:;])(\d{2})\2(\d{2})([:;])(\d{2,3})$/;

function timecodeToFrames(tc, tb) {
  checkTimebase(tb);
  if (typeof tc !== "string") throw badTime(`timecode must be a string, got ${String(tc)}`);
  const m = TC_RE.exec(tc.trim());
  if (!m) throw badTime(`Malformed timecode "${tc}" (expected HH:MM:SS:FF, or HH:MM:SS;FF for drop-frame)`);
  const [, hs, sep1, ms, ss, sep2, fs] = m;
  const isDropLabel = sep2 === ";";
  if (sep1 === ";" && !isDropLabel) throw badTime(`Malformed timecode "${tc}"`);
  const drop = dropCount(tb);
  if (isDropLabel && !drop) throw badTime(`Timecode "${tc}" uses the drop-frame separator ';' but the timebase is non-drop`);
  if (!isDropLabel && drop) throw badTime(`Timecode "${tc}" must use ';' before the frames: the timebase is drop-frame`);
  const h = Number(hs);
  const mi = Number(ms);
  const s = Number(ss);
  const f = Number(fs);
  const fps = nominalFps(tb);
  if (mi > 59 || s > 59) throw badTime(`Timecode "${tc}" out of range`);
  if (f >= fps) throw badTime(`Timecode "${tc}": frame ${f} is out of range at ${fps} fps`);
  if (drop && s === 0 && mi % 10 !== 0 && f < drop) {
    throw badTime(`Timecode "${tc}" does not exist in drop-frame (frames 0-${drop - 1} are skipped at minutes not divisible by 10)`);
  }
  const totalMinutes = h * 60 + mi;
  let frames = (h * 3600 + mi * 60 + s) * fps + f;
  if (drop) frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  return frames;
}

// spec: {frames:int} | {timecode:string}. Anything else -> BAD_TIME.
function parseTime(spec, tb, opts) {
  const allowNegative = !!(opts && opts.allowNegative);
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw badTime(`Time must be {frames:int} or {timecode:"HH:MM:SS:FF"}, got ${JSON.stringify(spec)}`);
  }
  const hasF = Object.prototype.hasOwnProperty.call(spec, "frames");
  const hasT = Object.prototype.hasOwnProperty.call(spec, "timecode");
  if (hasF === hasT) throw badTime(`Time must have exactly one of frames or timecode, got ${JSON.stringify(spec)}`);
  if (hasF) {
    checkFrames(spec.frames, allowNegative);
    return spec.frames;
  }
  return timecodeToFrames(spec.timecode, tb);
}

function formatTime(frames, tb) {
  checkTimebase(tb);
  checkFrames(frames, true);
  const seconds = Math.round((frames * tb.fpsDen * 1e6) / tb.fpsNum) / 1e6;
  const timecode = frames >= 0 ? framesToTimecode(frames, tb) : "-" + framesToTimecode(-frames, tb);
  return { frames, timecode, seconds };
}

module.exports = {
  TICKS_PER_SECOND,
  canDrop,
  pad,
  timebaseFromTicksPerFrame,
  timebaseFromFps,
  parseTime,
  framesToTicks,
  ticksToFrames,
  formatTime,
  framesToTimecode,
  timecodeToFrames,
  nominalFps,
};
