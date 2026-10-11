# Premiere capability spike: results

Spec §9 step 2. Run on **Premiere Pro 26.5.2** (Windows) through the UXP panel v1.0.1. Every command targeted a
throwaway project created under `%TEMP%\pr-mcp-e2e-spike-<stamp>\edit\Spike.prproj`, holding a few
ffmpeg-generated clips (640x360, 30000/1001, 4 s, AAC audio) and a WAV. Two passes:

1. the typed tools end to end (import, sequence, build, markers, move/trim/remove, place audio, set audio,
   transitions, speed, frame export, relink, save) plus an API inventory probe;
2. targeted `runScript` probes to settle the semantics behind the bugs that pass 1 found.

Paths below are placeholders (`D:\Projects\MyFilm\...`).

## The spike questions

| | Question | Answer (live evidence) |
|---|---|---|
| a | Does `ProjectUtils.getProjectViewIds()` list all open projects? Does `Project.open` on an open path return the open instance? | **Partly answered.** `getState` (registry from `getProjectViewIds` → `getProjectFromViewId`) listed both open projects, the user's and the throwaway. `Project.open` on an already-open path was not exercised: `premiere-open-project` targets an open project without calling it. Still open. |
| b | Can time remap / speed be set via `ComponentParam`? | **No.** Track items have only `getSpeed()` / `isSpeedReversed()`. A clip's component chain is Opacity (`AE.ADBE Opacity`) and Motion (`AE.ADBE Motion`) for video, and Volume (`Internal Volume Mono`, params `Mute` and `Level`) for audio. There is no Time Remapping component. Speed goes to the sidecar. |
| c | Can audio-only be removed from a linked clip, and does ripple delete work? | **Audio-only: yes.** `createRemoveItemsAction(sel, false, MediaType.AUDIO)` on the A1 item removed only the audio; the video stayed. Also, `MediaType.ANY` on a video item removes **only that item**: the linked audio stays. **Ripple delete: not verified** (only lift removes were run). |
| d | Can audio transitions be added from UXP? | **No.** `TransitionFactory` has only `createVideoTransition` and `getVideoTransitionMatchNames` (80+ video match names, e.g. `AE.ADBE Cross Dissolve New`). Audio track items have no transition action. Audio crossfades go to the sidecar. |
| e | Do `setInterval` timers run while the panel is hidden? | **Not answered.** The panel answered every command during the spike, but whether it was hidden at the time wasn't recorded. Still open: hide the panel and send `getState`. |
| f | Is `fs` rename-over-existing atomic enough, or is remove-then-rename needed? | **Rename over an existing file works** in UXP `fs`: `rename(a, b)` replaced `b`'s content with `a`'s. Atomicity under a concurrent reader wasn't measured. The panel keeps remove-then-rename (as in AE), which also worked for every result written. |
| g | Can the wrapped `require` shadow the plugin's `require` inside `new Function`? | **Yes.** In a script, `require("fs")` returned the guarded fs (`writeFile` / `writeFileSync` outside the folder → `OUTSIDE_FOLDER`, nothing written), `require("child_process")` was refused, and `require("uxp")` exposed only `host`, `storage`, `versions`. The static scan also refuses any `constructor` property access (`BLOCKED_CALL`), which blocks generic introspection helpers too. |
| h | Which calls pop modal dialogs? | **None observed** for `Project.createProject`, `importFiles` (suppressUI = true; .mp4, .wav), `createSequenceFromMedia`, `save`, `Exporter.exportSequenceFrame`, `changeMediaFilePath`, or any transaction. Not exercised: `Project.open` (missing media, version conversion), AME/direct video export, overwriting an existing export. |

## Facts established live

**Paths and project tree**
- Project paths come back as `\\?\C:\...` (Win32 long-path prefix). Stripped by `stripLongPathPrefix` (fixed earlier).
- `ProjectItem.type` for a bin is `2`. There is no `Constants.ProjectItemType`. Clips and sequences are told
  apart by `ClipProjectItem.isSequence()`.
- A project item without in/out marks reports **-400000 s** (`-101606400000000000` ticks) for both
  `getInPoint(mt)` and `getOutPoint(mt)`, video and audio alike. That value means "unset".
- `Project` also has `importAEComps`, `importAllAEComps`, `importSequences`, `createSequenceWithPresetPath`,
  `getInsertionBin`, `pauseGrowing`, `lockedAccess`, `executeTransaction`.

**Time**
- `Sequence.getTimebase()` returns a **Promise**, which resolves to ticks per frame as a string: `8475667200`
  at 29.97.
