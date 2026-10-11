// Unit tests for the Premiere panel's time helpers (src/premiere-uxp/lib/time.js, CommonJS).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const time = require("../src/premiere-uxp/lib/time.js");
const TPS = 254016000000n;

const RATES = {
  "23.976": { tb: { fpsNum: 24000, fpsDen: 1001, dropFrame: false }, tpf: 10594584000n, nominal: 24 },
  "24": { tb: { fpsNum: 24, fpsDen: 1, dropFrame: false }, tpf: 10584000000n, nominal: 24 },
  "25": { tb: { fpsNum: 25, fpsDen: 1, dropFrame: false }, tpf: 10160640000n, nominal: 25 },
  "29.97DF": { tb: { fpsNum: 30000, fpsDen: 1001, dropFrame: true }, tpf: 8475667200n, nominal: 30 },
  "29.97NDF": { tb: { fpsNum: 30000, fpsDen: 1001, dropFrame: false }, tpf: 8475667200n, nominal: 30 },
  "30": { tb: { fpsNum: 30, fpsDen: 1, dropFrame: false }, tpf: 8467200000n, nominal: 30 },
  "50": { tb: { fpsNum: 50, fpsDen: 1, dropFrame: false }, tpf: 5080320000n, nominal: 50 },
  "59.94DF": { tb: { fpsNum: 60000, fpsDen: 1001, dropFrame: true }, tpf: 4237833600n, nominal: 60 },
  "60": { tb: { fpsNum: 60, fpsDen: 1, dropFrame: false }, tpf: 4233600000n, nominal: 60 },
};

function badTime(fn) {
  assert.throws(fn, (e) => e instanceof Error && e.code === "BAD_TIME");
}

test("TICKS_PER_SECOND", () => {
  assert.equal(time.TICKS_PER_SECOND, 254016000000);
});

test("timebaseFromTicksPerFrame recognises every listed rate (string and BigInt)", () => {
  for (const [label, r] of Object.entries(RATES)) {
    const tb = time.timebaseFromTicksPerFrame(r.tpf.toString(), r.tb.dropFrame);
    assert.deepEqual(tb, r.tb, label);
    assert.deepEqual(time.timebaseFromTicksPerFrame(r.tpf, r.tb.dropFrame), r.tb, label + " bigint");
  }
});

test("timebaseFromTicksPerFrame ignores dropFrame for rates that cannot drop", () => {
  assert.deepEqual(time.timebaseFromTicksPerFrame("10584000000", true), { fpsNum: 24, fpsDen: 1, dropFrame: false });
});

test("timebaseFromFps snaps float rates", () => {
  assert.deepEqual(time.timebaseFromFps(23.976023976), RATES["23.976"].tb);
  assert.deepEqual(time.timebaseFromFps(29.97, true), RATES["29.97DF"].tb);
  assert.deepEqual(time.timebaseFromFps(59.94005994, true), RATES["59.94DF"].tb);
  assert.deepEqual(time.timebaseFromFps(25), RATES["25"].tb);
  assert.deepEqual(time.timebaseFromFps(24, true), RATES["24"].tb);
  badTime(() => time.timebaseFromFps(0));
});

test("timebaseFromTicksPerFrame rejects garbage", () => {
  badTime(() => time.timebaseFromTicksPerFrame("abc"));
  badTime(() => time.timebaseFromTicksPerFrame("0"));
});

test("frames -> ticks -> frames round-trips at every rate", () => {
  for (const [label, r] of Object.entries(RATES)) {
    for (const f of [0, 1, 2, 23, 24, 29, 30, 59, 1799, 1800, 17982, 107892, 215784, 1234567]) {
      const ticks = time.framesToTicks(f, r.tb);
      assert.equal(typeof ticks, "bigint");
      assert.equal(ticks, BigInt(f) * r.tpf, `${label} ticks f=${f}`);
      assert.equal(time.ticksToFrames(ticks, r.tb), f, `${label} f=${f}`);
      assert.equal(time.ticksToFrames(ticks.toString(), r.tb), f, `${label} string f=${f}`);
    }
  }
});

test("frames -> timecode -> frames round-trips at every rate", () => {
  for (const [label, r] of Object.entries(RATES)) {
    for (let f = 0; f < 40000; f += 7) {
      const tc = time.framesToTimecode(f, r.tb);
      assert.equal(time.timecodeToFrames(tc, r.tb), f, `${label} ${tc}`);
    }
  }
});

test("ticksToFrames rounds to nearest frame", () => {
  const tb = RATES["24"].tb;
  assert.equal(time.ticksToFrames(10584000000n * 10n + 5291999999n, tb), 10);
  assert.equal(time.ticksToFrames(10584000000n * 10n + 5292000000n, tb), 11);
  assert.equal(time.ticksToFrames(1n, tb), 0);
  assert.equal(time.ticksToFrames(10584000000n - 1n, tb), 1);
  // seconds-aligned ticks at 23.976 snap to the nearest frame
  assert.equal(time.ticksToFrames(TPS, RATES["23.976"].tb), 24); // 1s = 23.976 frames -> 24
});

