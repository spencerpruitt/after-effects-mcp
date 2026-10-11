# Premiere UXP cheat sheet (for `premiere-run-script-code`)

Written against the Premiere **26.5** UXP docs; **unverified live until the capability spike** (spec §9 step 2).
Lines marked *(spike)* are inferences the spike must confirm. Reference pages are cited as
`classes/<name>.md` = <https://github.com/AdobeDocs/uxp-premiere-pro/tree/main/src/pages/ppro-reference/classes>
(rendered: <https://developer.adobe.com/premiere-pro/uxp/ppro_reference/>). Changelog:
<https://developer.adobe.com/premiere-pro/uxp/changelog>.

**Prefer typed tools** (`premiere-import`, `premiere-build-sequence`, `premiere-edit-items`, …) — they
already handle times, lookups and transactions. Write a script only for what they don't cover.

### Script context

Your code is the body of an **async** function, called as
`new Function("ppro", "project", "sandbox", "fs", "require", "time", code)`:

| Name | What it is |
|---|---|
| `ppro` | The `premierepro` module (wrapped: output-path APIs are path-checked). Classes hang off it: `ppro.TickTime`, `ppro.SequenceEditor`, `ppro.Constants`, … |
| `project` | The **target** `Project` (resolved from `expectedProject`, never "whatever is active"). Don't call `ppro.Project.getActiveProject()` to find it. |
| `sandbox` | `{ folder, path(rel), saveAs(path, overwrite?), transaction(name, fn), export(...), log(msg) }`. `folder` = the project's sandbox folder; `path("a/b.txt")` resolves inside it. `transaction(name, (compound, project) => …)` wraps `lockedAccess` + `executeTransaction` and counts `undoSteps`. `export` = path-checked export wrapper. |
| `fs`, `require` | Guarded: `require('fs')` and `require('uxp').storage` return proxies; write/rename/unlink/mkdir/copy outside `sandbox.folder` throw `OUTSIDE_FOLDER`. Reads are allowed anywhere. |
| `time` | Frame-exact helpers: `parseTime({frames}|{timecode}, tb) -> frames`, `formatTime(frames, tb) -> {frames,timecode,seconds}`, `framesToTicks(frames, tb) -> BigInt`, `ticksToFrames(ticks, tb) -> int`, `timebaseFromTicksPerFrame(tpf, dropFrame?) -> {fpsNum,fpsDen,dropFrame}`, `TICKS_PER_SECOND`. |

- `return value` → becomes `returnValue` in the result (JSON-safe, depth 8, host objects → `String`).
- **Writes only inside `sandbox.folder`** (files, `saveAs`, exports, frame grabs). Imports may read anywhere.
- **Blocked identifiers** (static scan → `BLOCKED_CALL`, also for `run-script-file`): `globalThis`, `window`,
  `eval(`, `Function(`, `import(`, `localFileSystem`, `localStorage`, `sessionStorage`, `__mcp`, the panel's
  module names, `shell` / `openExternal` / `openPath`, and `require(` with a non-literal argument.
- A save + `.prproj` backup (`<folder>/mcp-scripts/backups/`) runs before every script — that, not Undo, is the
  reliable rollback. Scripts can make several undo steps; the result reports `undoSteps`.
- Almost every **getter method** returns a Promise → `await` it. **Properties** (`project.name`, `.path`,
  `sequence.name`, `tickTime.ticks`) are synchronous. Some methods are sync too (noted below).

## transactions

Every edit is an `Action` created by a `create*Action()` method, added to a `CompoundAction`, and committed by
`project.executeTransaction(cb, undoString)` — one transaction = one undo step. **Since 26.3, actions must be
created inside `project.lockedAccess(() => …)`**, and neither callback may do async work (no `await` inside;
`@adobe/eslint-plugin-premierepro` flags it). So: **await all reads first, then lock → create → commit.**

```js
// 1) async reads OUTSIDE the lock
const seq    = await project.getActiveSequence();          // or find by name via project.getSequences()
const track  = await seq.getVideoTrack(0);                  // V1 (index 0-based, spike)
const items  = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false); // sync
// 2) create + commit actions INSIDE the lock, synchronously
let ok;
project.lockedAccess(() => {
  const a = items[0].createSetNameAction("Hero shot");     // create inside lockedAccess
  ok = project.executeTransaction((compound) => {
    compound.addAction(a);                                  // add inside executeTransaction
  }, "Rename clip");                                        // undo-menu label
});
return { ok };                                              // executeTransaction returns boolean
```

Same thing with the helper (preferred — counts `undoSteps` for the result):

```js
await sandbox.transaction("Rename clip", (compound, project) => {
  compound.addAction(items[0].createSetNameAction("Hero shot"));
}); // keep the callback body synchronous: an `await` inside would commit before your actions are added
```

Gotchas
- Don't let `Action` objects escape the lock or reuse them across transactions; create fresh ones each time.
- Actions built from data you read *before* the lock can go stale if the user edits meanwhile; keep the gap short.
- Several actions in one compound = one undo step. Order of `addAction` = order of application.
- **Create every action first, then add them all** (live, 26.5.2). An `addAction` that already ran is not
  rolled back when a later line in the callback throws: an action Premiere refuses to create (for example a
  move that would land before 0, "Invalid parameter.") after earlier `addAction` calls leaves those earlier
  edits applied. Creating a placement after adding another one in the same callback also failed once with "The
  script object is no longer valid."
- Creation-time checks use the item as it is **before** the transaction: a move is judged against the
  current start, not the start after a head trim added earlier in the same compound. A move that is valid at
  creation but lands before 0 when it runs is skipped silently.
- Premiere 26.5.2 got into a state where every `createSetInPointAction` / `createSetOutPointAction` /
  `createSetStartAction` / `createSetEndAction` threw "The script object is no longer valid." on every track item
  in every sequence (moves, renames and enable/disable still worked). The typed tools hit it as well. It began
  after transactions that created trim actions and then threw. If you see it, save and restart Premiere.
- Inside `premiere-run-script-code`, `TrackItemSelection.createEmptySelection((sel) => sel.addItem(item, true))`
  fails with "Illegal Parameter type" (the typed tools' removes work). Use `premiere-edit-items` to remove clips.
- Not everything is an action: `project.importFiles`, `ClipProjectItem.changeMediaFilePath`, `attachProxy`,
  `Project.save/saveAs`, `AudioTrack.setMute` are direct calls; `changeMediaFilePath`/`attachProxy` are
  documented as **not undoable**.
- Docs: `classes/project.md#lockedaccess`, `#executetransaction`, `classes/compoundaction.md`, changelog 26.3
  "Action creation in locks", `resources/fundamentals/eslint-support`.

## time

Premiere time is `TickTime`: **254016000000 ticks per second** (`time.TICKS_PER_SECOND`). Never use float
seconds for edit points — 23.976 / 29.97 don't divide evenly. Go frames → ticks (BigInt) → `TickTime`.

```js
const seq  = await project.getActiveSequence();
const tpf  = String(await seq.getTimebase());         // Promise; ticks per frame: "8475667200" at 29.97 (live 26.5.2), "10594584000" at 23.976
const tb   = time.timebaseFromTicksPerFrame(tpf);     // pass dropFrame=true for 29.97/59.94 DF timecode
const f    = time.parseTime({ timecode: "00:00:10:12" }, tb);          // -> frames (int)
const tt   = ppro.TickTime.createWithTicks(time.framesToTicks(f, tb).toString());
const back = time.formatTime(time.ticksToFrames(BigInt(tt.ticks), tb), tb); // {frames,timecode,seconds}
```

`TickTime` (`classes/ticktime.md`)
- Create: `TickTime.createWithTicks(string)` (exact — preferred; negative strings work), `createWithSeconds(n)`,
  `createWithFrameAndFrameRate(frame, ppro.FrameRate.createWithValue(fps))`. Constants: `TIME_ZERO`,
  `TIME_ONE_SECOND`, `TIME_ONE_MINUTE`, `TIME_ONE_HOUR`, `TIME_MAX`, `TIME_MIN`, `TIME_INVALID` (live 26.5.2).
- Read: `.ticks` (string — use `BigInt(t.ticks)`), `.ticksNumber` (loses precision past ~9.8 h), `.seconds`.
- Math (returns new objects): `add`, `subtract`, `multiply(n)`, `divide(n)`, `equals`, `alignToFrame(fr)`,
  `alignToNearestFrame(fr)`.
- `FrameRate` (`classes/framerate.md`): `createWithValue(fps)`, `.value`, `.ticksPerFrame`.
- Sequence settings: `(await seq.getSettings()).getVideoFrameRate()` → `FrameRate` (`classes/sequencesettings.md`).
- Clip (project item) in/out use the **clip's** rate, sequence times use the **sequence's** timebase.
- A project item **with no in/out marks** reports `-400000` s (`-101606400000000000` ticks) from both
  `getInPoint(mt)` and `getOutPoint(mt)` (live 26.5.2). Treat negative or huge values as "unset"; the typed
  tools show them as `null`. The media length is `(await clip.getMedia()).getDuration()`.
- Track-item `getInPoint()`/`getOutPoint()` are media times from the media start (a full-length clip reads
  in 0, out = its length in frames).
- Sequence times: `seq.getEndTime()`, `getInPoint()`, `getOutPoint()`, `getZeroPoint()`, `getPlayerPosition()`;
  `setPlayerPosition(tt)`. Work area (26.5): `ppro.WorkAreaUtils.setWorkAreaInOutPoints(seq, inTT, outTT)`.

## bins

Project tree: `await project.getRootItem()` → `FolderItem`; `await folder.getItems()` → `ProjectItem[]`.
Cast before using type-specific methods: `ppro.FolderItem.cast(item)`, `ppro.ClipProjectItem.cast(item)`,
`ppro.ProjectItem.cast(folderOrClip)`. `item.name`, `item.type` (number; undocumented and there is no
`Constants.ProjectItemType`; live 26.5.2 a bin is `2`, matching ExtendScript's CLIP=1, BIN=2, ROOT=3, FILE=4.
Tell sequences from clips with `await ClipProjectItem.cast(item).isSequence()`),
`item.getId()` (sync), `item.getParentBin()` (sync).

```js
// Create Renders/v003 (one transaction per level, then re-read to get the new FolderItem)
async function ensureBin(parent, name) {
  const find = async () => (await parent.getItems()).find(i => i.name === name);
  let hit = await find();
  if (!hit) {
    await sandbox.transaction(`Create bin ${name}`, (c) => c.addAction(parent.createBinAction(name, false)));
    hit = await find();
  }
  return ppro.FolderItem.cast(hit);
}
const root    = await project.getRootItem();
const renders = await ensureBin(root, "Renders");
const v003    = await ensureBin(renders, "v003");
```

`FolderItem` actions (`classes/folderitem.md`): `createBinAction(name, makeUnique)`, `createRenameBinAction(name)`,
`createMoveItemAction(item, newParentFolder)`, `createRemoveItemAction(item)`, `createSmartBinAction(name, query)`,
`createSetColorLabelAction(index)`, `createSetNameAction(name)`.

Gotchas
- `createBinAction` returns an `Action`, not the new bin: commit, then find it with `getItems()`.
- `makeUnique=true` silently renames on collision ("v003 01"); prefer `false` + look-up-first.
- Telling bins from clips: `FolderItem.cast` / `ClipProjectItem.cast` on the wrong kind — return value
  unverified *(spike)*. `premiere-get-project-items` reports `type` reliably.
- Insertion bin: `await project.getInsertionBin()`.

## import

`project.importFiles(filePaths, suppressUI, targetBin, asNumberedStills)` → `Promise<boolean>`
(`classes/project.md#importfiles`). Not an action — runs outside `executeTransaction`.

```js
const bin = ppro.ProjectItem.cast(v003);                    // targetBin is typed ProjectItem
const ok  = await project.importFiles(
  ["D:\\Projects\\MyFilm\\renders\\SH010_v003.mov"], true /*suppressUI*/, bin, false /*asNumberedStills*/);
// importFiles returns only a boolean -> find the new items yourself:
const clips = [];
for (const it of await v003.getItems()) {
  const c = ppro.ClipProjectItem.cast(it);
  if (c && (await c.getMediaFilePath()).toLowerCase().endsWith("sh010_v003.mov")) clips.push(c);
}
```

- Always pass `suppressUI = true` (modal dialogs block the bridge).
- Image sequences: `asNumberedStills = true` with the first frame's path.
- After Effects comps (Dynamic Link): `project.importAEComps(aepPath, ["Comp 1"], targetBin)` /
  `importAllAEComps(aepPath, targetBin)`, both `Promise<boolean>`; both exist on `Project` in 26.5.2 (26.5 fixed
  the default-to-root case). They only return a boolean, so diff the bin's items before and after. Typed tool:
  `premiere-import-ae-comps` (`{ aepPath, comps?, bin?, skipExisting = true }`); it skips comps already in the
  bin by name. Not yet run live: the linked items' names and any sub-bin are unverified.
- Other projects' sequences: `project.importSequences(projectPath, [guid…])`.
- Replace media: `await clip.canChangeMediaPath()` then `clip.changeMediaFilePath(newPath, false)` (not undoable).
  Live (26.5.2): every timeline use follows, and **timeline trims are kept** (start/end/in/out unchanged, even
  when the new file is longer). A path that does not exist returns `false` instead of throwing.
  `clip.refreshMedia()`, `clip.isOffline()`.
- Clip in/out (source range): `clip.createSetInOutPointsAction(inTT, outTT)`, `createSetInPointAction`,
  `createSetOutPointAction` (fixed in 26.5), `createClearInOutPointsAction()`; read `await clip.getInPoint(ppro.Constants.MediaType.VIDEO)`.
- Media: `const m = await clip.getMedia(); m.getStart(); m.getDuration();` (sync since 26.5; `m.start/m.duration` deprecated).
- Interpretation: `clip.createSetOverrideFrameRateAction(23.976)`, `getFootageInterpretation()`.
- Subclips: `clip.createSubClipAction(name, startTT, endTT, hasHardBoundaries, { takeVideo, takeAudio })`.

## editing

Sequences (`classes/project.md`, `classes/sequence.md`):
- `project.getSequences()`, `getActiveSequence()`, `setActiveSequence(seq)`, `openSequence(seq)`, `getSequence(guid)`.
- `project.createSequenceFromMedia(name, [clip…], targetBin)` (settings match the first clip),
  `createSequenceWithPresetPath(name, "….sqpreset")` (26.3+), `createSequence(name)` (default preset),
  `deleteSequence(seq)`. Clone: `seq.createCloneAction()`.
- Tracks: `await seq.getVideoTrack(i)` / `getAudioTrack(i)`, `getVideoTrackCount()`, `getAudioTrackCount()`;
  `track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)` (**sync**, and **not** in time order: sort by
  `getStartTime()`); `track.createSetNameAction(name)`. Track indices are 0-based (V1 = 0), for the getters and
  the editor actions alike (live 26.5.2).
- `TrackItemType` = `{ EMPTY: 0, CLIP: 1, TRANSITION: 2, PREVIEW: 3, FEEDBACK: 4 }`. Only `CLIP` returns objects:
  `getTrackItems(TRANSITION | EMPTY | PREVIEW | FEEDBACK, …)` returns nulls (`[null]`, more with
  `includeEmptyTrackItems = true`) even when a transition exists, so **transitions can't be read** in 26.5.2.
  `getTrackItems(CLIP, true)` puts nulls in the gaps. Skip nulls.

Placing clips — `ppro.SequenceEditor.getEditor(seq)` (`classes/sequenceeditor.md`):

```js
const editor = ppro.SequenceEditor.getEditor(seq);
const at = ppro.TickTime.createWithTicks(time.framesToTicks(48, tb).toString());
await sandbox.transaction("Place SH010", (c) => {
  // overwrite at `at` on V1 / A1 (videoTrackIndex, audioTrackIndex)
  c.addAction(editor.createOverwriteItemAction(clip, at, 0, 0));
  // or insert (ripples later items; limitShift = only shift the targeted tracks):
  // c.addAction(editor.createInsertProjectItemAction(clip, at, 0, 0, false));
});
```

- A track index past the last track **creates a new track** (insert docs).
- The clip lands **full length** (or between its project-item marks, if it has any). Setting the project item's
  in/out earlier in the **same** compound is not honoured (live 26.5.2). Trim the new track item afterwards:
  that's what `premiere-build-sequence` / `premiere-place-audio` do. They park the clips past the sequence end,
  trim them, and move them into place. The linked audio lands on the audio track with the given index and must
  be trimmed and moved too.
- Duplicate: `editor.createCloneTrackItemAction(item, timeOffsetTT, vTrackOffset, aTrackOffset, alignToVideo, isInsert)`.
- MOGRTs: `editor.insertMogrtFromPath(path, tt, vIdx, aIdx)` (sync, not an action).

Track items (`classes/videocliptrackitem.md`, `classes/audiocliptrackitem.md`) — reads (all async):
`getStartTime()`, `getEndTime()`, `getDuration()`, `getInPoint()`, `getOutPoint()` (source-relative),
`getName()`, `getProjectItem()`, `getSpeed()`, `isSpeedReversed()`, `isDisabled()`, `getTrackIndex()`,
`getComponentChain()`. Edit actions:

| Action | Meaning |
|---|---|
Measured live (26.5.2, 30000/1001 sequence, frames). All of these are **edge trims** of one item, with no ripple:

| Action | Meaning | Example |
|---|---|---|
| `createSetInPointAction(tt)` | **Head trim** by media time: in → tt, start moves by the same amount, end stays. | `{start 90, end 209, in 0, out 119}` → `setIn(15)` → start 105, in 15 |
| `createSetStartAction(tt)` | **Head trim** by sequence time: start → tt, in moves by the same amount. | `{start 105, in 15}` → `setStart(100)` → start 100, in 10 |
| `createSetOutPointAction(tt)` | **Tail trim** by media time: out → tt, end moves with it. | `{end 209, out 119}` → `setOut(100)` → end 190, out 100 |
| `createSetEndAction(tt)` | **Tail trim** by sequence time: end → tt, out moves with it. | `{end 190, out 100}` → `setEnd(160)` → end 160, out 70 |
| `createMoveAction(deltaTT)` | Relative shift (not "move to"). Refused at creation ("Invalid parameter.") if start + delta < 0, judged against the item **before** the transaction. | |
| `createSetDisabledAction(bool)` / `createSetNameAction(name)` | Enable/disable, rename. | |

- **Slip** (start/end fixed, media shifted by d) = `setIn(in+d)`, `setOut(out+d)`, `move(-d)`. Order them so
  the clip never overlaps a neighbour on the way: d > 0 → setIn, move(-d), setOut; d < 0 → setOut, move(-d),
  setIn. Verified live for both signs. With d > 0, a clip that starts less than d from 0 can't create its
  `move(-d)` until the head trim has happened, so put that move (and the setOut) in a second transaction.
- **Linked clips are not linked for the API**: moving or trimming the video leaves its audio where it was, and a
  remove with `MediaType.ANY` removes only the selected item (live 26.5.2). Edit both halves yourself;
  `premiere-edit-items` with `mediaType: "both"` does.

```js
// Move item 2 on V1 so it starts at frame 120 and trim 6 frames off its tail: one undo step, actions created first
const items = (await seq.getVideoTrack(0)).getTrackItems(ppro.Constants.TrackItemType.CLIP, false).filter(Boolean);
const it    = items[1];
const start = BigInt((await it.getStartTime()).ticks), end = BigInt((await it.getEndTime()).ticks);
const tt    = (t) => ppro.TickTime.createWithTicks(t.toString());
const delta = time.framesToTicks(120, tb) - start;
await sandbox.transaction("Move + trim", (c) => {
  const acts = [it.createSetEndAction(tt(end - time.framesToTicks(6, tb))), it.createMoveAction(tt(delta))];
  for (const a of acts) c.addAction(a);
});
```

Removing (lift / ripple) — selection objects live only inside the `createEmptySelection` callback:

```js
project.lockedAccess(() => {
  ppro.TrackItemSelection.createEmptySelection((sel) => {
    sel.addItem(it, false);
    const a = editor.createRemoveItemsAction(sel, true /*ripple*/, ppro.Constants.MediaType.ANY, false /*shiftOverLapping*/);
    project.executeTransaction((c) => c.addAction(a), "Ripple delete");
  });
});
```

- Removing the audio track item of a linked clip with `MediaType.AUDIO` removed only the audio (live). Since
  `ANY` also takes only the selected item, select both halves to remove a linked pair. Ripple delete is not
  yet verified live.
- There is no link/unlink API (→ `gaps`), and no API reports which items are linked. The typed tools treat
  items on the other media type with the same start, end and project item as partners.
- Selection: `await seq.getSelection()`, `seq.setSelection(sel)` (**sync** since 26.3), `seq.clearSelection()`.
- Scene edit detection: `ppro.SequenceUtils.performSceneEditDetectionOnSelection(op, sel)`.
- "Nest": `seq.createSubsequence(ignoreTrackTargeting)` makes a sub-sequence from the in/out range; it does
  not replace the clips with a nest (→ `gaps`).

## effects

Component chains (`classes/videocomponentchain.md`, `classes/component.md`, `classes/componentparam.md`,
`classes/keyframe.md`). Intrinsics (Motion, Opacity, Time Remapping…) are already in the chain — enumerate:

```js
const chain = await it.getComponentChain();                 // VideoComponentChain
const out = [];
for (let i = 0; i < chain.getComponentCount(); i++) {       // sync
  const comp = chain.getComponentAtIndex(i);                // sync
  const params = [];
  for (let p = 0; p < comp.getParamCount(); p++) params.push(comp.getParam(p).displayName);
  out.push({ i, name: await comp.getDisplayName(), match: await comp.getMatchName(), params });
}
return out;
```

Add an effect and set a static value:

```js
const fx = await ppro.VideoFilterFactory.createComponent("PR.ADBE Solarize"); // matchName; list: getMatchNames()
await sandbox.transaction("Add effect", (c) => c.addAction(chain.createAppendComponentAction(fx)));
// re-read the chain, then:
const param = (await it.getComponentChain()).getComponentAtIndex(idx).getParam(0);
await sandbox.transaction("Set param", (c) => {
  c.addAction(param.createSetValueAction(param.createKeyframe(50), true /*safeForPlayback*/));
});
```

Keyframes:

```js
await sandbox.transaction("Keyframe opacity", (c) => {
  c.addAction(param.createSetTimeVaryingAction(true));
  for (const [f, v] of [[0, 0], [12, 100]]) {
    const k = param.createKeyframe(v);                      // throws if v doesn't fit the param type
    k.position = ppro.TickTime.createWithTicks(time.framesToTicks(f, tb).toString());
    c.addAction(param.createAddKeyframeAction(k));
  }
});
```

- Values: number | string | boolean | `ppro.PointF` | `ppro.Color`, matching the param type.
- Keyframe positions are relative to the **clip** (item) start, not the sequence *(spike)*.
- Read: `param.getValueAtTime(tt)` (must pass a time), `getStartValue()`, `getKeyframeListAsTickTimes()`,
  `isTimeVarying()`, `areKeyframesSupported()`, `findNextKeyframe(tt)`, `getKeyframePtr(tt)`.
- Remove: `createRemoveKeyframeAction(tt, true)`, `createRemoveKeyframeRangeAction(inTT, outTT, true)`.
- Interpolation: `createSetInterpolationAtKeyframeAction(tt, mode, true)` — mode from
  `ppro.Constants.InterpolationMode` (`LINEAR`, `HOLD`, `BEZIER`, …); or `await k.setTemporalInterpolationMode(n)`.
- Chain edits: `createInsertComponentAction(comp, index)`, `createRemoveComponentAction(comp)`.
- Project-item (master clip) effects: `await clip.getComponentChain(ppro.Constants.MediaType.VIDEO)`.

Transitions (`classes/transitionfactory.md`, `classes/addtransitionoptions.md`) — **video only**:

```js
const names = await ppro.TransitionFactory.getVideoTransitionMatchNames();   // find the Cross Dissolve match name here
const tr    = ppro.TransitionFactory.createVideoTransition(names.find(n => /cross ?dissolve/i.test(n))); // sync
const opts  = new ppro.AddTransitionOptions()
  .setApplyToStart(false)                                   // false = tail of the item
  .setDuration(ppro.TickTime.createWithTicks(time.framesToTicks(12, tb).toString()))
  .setForceSingleSided(false);                              // also: setTransitionAlignment(n) (values undocumented)
await sandbox.transaction("Add dissolve", (c) => c.addAction(it.createAddVideoTransitionAction(tr, opts)));
// remove: it.createRemoveVideoTransitionAction(ppro.Constants.TransitionPosition.END)
```

## audio

- Place music/SFX/VO: `editor.createOverwriteItemAction(clip, at, vIdx, aIdx)` / `createInsertProjectItemAction`
  with the target **audio** index; for audio-only media the video index is ignored *(spike)*.
- Audio track items (`classes/audiocliptrackitem.md`) have the same move/trim/disable/name actions as video items
  and **no transition action**.
- Track mute: `await audioTrack.setMute(true)` (direct call, not an action); `isMuted()`.
- Clip volume: the item's `AudioComponentChain` holds an intrinsic Volume component with a Level param —
  enumerate as in `effects`, then `createSetValueAction` / keyframes. **Units of Level are unverified** (likely
  not raw dB) *(spike)*; prefer `premiere-set-audio` which converts dB.
- Fades: keyframe Level (two keyframes at item start/end), or an audio crossfade (→ `gaps`/sidecar).
- Audio effects: `const fx = await ppro.AudioFilterFactory.createComponentByDisplayName(name, audioItem)`
  (`name` from `await ppro.AudioFilterFactory.getDisplayNames()`), then `chain.createAppendComponentAction(fx)` (`classes/audiofilterfactory.md`).
- Sequence audio settings: `(await seq.getSettings()).getAudioSampleRate()`, `getAudioChannelCount()`.

```js
const a1    = await seq.getAudioTrack(0);
const aItem = a1.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)[0];
const achain = await aItem.getComponentChain();             // AudioComponentChain
// find component whose getDisplayName() is "Volume", param whose displayName is "Level" (spike: names/indices)
```

## markers

`classes/markers.md`, `classes/marker.md`. Owner = a `Sequence` or a `ClipProjectItem`.

```js
const markers = await ppro.Markers.getMarkers(seq);
const tt = (f) => ppro.TickTime.createWithTicks(time.framesToTicks(f, tb).toString());
await sandbox.transaction("Add markers", (c) => {
  c.addAction(markers.createAddMarkerAction("SH010 in", "Comment", tt(0), tt(0), "first shot"));
  c.addAction(markers.createAddMarkerAction("Music hit", "Comment", tt(96), tt(24), ""));
});
// color / edit existing ones (re-read first):
const list = (await ppro.Markers.getMarkers(seq)).getMarkers();   // sync; optional filter ["Comment","Chapter",...]
await sandbox.transaction("Color marker", (c) => c.addAction(list[0].createSetColorByIndexAction(1)));
```

- Types: `"Comment"`, `"Chapter"`, `"Segmentation"`, `"WebLink"` (filters also accept `"FLVCuePoint"`).
- Marker reads (sync): `getName()`, `getStart()`, `getDuration()`, `getComments()`, `getType()`,
  `getColorIndex()`, `guid` (26.3+). Edit: `createSetNameAction`, `createSetCommentsAction`,
  `createSetDurationAction`, `createSetTypeAction`, `markers.createMoveMarkerAction(m, tt)`,
  `markers.createRemoveMarkerAction(m)`.
- Color index ↔ `ppro.Constants.MarkerColor` mapping is undocumented *(spike)*; `MAGENTA` replaces the
  misspelt `MAGNETA` in 26.5.

## export

Prefer `premiere-export` (path check + AME handling). In scripts, every output path must be inside
`sandbox.folder`; the wrapped `ppro` refuses others with `OUTSIDE_FOLDER` **before** queueing.

```js
const em  = ppro.EncoderManager.getManager();               // classes/encodermanager.md
const out = sandbox.path("exports/cut_v001.mp4");
const ok  = await em.exportSequence(seq, ppro.Constants.ExportType.IMMEDIATELY, out,
                                    "D:\\Projects\\MyFilm\\presets\\H264.epr", true /*exportFull*/);
// QUEUE_TO_AME needs Media Encoder: em.isAMEInstalled, await em.launchEncoder(), await em.startBatchEncode()
```

- `ExportType`: `IMMEDIATELY` (in-app, blocks), `QUEUE_TO_AME`, `QUEUE_TO_APP`.
- Extension for a preset: `await ppro.EncoderManager.getExportFileExtension(seq, presetPath)`.
- Single frame: `await ppro.Exporter.exportSequenceFrame(seq, tt, "frame.png", sandbox.folder + "\\stills\\", 1920, 1080)`
  (bmp, dpx, gif, jpg, exr, png, tga, tif) — `classes/exporter.md`.
- Files/items via AME: `em.encodeFile(src, out, preset, inTT, outTT, workArea, removeUponCompletion, startQueueImmediately)`,
  `em.encodeProjectItem(clip, out, preset, workArea, removeUponCompletion, startQueueImmediately)`.
- Progress events: `ppro.EventManager.addEventListener(em, ppro.Constants.EncoderEvent.RENDER_COMPLETE, fn)`
  (also `RENDER_ERROR`, `RENDER_PROGRESS`) — a script returns before AME finishes; poll the output file instead.
- XMP: `em.setEmbeddedXMPEnabled(bool)`, `em.setSidecarXMPEnabled(bool)`.
- Also path-checked: `ProjectConverter.export*` (AAF via `exportAAF` + `AAFExportOptions`), `Transcript.exportToJSON`,
  `Project.saveAs` (use `sandbox.saveAs` — the folder follows the new path), scratch-disk changes via
  `ProjectSettings.createSetScratchDiskSettingsAction` (only to the sandbox).
- `saveAs` re-points the `Project` object to the **copy** (26.5 docs).

## gaps

Not scriptable from UXP (spec §11) — Claude asks you to do these by hand:
- arbitrary menu commands and keyboard shortcuts (no API in UXP or ExtendScript);
- rendering previews;
- creating multicam sequences (`ClipProjectItem.isMulticamClip()` is read-only);
- true Nest — `Sequence.createSubsequence` only makes a new sequence from a range;
- panel focus and workspaces;
- dismissing arbitrary modal dialogs (only the suppress flags on `importFiles` / `OpenProjectOptions` /
  `CloseProjectOptions` exist);
- applying `.ffx` / effect presets;
- complex Lumetri curves (unconfirmed);
- UI automation is deliberately out of scope.

Confirmed missing from UXP in 26.5.2 → routed to the **B-lite CEP/ExtendScript sidecar** (`prx_*` files); without
it the typed tools return `NEEDS_SIDECAR_UNAVAILABLE`:
- **set speed / reverse / time remap**: `getSpeed`/`isSpeedReversed` are read-only, and a clip's component chain
  has no Time Remapping (video: Opacity, Motion; audio: "Internal Volume Mono" with params Mute and Level)
  → `premiere-set-speed`;
- **link / unlink** clips (no API; linked items aren't even reported);
- **audio transitions / crossfades**: `TransitionFactory` only has `createVideoTransition` /
  `getVideoTransitionMatchNames`, and audio track items have no transition action;
- **add / delete / lock / target tracks** (only implicit creation by inserting past the last track).

Other limits worth knowing
- Transitions can't be read back (`getTrackItems(TRANSITION)` returns nulls), so `premiere-get-sequence` can't
  list them.
- Open-project discovery (`ProjectUtils.getProjectViewIds()` → `getProjectFromViewId(guid)`) returned every
  project the spike knew of (two open, live 26.5.2).
- `changeMediaFilePath`, `attachProxy` are not undoable; `importFiles` is not part of a transaction.
- No paste-attributes, waveform/peak read or "match frame" API in the reference.
- Time-varying reads need an explicit time: `getValueAtTime()` without a `TickTime` rejects (26.5).