- `TickTime` has `createWithTicks`, `createWithSeconds`, `createWithFrameAndFrameRate`, plus constants
  `TIME_ZERO`, `TIME_ONE_SECOND`, `TIME_ONE_MINUTE`, `TIME_ONE_HOUR`, `TIME_MAX`, `TIME_MIN`, `TIME_INVALID`.
  Negative tick strings are accepted.
- `FootageInterpretation.getFrameRate()` gave 29.97 for 30000/1001 media and no usable rate for a WAV.

**Timeline**
- `TrackItemType` = `{ EMPTY: 0, CLIP: 1, TRANSITION: 2, PREVIEW: 3, FEEDBACK: 4 }`. `MediaType` values are
  opaque objects (`ANY`, `DATA`, `VIDEO`, `AUDIO`).
- `getTrackItems(CLIP, false)` returns objects but **not in time order**. `getTrackItems(TRANSITION | EMPTY |
  PREVIEW | FEEDBACK, false)` returns `[null]`, with or without a transition on the track. With
  `includeEmptyTrackItems = true`, every list has nulls (CLIP puts them in the gaps). **Transitions can't be
  read back.** That's why `getSequence` crashed: `null.getStartTime()`.
- **Placing:** `createOverwriteItemAction` lands the project item **full length** (or between its marks).
  Setting the project item's in/out in the same compound just before it is **not** honoured. The first build
  placed both clips full length; its own read-back reported `verified: false` yet returned success.
- **Track-item actions are edge trims.** Measured in frames on a 30000/1001 sequence:

  | Start state | Action | Result |
  |---|---|---|
  | start 90, end 209, in 0, out 119 | `createSetInPointAction(15)` | start 105, in 15 (head moves, end stays) |
  | … | `createSetOutPointAction(100)` | end 190, out 100 |
  | … | `createSetEndAction(160)` | end 160, out 70 |
  | start 105, in 15 | `createSetStartAction(100)` | start 100, in 10 (head trim) |
  | start 0, end 60, in 10, out 70 (neighbour at 60) | slip −3: `setOut(67)`, `move(+3)`, `setIn(7)` | start 0, end 60, in 7, out 67 |
  | start 60, end 145, in 12, out 97 (neighbour ends at 60) | slip +3: `setIn(15)`, `move(-3)`, `setOut(100)` | start 60, end 145, in 15, out 100 |

- `createMoveAction(t)` is a **relative shift**. Creating one whose result would start before 0 throws
  "Invalid parameter.". The check uses the item **as it is before the transaction**, so a head trim added
  earlier in the same compound doesn't count. A move that passes at creation but would land before 0 when it
  runs is **silently skipped**.
- Within one compound, actions apply in order on the same item. Creating `setIn`, `setOut` and `move` for one
  item before adding any of them gave the expected cumulative result.
- **Linked clips:** moving the video item (+30 frames) left its audio at 0. Trims don't follow the partner
  either. So `EXPLICIT_PARTNER_EDITS = true` is correct: the typed tools edit partners themselves. (The first
  typed move showed `partners: 1` with the audio moved exactly once, which fits.)
- Track item objects stay valid across transactions; a reference read before a transaction reflects the new
  state afterwards.
- **Relink** (`changeMediaFilePath(path, false)`) to a longer file of the same format: every timeline use kept
  its start/end/in/out. A path that doesn't exist returns `false` rather than throwing.
- Marker colour `"Green"` mapped to index 0, and `createSetColorByIndexAction(0)` was accepted.

**Transactions: hazards found**
- If the callback throws after some `addAction` calls, **those actions stay applied**. A move created after
  `setIn`/`setOut` had been added threw "Invalid parameter.", and the trims were left in place. The typed
  commands now create every action first and add them afterwards.
- Creating a second overwrite after adding (and so applying) a move plus an overwrite in the same callback
  failed with "The script object is no longer valid.". Creating both overwrites first worked.
- **Premiere got into a stuck state.** Later in the session, every `createSetInPointAction` /
  `createSetOutPointAction` / `createSetStartAction` / `createSetEndAction`, on every track item in every
  sequence (new ones too), threw "The script object is no longer valid.". Moves, renames, enable/disable and
  relinks still worked. The v1.0.1 typed `editItems` trim failed the same way. It started after transactions
  in which trim actions were created and the callback then threw. It cleared once on its own, then came back,
  and saving didn't clear it. A Premiere restart is expected to clear it.