test("non-drop timecode formatting", () => {
  assert.equal(time.framesToTimecode(0, RATES["24"].tb), "00:00:00:00");
  assert.equal(time.framesToTimecode(24 * 3600 + 25, RATES["24"].tb), "01:00:01:01");
  assert.equal(time.framesToTimecode(86399, RATES["23.976"].tb), "00:59:59:23");
  assert.equal(time.framesToTimecode(1800, RATES["29.97NDF"].tb), "00:01:00:00");
  assert.equal(time.framesToTimecode(49, RATES["50"].tb), "00:00:00:49");
});

test("29.97 drop-frame edge cases", () => {
  const tb = RATES["29.97DF"].tb;
  assert.equal(time.framesToTimecode(1799, tb), "00:00:59;29");
  assert.equal(time.framesToTimecode(1800, tb), "00:01:00;02");
  assert.equal(time.timecodeToFrames("00:01:00;02", tb), 1800);
  assert.equal(time.timecodeToFrames("00;01;00;02", tb), 1800);
  assert.equal(time.timecodeToFrames("00:10:00;00", tb), 17982);
  assert.equal(time.framesToTimecode(17982, tb), "00:10:00;00");
  assert.equal(time.timecodeToFrames("01:00:00;00", tb), 107892);
  assert.equal(time.framesToTimecode(107892, tb), "01:00:00;00");
  badTime(() => time.timecodeToFrames("00:01:00;00", tb));
  badTime(() => time.timecodeToFrames("00:01:00;01", tb));
  badTime(() => time.timecodeToFrames("00:02:00;01", tb));
  // tenth minutes keep ;00 and ;01
  assert.equal(time.timecodeToFrames("00:20:00;01", tb), 17982 * 2 + 1);
});

test("59.94 drop-frame edge cases", () => {
  const tb = RATES["59.94DF"].tb;
  assert.equal(time.framesToTimecode(3600, tb), "00:01:00;04");
  assert.equal(time.timecodeToFrames("00:01:00;04", tb), 3600);
  badTime(() => time.timecodeToFrames("00:01:00;03", tb));
  assert.equal(time.timecodeToFrames("01:00:00;00", tb), 215784);
});

test("separator must match the timebase", () => {
  badTime(() => time.timecodeToFrames("00:00:01;00", RATES["24"].tb));
  badTime(() => time.timecodeToFrames("00:00:01:00", RATES["29.97DF"].tb));
});

test("malformed / out-of-range timecodes", () => {
  const tb = RATES["25"].tb;
  for (const bad of ["", "1:2:3:4", "00:00:00:25", "00:60:00:00", "00:00:60:00", "00:00:00", "aa:bb:cc:dd", "00:00:00:00:00", "-00:00:01:00"]) {
    badTime(() => time.timecodeToFrames(bad, tb));
  }
  assert.equal(time.timecodeToFrames("100:00:00:00", tb), 100 * 3600 * 25);
});

test("parseTime accepts {frames:int} and {timecode}", () => {
  const tb = RATES["25"].tb;
  assert.equal(time.parseTime({ frames: 0 }, tb), 0);
  assert.equal(time.parseTime({ frames: 250 }, tb), 250);
  assert.equal(time.parseTime({ timecode: "00:00:10:00" }, tb), 250);
});

test("parseTime rejects floats, negatives, strings and other shapes", () => {
  const tb = RATES["25"].tb;
  badTime(() => time.parseTime({ frames: 1.5 }, tb));
  badTime(() => time.parseTime({ frames: -1 }, tb));
  badTime(() => time.parseTime({ frames: "10" }, tb));
  badTime(() => time.parseTime({ frames: NaN }, tb));
  badTime(() => time.parseTime({ frames: Infinity }, tb));
  badTime(() => time.parseTime({ seconds: 1 }, tb));
  badTime(() => time.parseTime(10, tb));
  badTime(() => time.parseTime(1.5, tb));
  badTime(() => time.parseTime("00:00:01:00", tb));
  badTime(() => time.parseTime(null, tb));
  badTime(() => time.parseTime({ frames: 1, timecode: "00:00:00:01" }, tb));
});

test("parseTime allowNegative for deltas", () => {
  const tb = RATES["25"].tb;
  assert.equal(time.parseTime({ frames: -5 }, tb, { allowNegative: true }), -5);
  badTime(() => time.parseTime({ frames: -5.5 }, tb, { allowNegative: true }));
});

test("formatTime returns frames, timecode and seconds", () => {
  assert.deepEqual(time.formatTime(48, RATES["24"].tb), { frames: 48, timecode: "00:00:02:00", seconds: 2 });
  const df = time.formatTime(1800, RATES["29.97DF"].tb);
  assert.equal(df.timecode, "00:01:00;02");
  assert.equal(df.seconds, 60.06);
  assert.equal(time.formatTime(1, RATES["23.976"].tb).seconds, 0.041708);
});