- Inside `runScript`, `TrackItemSelection.createEmptySelection((sel) => sel.addItem(item, true))` fails with
  "Illegal Parameter type". The typed tools' removes, which run outside the script membrane, work.

**Not in UXP** (routed to the sidecar by its own change): speed and time remap, audio transitions, link/unlink.

## Fixes made from these results

| Area | Change |
|---|---|
| `buildSequence`, `placeAudio` (`shared.placeAndTrim`) | Clips are overwritten full length, parked past the sequence end and every target. They are then trimmed on the timeline (`setIn`/`setOut`, linked audio included) and moved into place. That's 2 undo steps, or 3 when a clip's target is earlier than its head trim (the move can't be created before the trim). Unwanted halves (`withAudio: false`, the video of music) are removed in the trim transaction. A read-back mismatch returns `VERIFY_FAILED` with `mismatches` instead of success. Project-item marks are never touched. `replace` also clears the cleared clips' linked audio. `placeAudio` `insert` refuses `in`/`out`. |
| `editItems` | Comments state the measured semantics. A slip is `setIn(in+d)`, `move(-d)`, `setOut(out+d)` in an order that never overlaps a neighbour, with a second transaction when the move can't be created yet. `trim` refuses `start`+`in` or `end`+`out` together and checks the result against 0 and the media length. Each result carries `after` (start/end/in/out read back). `remove` with `mediaType: "both"` removes the partner too. Only one timing edit per clip per call. |
| `getSequence` | Skips null track items. Transitions are listed when Premiere returns objects; otherwise `transitionsNote` explains they can't be read. |
| `replaceMedia`, `getProjectItems`, `preparePlacement` | The -400000 s sentinel (any negative or over-a-year value) reads as unset (`null`) and is never "restored". |
| `clipItems` | Skips nulls and sorts by start. |
| `refs` | The item-type comment records the confirmed bin value. |
| Fake ppro (`test/premiere-commands-fakeppro.test.mjs`) | Models all of the above: full-length placement, edge trims, move refusal at creation, independent partners, null transition lists, unset marks. |

## `// SPIKE:` items

**Resolved** (comment rewritten to state the finding): `getTimebase` return type; project-item type values;
`EXPLICIT_PARTNER_EDITS`; project-item in/out before an insert (doesn't work, replaced); 0-based track
indices for editor actions; `createSetStart/End` and `createSetIn/OutPoint` semantics; linked-audio removal with
`MediaType.AUDIO`; `changeMediaFilePath` keeps trims; `createProject` opens no dialog; `createMoveItemAction` on
the destination bin; `exportSequenceFrame` arguments; `importFiles` with suppressUI opens no dialog; the Volume
component's names; `getFrameRate` for video and audio-only media.

**Still open**
- Ripple delete (`createRemoveItemsAction(..., ripple = true)`).
- Whether `importFiles` and sequence creation add an undo step (each is counted as one).
- Drop-frame display-format codes at 59.94; a drop-frame flag on clips.
- `setAudio`: the Level value encoding (`10^((dB-15)/20)`) and keyframe positions in clip media time.
- `addMarkers`: that `MarkerColor` indexes are what `createSetColorByIndexAction` shows in the UI.
- `addTransition`: display-name aliases and centring on the cut.
- `exportSequence`: what `exportFull = false` exports, and whether an existing output is overwritten silently.
- `openProject`: dialogs (missing media, conversion); `Project.open` on an open path (a).
- `placeAudio`: what happens to the video of A/V media in `insert` mode.
- `importAEComps` (new): not run live, because no throwaway `.aep` can be made without After Effects. To check:
  the linked items' names, any sub-bin, the undo step, and no dialogs.
- Spike e (timers while hidden).
- What triggers the stuck "script object is no longer valid" state, and whether creating every action first
  avoids it.

## Needs a Premiere restart to verify

The new command code is in panel 1.0.2. The running panel is 1.0.1, and Premiere is in the stuck state above,
so none of the fixes could be checked through the typed tools. After restarting Premiere (which loads 1.0.2),
rerun the typed pass on a fresh throwaway project:

- the build with in/out (`SH010 in 10 out 70`, `SH020 in 0:15 out 100`) should give `verified: true`,
  `undoSteps` 3 and both clips trimmed on V1 and A1;
- `getSequence` after `addTransition` should succeed;
- a slip on a clip at 0 should take two transactions;
- `replaceMedia` on an unmarked clip should report `trims: { in: null, out: null }`.

Each fix was checked against script probes of the same API calls and against the fake-model tests.
