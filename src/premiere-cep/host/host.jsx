// MCP Bridge sidecar: ExtendScript host for Premiere Pro (B-lite, docs/premiere-bridge-spec.md section 8).
// Loaded by the CEP panel through <ScriptPath> in CSXS/manifest.xml. The panel's JS (js/core.js) owns the
// polling, gate, stamps, backups and heartbeat; this file only does what needs Premiere's scripting DOM:
//   listProjects, saveProject, setSpeed, addAudioTransition, link, unlink.
//
// ES3 only (ExtendScript): no let/const/arrow functions, no Array.prototype.indexOf/forEach/map/filter,
// no String.prototype.trim, Object.keys, Array.isArray or JSON (Premiere 26's ExtendScript has no native
// JSON, see the polyfill below).
//
// Entry point: __mcpSidecar_call(name, argsObject) returns a JSON string. The panel builds the call with an
// object literal (js/core.js buildEvalCall), so nothing here needs JSON.parse.
//
// Sources for the APIs used:
//  - Documented ExtendScript DOM: https://ppro-scripting.docsforadobe.dev/ (Application.projects,
//    Project.save, Project.activeSequence, Sequence.linkSelection / unlinkSelection / getSelection,
//    TrackItem.setSelected / getSpeed / isSpeedReversed / getLinkedItems, Track.clips / transitions).
//  - QE DOM (undocumented, unsupported by Adobe; app.enableQE() then the global `qe`). Method lists from
//    live reflect.methods dumps on 26.3.2:
//    https://github.com/leancoderkavy/premiere-pro-mcp/issues/295 and
//    https://github.com/skrfilms/premiere-mcp/blob/main/docs/VERIFIED-API-SURFACE.md
//    Bruce Bullis (Adobe): "the QE DOM will remain undocumented, and unsupported":
//    https://community.adobe.com/t5/premiere-pro/setspeed-bad-argument-list/td-p/10079476

// === BEGIN SIDECAR JSON ===
// Pure ES3. Results are written by the panel as JSON, so keep stringify strict: control characters and
// everything outside ASCII are \u-escaped.
var MCPSidecarJSON = (function () {
    function hex4(n) {
        var s = n.toString(16);
        while (s.length < 4) s = "0" + s;
        return s;
    }
    function esc(str) {
        var out = "";
        var s = String(str);
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            var code = s.charCodeAt(i);
            if (c === "\\") out += "\\\\";
            else if (c === "\"") out += "\\\"";
            else if (c === "\n") out += "\\n";
            else if (c === "\r") out += "\\r";
            else if (c === "\t") out += "\\t";
            else if (code < 32 || code > 126) out += "\\u" + hex4(code);
            else out += c;
        }
        return out;
    }
    function stringify(val, depth) {
        depth = depth || 0;
        if (depth > 12) return "null";
        if (val === null || val === undefined) return "null";
        var t = typeof val;
        if (t === "number") return isFinite(val) ? String(val) : "null";
        if (t === "boolean") return val ? "true" : "false";
        if (t === "string") return "\"" + esc(val) + "\"";
        if (t === "function") return "null";
        if (val instanceof Array) {
            var a = [];
            for (var i = 0; i < val.length; i++) a.push(stringify(val[i], depth + 1));
            return "[" + a.join(",") + "]";
        }
        if (t === "object") {
            var props = [];
            for (var k in val) {
                if (!val.hasOwnProperty(k)) continue;
                var v = val[k];
                if (v === undefined || typeof v === "function") continue;
                props.push("\"" + esc(k) + "\":" + stringify(v, depth + 1));
            }
            return "{" + props.join(",") + "}";
        }
        return "\"" + esc(String(val)) + "\"";
    }
    return { stringify: function (v) { return stringify(v, 0); } };
})();
// === END SIDECAR JSON ===

// === BEGIN PATH POLICY ===
// Pure ES3; same rules as the AE panel's MCPPathPolicy (src/scripts/mcp-bridge-auto.jsx) and the UXP
// panel's lib/pathPolicy.js, plus the Win32 long-path prefix Premiere 26.5 puts on project paths
// (\\?\C:\..., \\?\UNC\server\share\...). Loaded by test/premiere-sidecar-host.test.mjs.
var MCPPathPolicy = (function () {
    function stripLongPathPrefix(p) {
        var s = (p === null || p === undefined) ? "" : String(p);
        if (/^[\\\/]{2}[?.][\\\/]UNC[\\\/]/i.test(s)) return "\\\\" + s.substring(8);
        if (/^[\\\/]{2}[?.][\\\/]/.test(s)) return s.substring(4);
        return s;
    }

    // Absolute Windows path -> canonical lowercase form with "/" separators, or null if not absolute/invalid.
    function normalize(p) {
        if (p === null || p === undefined) return null;
        var s = stripLongPathPrefix(p).replace(/\\/g, "/");
        if (s.length === 0) return null;
        var prefix;
        var rest;
        var m = /^([a-zA-Z]):(\/.*)?$/.exec(s);
        if (m) {
            prefix = m[1].toLowerCase() + ":";
            rest = m[2] || "/";
        } else if (/^\/\/[^\/]+\/[^\/]+/.test(s)) {
            var parts = s.substring(2).split("/");
            prefix = "//" + parts[0].toLowerCase() + "/" + parts[1].toLowerCase();
            rest = "/" + parts.slice(2).join("/");
        } else if (/^\/[a-zA-Z](\/|$)/.test(s)) {
            prefix = s.charAt(1).toLowerCase() + ":";
            rest = s.substring(2) || "/";
        } else {
            return null;
        }
        var segs = rest.split("/");
        var out = [];
        for (var i = 0; i < segs.length; i++) {
            var seg = segs[i];
            if (seg === "" || seg === ".") continue;
            if (seg === "..") {
                if (out.length === 0) return null;
                out.pop();
                continue;
            }
            out.push(seg.toLowerCase());
        }
        return prefix + "/" + out.join("/");
    }

    function samePath(a, b) {
        var na = normalize(a);
        return na !== null && na === normalize(b);
    }

    return { normalize: normalize, samePath: samePath, stripLongPathPrefix: stripLongPathPrefix };
})();
// === END PATH POLICY ===

// === BEGIN SIDECAR PURE ===
// Pure ES3 helpers with no Premiere APIs; test/premiere-sidecar-host.test.mjs evaluates this block in Node.
var MCPSidecarPure = (function () {
    var TICKS_PER_SECOND = 254016000000;

    function trim(s) {
        return String(s === null || s === undefined ? "" : s).replace(/^\s+|\s+$/g, "");
    }

    // "V1" / "a2" -> { type: "video" | "audio", index0, label }, or null.
    function parseTrackRef(ref) {
        var m = /^\s*([VvAa])\s*(\d+)\s*$/.exec(typeof ref === "string" ? ref : "");
        if (!m || Number(m[2]) < 1) return null;
        var type = m[1].toLowerCase() === "v" ? "video" : "audio";
        var index0 = Number(m[2]) - 1;
        return { type: type, index0: index0, label: (type === "video" ? "V" : "A") + (index0 + 1) };
    }

    // "Edits/Main" or "Edits\\Main" -> ["Edits", "Main"] (trimmed, empty segments dropped).
    function splitItemPath(p) {
        var parts = String(p === null || p === undefined ? "" : p).replace(/\\/g, "/").split("/");
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var s = trim(parts[i]);
            if (s !== "") out.push(s);
        }
        return out;
    }

    function nameKey(s) {
        return trim(s).toLowerCase();
    }

    // Indices of entries sorted by start ticks (stable), matching the UXP getSequence clip order.
    // entries: [{ start: number }]
    function orderByStart(entries) {
        var idx = [];
        for (var i = 0; i < entries.length; i++) idx.push(i);
        // Insertion sort keeps equal starts in DOM order (ES3 Array.sort is not guaranteed stable).
        for (var j = 1; j < idx.length; j++) {
            var cur = idx[j];
            var k = j - 1;
            while (k >= 0 && entries[idx[k]].start > entries[cur].start) {
                idx[k + 1] = idx[k];
                k--;
            }
            idx[k + 1] = cur;
        }
        return idx;
    }

    // Nominal integer frame rate of a sequence timebase (ticks per frame as a string or number):
    // 10594584000 (23.976) -> 24, 8475667200 (29.97) -> 30.
    function nominalFps(ticksPerFrame) {
        var t = parseFloat(ticksPerFrame);
        if (!t || isNaN(t) || t <= 0) return null;
        return Math.round(TICKS_PER_SECOND / t);
    }

    function pad2(n) {
        return n < 10 ? "0" + n : String(n);
    }

    // Frame count -> "HH:MM:SS:FF" counted at the nominal rate. This is the duration form QE addTransition
    // reads; a bare frame count string ("12") is not read as frames (leancoderkavy/premiere-pro-mcp #773,
    // live on 26.5.1).
    function framesToTimecode(frames, fps) {
        var f = Math.max(0, Math.round(frames));
        var r = Math.max(1, Math.round(fps));
        return pad2(Math.floor(f / (r * 3600))) + ":" + pad2(Math.floor(f / (r * 60)) % 60) + ":" +
            pad2(Math.floor(f / r) % 60) + ":" + pad2(f % r);
    }

    // Validates setSpeed args. Returns { error } or { ratio, reverse, ripple, maintainPitch }.
    function speedArgs(a) {
        a = a || {};
        var p = a.percent;
        if (typeof p !== "number" || !isFinite(p) || p <= 0 || p > 10000) return { error: "percent must be a number > 0 and <= 10000" };
        var names = ["reverse", "ripple", "maintainPitch"];
        var defaults = [false, true, true];
        var out = { ratio: p / 100 };
        for (var i = 0; i < names.length; i++) {
            var v = a[names[i]];
            if (v === undefined || v === null) v = defaults[i];
            if (typeof v !== "boolean") return { error: names[i] + " must be a boolean" };
            out[names[i]] = v;
        }
        return out;
    }

    // Validates addAudioTransition args. Returns { error } or { edges: [applyToStart...], type, durationFrames }.
    function transitionArgs(a) {
        a = a || {};
        var edge = a.edge;
        if (edge !== "start" && edge !== "end" && edge !== "both") return { error: "edge must be \"start\", \"end\" or \"both\"" };
        var d = a.durationFrames;
        if (typeof d !== "number" || !isFinite(d) || Math.floor(d) !== d || d < 1) return { error: "durationFrames must be a positive integer", code: "BAD_TIME" };
        var type = (a.type === undefined || a.type === null || trim(a.type) === "") ? "Constant Power" : trim(a.type);
        var edges = edge === "both" ? [true, false] : [edge === "start"];
        return { edges: edges, type: type, durationFrames: d };
    }

    // Validates link/unlink items. Returns { error } or { items: [{ track, index }] }.
    function linkArgs(a) {
        a = a || {};
        var items = a.items;
        if (!(items instanceof Array) || items.length < 1) return { error: "items must be a non-empty array of { track, index }" };
        var out = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i] || {};
            if (!parseTrackRef(it.track)) return { error: "items[" + i + "].track must look like \"V1\" or \"A2\"" };
            if (typeof it.index !== "number" || Math.floor(it.index) !== it.index || it.index < 0) return { error: "items[" + i + "].index must be a 0-based integer" };
            for (var j = 0; j < out.length; j++) {
                if (out[j].track.toUpperCase() === it.track.toUpperCase() && out[j].index === it.index) return { error: "items[" + i + "] repeats " + it.track + " #" + it.index };
            }
            out.push({ track: trim(it.track).toUpperCase(), index: it.index });
        }
        return { items: out };
    }

    return {
        TICKS_PER_SECOND: TICKS_PER_SECOND,
        trim: trim, parseTrackRef: parseTrackRef, splitItemPath: splitItemPath, nameKey: nameKey,
        orderByStart: orderByStart, nominalFps: nominalFps, framesToTimecode: framesToTimecode,
        speedArgs: speedArgs, transitionArgs: transitionArgs, linkArgs: linkArgs
    };
})();
// === END SIDECAR PURE ===

(function () {
    var P = MCPSidecarPure;
    var J = MCPSidecarJSON;
    var PATHS = MCPPathPolicy;

    function fail(code, message, extra) {
        var e = new Error(message);
        e.mcpCode = code;
        e.extra = extra || null;
        return e;
    }

    function ticksOf(t) {
        try {
            return parseFloat(t.ticks);
        } catch (e) {
            return NaN;
        }
    }

    // --- projects ---

    function projectList() {
        var out = [];
        var activePath = "";
        try { activePath = app.project ? String(app.project.path) : ""; } catch (e) { activePath = ""; }
        var n = 0;
        try { n = app.projects.numProjects; } catch (e2) { n = 0; }
        for (var i = 0; i < n; i++) {
            var p = app.projects[i];
            if (!p) continue;
            var path = PATHS.stripLongPathPrefix(p.path);
            out.push({ path: path, name: String(p.name), isActive: PATHS.samePath(path, activePath) });
        }
        return out;
    }

    // The open project at path (case, separator and \\?\ tolerant), via app.projects.
    function findProject(path) {
        var n = 0;
        try { n = app.projects.numProjects; } catch (e) { n = 0; }
        for (var i = 0; i < n; i++) {
            var p = app.projects[i];
            if (p && PATHS.samePath(p.path, path)) return p;
        }
        throw fail("PROJECT_NOT_OPEN", "Not open in Premiere: " + path);
    }

    // QE (qe.project) and the selection-based link calls work on the active project only.
    function requireActive(project) {
        var activePath = "";
        try { activePath = app.project ? String(app.project.path) : ""; } catch (e) { activePath = ""; }
        if (!PATHS.samePath(project.path, activePath)) {
            throw fail("TARGET_NOT_ACTIVE", "The sidecar can only edit the active project (QE and the timeline selection follow it). " +
                "Ask the user to bring " + String(project.name) + " to the front in Premiere, then retry.",
                { activeProject: PATHS.stripLongPathPrefix(activePath) });
        }
    }

    // --- sequences ---

    // nodeId -> "/"-separated project path of every item under root (bins walked recursively).
    function itemPaths(project) {
        var map = {};
        function walk(item, prefix) {
            var kids = item.children;
            if (!kids) return;
            for (var i = 0; i < kids.numItems; i++) {
                var c = kids[i];
                if (!c) continue;
                var path = prefix ? prefix + "/" + c.name : String(c.name);
                map[String(c.nodeId)] = path;
                // ProjectItemType.BIN === 2 (ppro-scripting.docsforadobe.dev, ProjectItem.type).
                if (c.type === 2) walk(c, path);
            }
        }
        walk(project.rootItem, "");
        return map;
    }

    // ref: "Name", "Bin/Name", { id }, { path }, { name }. Same forms as the UXP refs.resolveSequence.
    function resolveSequence(project, ref) {
        var seqs = project.sequences;
        var n = seqs ? seqs.numSequences : 0;
        var matches = [];
        var i;
        var pathRef = null;
        if (typeof ref === "string") {
            if (P.splitItemPath(ref).length > 1) pathRef = ref;
        } else if (ref && typeof ref.path === "string") {
            pathRef = ref.path;
        }
        if (pathRef !== null) {
            var want = P.splitItemPath(pathRef).join("/").toLowerCase();
            var paths = itemPaths(project);
            for (i = 0; i < n; i++) {
                var pi = seqs[i].projectItem;
                var p = pi ? paths[String(pi.nodeId)] : undefined;
                if (p !== undefined && P.splitItemPath(p).join("/").toLowerCase() === want) matches.push(seqs[i]);
            }
        } else if (ref && typeof ref === "object" && ref.id !== undefined && ref.id !== null) {
            var id = String(ref.id).toLowerCase();
            for (i = 0; i < n; i++) {
                var s = seqs[i];
                var nodeId = "";
                try { nodeId = String(s.projectItem.nodeId); } catch (e) { nodeId = ""; }
                if (String(s.sequenceID).toLowerCase() === id || nodeId === String(ref.id)) matches.push(s);
            }
        } else {
            var name = typeof ref === "string" ? ref : (ref && typeof ref.name === "string" ? ref.name : null);
            if (name === null) throw fail("BAD_ARGS", "sequence must be a name, project path, {id} or {path}");
            for (i = 0; i < n; i++) {
                if (P.nameKey(seqs[i].name) === P.nameKey(name)) matches.push(seqs[i]);
            }
        }
        if (matches.length === 0) throw fail("SEQUENCE_NOT_FOUND", "No sequence matches " + J.stringify(ref));
        if (matches.length > 1) {
            var names = [];
            for (i = 0; i < matches.length; i++) names.push(String(matches[i].name) + " (" + String(matches[i].sequenceID) + ")");
            throw fail("AMBIGUOUS_ITEM", "More than one sequence matches " + J.stringify(ref) + ": " + names.join(", "), { candidates: names });
        }
        return matches[0];
    }

    // Makes seq the active sequence (QE reads qe.project.getActiveSequence()). Returns the previous one.
    function activate(project, seq) {
        var prev = null;
        try { prev = project.activeSequence; } catch (e) { prev = null; }
        if (!prev || String(prev.sequenceID) !== String(seq.sequenceID)) {
            // Project.activeSequence is read/write (ppro-scripting.docsforadobe.dev, Project object).
            project.activeSequence = seq;
        }
        return prev;
    }

    function restoreActive(project, prev, seq) {
        if (!prev || String(prev.sequenceID) === String(seq.sequenceID)) return;
        try { project.activeSequence = prev; } catch (e) { /* best effort */ }
    }

    // --- tracks and clips ---

    function domTrack(seq, ref) {
        var t = P.parseTrackRef(ref);
        if (!t) throw fail("BAD_ARGS", "Track must look like \"V1\" or \"A2\" (1-based), got " + J.stringify(ref));
        var coll = t.type === "video" ? seq.videoTracks : seq.audioTracks;
        if (t.index0 >= coll.numTracks) {
            throw fail("BAD_ARGS", "Track " + t.label + " does not exist (the sequence has " + coll.numTracks + " " + t.type + " tracks)");
        }
        t.track = coll[t.index0];
        return t;
    }

    // Clip i (0-based, ordered by start, as premiere-get-sequence reports) on a DOM track.
    function domClip(t, index) {
        var clips = t.track.clips;
        var entries = [];
        for (var i = 0; i < clips.numItems; i++) entries.push({ start: ticksOf(clips[i].start), item: clips[i] });
        var order = P.orderByStart(entries);
        if (typeof index !== "number" || index < 0 || index >= order.length) {
            throw fail("ITEM_NOT_FOUND", t.label + " has no clip at index " + index + " (it has " + order.length + ")");
        }
        return { item: entries[order[index]].item, index: index, all: entries, order: order };
    }

    // QE track items include gaps ("Empty") and transitions, so the DOM index can't be reused: match the
    // "Clip" item by start ticks (hetpatel-11/Adobe_Premiere_Pro_MCP __findQeClipByDomClip, verified on 26.0.2).
    function qeClipFor(t, clip) {
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) throw fail("QE_UNAVAILABLE", "QE has no active sequence.");
        var qeTrack = t.type === "video" ? qeSeq.getVideoTrackAt(t.index0) : qeSeq.getAudioTrackAt(t.index0);
        if (!qeTrack) throw fail("QE_UNAVAILABLE", "QE has no track " + t.label + ".");
        var want = ticksOf(clip.start);
        for (var i = 0; i < qeTrack.numItems; i++) {
            var it = null;
            try { it = qeTrack.getItemAt(i); } catch (e) { it = null; }
            if (!it) continue;
            // Only `type` and `start` are read: some QE item properties (reverse, alignment, borderWidth, ...)
            // kill the whole evalScript when read on 26.3.2 (skrfilms/premiere-mcp VERIFIED-API-SURFACE.md).
            var type = "";
            try { type = String(it.type); } catch (e2) { type = ""; }
            if (type !== "Clip") continue;
            var st = NaN;
            try { st = ticksOf(it.start); } catch (e3) { st = NaN; }
            if (Math.abs(st - want) < 1) return it;
        }
        throw fail("QE_UNAVAILABLE", "QE has no clip on " + t.label + " starting at " + want + " ticks.");
    }

    function clipInfo(clip) {
        var out = { name: String(clip.name), startTicks: String(clip.start.ticks), endTicks: String(clip.end.ticks) };
        try { out.speed = clip.getSpeed(); } catch (e) { out.speed = null; }
        try { out.reversed = !!clip.isSpeedReversed(); } catch (e2) { out.reversed = null; }
        out.durationTicks = String(ticksOf(clip.end) - ticksOf(clip.start));
        return out;
    }

    // --- operations ---

    function saveProject(a) {
        var project = findProject(a.projectPath);
        var ok;
        try {
            ok = project.save();
        } catch (e) {
            throw fail("SAVE_FAILED", "Save before run failed, nothing was run: " + e);
        }
        if (ok === false) throw fail("SAVE_FAILED", "Save before run failed (project.save() returned false), nothing was run.");
        return { status: "success", path: PATHS.stripLongPathPrefix(project.path) };
    }

    // QE TrackItem.setSpeed(rate, duration, reverse, maintainAudioPitch, rippleEdit): five positional
    // arguments; fewer throw "Not Enough Parameters". rate is a ratio (0.5 = 50%). Argument order from two
    // independent live reports: skrfilms/premiere-mcp VERIFIED-API-SURFACE.md (26.3.2, "Verified via DOM
    // getSpeed() 1.0 -> 0.5") and hetpatel-11/Adobe_Premiere_Pro_MCP src/bridge/index.ts __setClipSpeed.
    // The second argument is the least certain: hetpatel passes a tick string with "" as fallback, skrfilms
    // calls it a duration timecode. Live on 26.5.2 (e2e P34), setSpeed(0.5, "", ...) changed the speed to 0.5 but
    // left the clip's duration at 119 frames, and a speed-only read-back called that a success. So the call
    // shapes are tried in turn ("", the new duration in ticks, the new duration as a timecode) until the DOM reads
    // back both the speed and the duration; a call that throws or doesn't take moves on to the next. If none
    // takes, the old speed is put back (best effort) and the result is SPEED_NOT_APPLIED with every attempt.
    function setSpeed(a) {
        var v = P.speedArgs(a);
        if (v.error) throw fail("BAD_ARGS", v.error);
        var project = findProject(a.projectPath);
        requireActive(project);
        var seq = resolveSequence(project, a.sequence);
        var t = domTrack(seq, a.track);
        var c = domClip(t, a.index);
        var before = clipInfo(c.item);
        var nextStartBefore = null;
        if (c.index + 1 < c.order.length) nextStartBefore = c.all[c.order[c.index + 1]].start;
        var frameTicks = parseFloat(seq.timebase);
        if (!(frameTicks > 0)) frameTicks = 0;
        var fps = frameTicks ? P.nominalFps(seq.timebase) : 0;
        var oldRatio = Math.abs(before.speed || 1);
        var wantTicks = Math.round(parseFloat(before.durationTicks) * oldRatio / v.ratio);
        var shapes = ["", String(wantTicks)];
        if (fps) shapes.push(P.framesToTimecode(wantTicks / frameTicks, fps));
        var tolerance = frameTicks + 1;

        function current() {
            return clipInfo(domClip(domTrack(seq, a.track), a.index).item);
        }
        function qeNow() {
            return qeClipFor(t, domClip(domTrack(seq, a.track), a.index).item);
        }
        // "ok", "clamped" (no ripple, stopped by the next clip), "speed-unchanged" or "duration-unchanged".
        function verdict(info) {
            if (info.speed === null || Math.abs(Math.abs(info.speed) - v.ratio) > 0.0005) return "speed-unchanged";
            var dur = parseFloat(info.durationTicks);
            if (Math.abs(dur - wantTicks) <= tolerance) return "ok";
            if (!v.ripple && nextStartBefore !== null && dur < wantTicks && parseFloat(info.endTicks) >= nextStartBefore - 1) return "clamped";
            return "duration-unchanged";
        }

        var prev = activate(project, seq);
        var attempts = [];
        var used = null;
        var outcome = null;
        var after = null;
        var reverted = null;
        try {
            for (var i = 0; i < shapes.length && used === null; i++) {
                var attempt = { call: "setSpeed(ratio, \"" + shapes[i] + "\", reverse, maintainPitch, ripple)" };
                attempts.push(attempt);
                try {
                    // Found again each time: start ticks don't change, but QE may replace its items.
                    qeNow().setSpeed(v.ratio, shapes[i], v.reverse, v.maintainPitch, v.ripple);
                } catch (eCall) {
                    attempt.error = String(eCall);
                    continue;
                }
                after = current();
                attempt.speed = after.speed;
                attempt.durationTicks = after.durationTicks;
                attempt.result = verdict(after);
                if (attempt.result === "ok" || attempt.result === "clamped") {
                    used = attempt.call;
                    outcome = attempt.result;
                }
            }
            if (used === null && after !== null && after.speed !== before.speed) {
                // No half-applied edit: put the old speed back (the pre-run backup is the fallback).
                try {
                    qeNow().setSpeed(oldRatio, "", !!before.reversed, v.maintainPitch, v.ripple);
                    var back = current();
                    reverted = back.speed !== null && Math.abs(Math.abs(back.speed) - oldRatio) <= 0.0005;
                } catch (eRevert) {
                    reverted = false;
                }
            }
        } finally {
            restoreActive(project, prev, seq);
        }
        if (used === null) {
            var speedMoved = false;
            for (var k = 0; k < attempts.length; k++) if (attempts[k].result === "duration-unchanged") speedMoved = true;
            var extra = {
                before: before, after: after, attempts: attempts, wantedDurationTicks: String(wantTicks),
                hostCall: attempts.length ? attempts[attempts.length - 1].call : null
            };
            if (reverted !== null) extra.reverted = reverted;
            var msg;
            if (speedMoved) {
                msg = "QE setSpeed changed the clip's speed but not its duration (" + before.durationTicks + " ticks, wanted " + wantTicks +
                    ") with every call shape tried, so the change was not applied" +
                    (reverted === true ? "; the old speed was put back." : reverted === false ? "; the old speed could not be put back: Undo in Premiere or restore the backup." : ".");
            } else {
                msg = "QE setSpeed returned, but the clip's speed reads " + (after ? after.speed : before.speed) + " (wanted " + v.ratio + "). Nothing changed.";
            }
            throw fail("SPEED_NOT_APPLIED", msg, extra);
        }
        var nextStartAfter = null;
        var t2 = domTrack(seq, a.track);
        var c2 = domClip(t2, a.index);
        if (c2.index + 1 < c2.order.length) nextStartAfter = c2.all[c2.order[c2.index + 1]].start;
        var out = {
            status: "success",
            sequence: String(seq.name), track: t.label, index: c.index,
            percent: a.percent, speed: after.speed, reversed: after.reversed,
            before: before, after: after, hostCall: used, attempts: attempts, undoSteps: 1
        };
        if (nextStartBefore !== null) out.rippled = nextStartAfter !== nextStartBefore;
        var warnings = [];
        if (outcome === "clamped") {
            warnings.push("without ripple the clip stops at the next clip, so its duration is " + after.durationTicks + " ticks, not " + wantTicks + ".");
        }
        if (after.reversed !== null && after.reversed !== v.reverse) {
            warnings.push("reverse reads " + after.reversed + " after the change (requested " + v.reverse + ").");
        }
        if (warnings.length) out.warning = warnings.join(" ");
        return out;
    }

    function transitionSpans(track) {
        var out = [];
        var tr = track.transitions;
        var n = tr ? tr.numItems : 0;
        for (var i = 0; i < n; i++) out.push({ startTicks: String(tr[i].start.ticks), endTicks: String(tr[i].end.ticks) });
        return out;
    }

    function spanKey(s) {
        return s.startTicks + "-" + s.endTicks;
    }

    // QE TrackItem.addTransition(transition, applyToStart, durationTimecode, offsetTimecode, alignment,
    // singleSided, alignToVideo?): seven arguments as called on 26.5.1 by leancoderkavy/premiere-pro-mcp
    // src/tools/transitions.ts (issue #773: "a 0.5 s Cross Dissolve applied 13/13 frames, centred"). The
    // transition object comes from qe.project.getAudioTransitionByName(name) (QE project method, reflected
    // on 26.3.2: "3 audio transitions": Constant Gain, Constant Power, Exponential Fade). alignment 0.5 =
    // centred on the cut; the 7th argument is passed as true like the reference implementation, meaning
    // unconfirmed. The DOM transition count is the read-back.
    function addAudioTransition(a) {
        var v = P.transitionArgs(a);
        if (v.error) throw fail(v.code || "BAD_ARGS", v.error);
        var project = findProject(a.projectPath);
        requireActive(project);
        var seq = resolveSequence(project, a.sequence);
        var t = domTrack(seq, a.track);
        if (t.type !== "audio") throw fail("BAD_ARGS", "addAudioTransition needs an audio track (A1, A2...), got " + t.label);
        var c = domClip(t, a.index);
        var durTicks = ticksOf(c.item.end) - ticksOf(c.item.start);
        var fps = P.nominalFps(seq.timebase);
        if (!fps) throw fail("BAD_TIME", "The sequence has no readable timebase.");
        var frameTicks = parseFloat(seq.timebase);
        if (v.durationFrames * frameTicks > durTicks + 1) throw fail("BAD_TIME", "durationFrames is longer than the clip");
        app.enableQE();
        var transition = qe.project.getAudioTransitionByName(v.type);
        if (!transition) throw fail("BAD_ARGS", "Unknown audio transition \"" + v.type + "\". Premiere's audio transitions: Constant Power, Constant Gain, Exponential Fade.");
        var tc = P.framesToTimecode(v.durationFrames, fps);
        var before = transitionSpans(t.track);
        var seen = {};
        for (var i = 0; i < before.length; i++) seen[spanKey(before[i])] = true;
        var prev = activate(project, seq);
        var applied = [];
        var errors = [];
        try {
            var qc = qeClipFor(t, c.item);
            for (var k = 0; k < v.edges.length; k++) {
                try {
                    qc.addTransition(transition, v.edges[k], tc, "0", 0.5, false, true);
                    applied.push(v.edges[k] ? "start" : "end");
                } catch (eAdd) {
                    errors.push((v.edges[k] ? "start" : "end") + ": " + eAdd);
                }
            }
        } finally {
            restoreActive(project, prev, seq);
        }
        var after = transitionSpans(domTrack(seq, a.track).track);
        var added = [];
        for (var j = 0; j < after.length; j++) if (!seen[spanKey(after[j])]) added.push(after[j]);
        if (added.length === 0) {
            throw fail("TRANSITION_NOT_APPLIED", "QE addTransition added no transition" + (errors.length ? ": " + errors.join("; ") : "."),
                { edgesTried: applied, errors: errors });
        }
        var out = {
            status: "success",
            sequence: String(seq.name), track: t.label, index: c.index, edge: a.edge, type: v.type,
            durationFrames: v.durationFrames, durationTimecode: tc, added: added, undoSteps: added.length
        };
        if (added.length < v.edges.length || errors.length) {
            out.warning = "Added " + added.length + " of " + v.edges.length + " transitions" + (errors.length ? ": " + errors.join("; ") : ".");
        }
        return out;
    }

    function linkedCount(item) {
        try {
            var li = item.getLinkedItems();
            return li ? li.numItems : 0;
        } catch (e) {
            return null;
        }
    }

    // Sequence.linkSelection() / unlinkSelection() act on the selected track items (ppro-scripting
    // docsforadobe, Sequence object; used this way by hetpatel-11 and leancoderkavy MCP servers). We select
    // exactly the requested items with TrackItem.setSelected(true, true), call it, then restore the user's
    // selection.
    function linkOrUnlink(a, doLink) {
        var v = P.linkArgs(a);
        if (v.error) throw fail("BAD_ARGS", v.error);
        var project = findProject(a.projectPath);
        requireActive(project);
        var seq = resolveSequence(project, a.sequence);
        var targets = [];
        for (var i = 0; i < v.items.length; i++) {
            var t = domTrack(seq, v.items[i].track);
            targets.push({ track: t.label, index: v.items[i].index, item: domClip(t, v.items[i].index).item });
        }
        var prev = activate(project, seq);
        var prevSel = [];
        try {
            var sel = seq.getSelection();
            var j;
            for (j = 0; sel && j < sel.length; j++) prevSel.push(sel[j]);
            for (j = 0; j < prevSel.length; j++) {
                try { prevSel[j].setSelected(false, true); } catch (e0) { /* ignore */ }
            }
            for (j = 0; j < targets.length; j++) targets[j].item.setSelected(true, true);
            if (doLink) seq.linkSelection();
            else seq.unlinkSelection();
        } finally {
            for (var r = 0; r < targets.length; r++) {
                try { targets[r].item.setSelected(false, true); } catch (e1) { /* ignore */ }
            }
            for (var q = 0; q < prevSel.length; q++) {
                try { prevSel[q].setSelected(true, true); } catch (e2) { /* ignore */ }
            }
            restoreActive(project, prev, seq);
        }
        var items = [];
        for (var m = 0; m < targets.length; m++) {
            var t2 = domTrack(seq, targets[m].track);
            var clip = domClip(t2, targets[m].index).item;
            items.push({ track: targets[m].track, index: targets[m].index, name: String(clip.name), linkedItems: linkedCount(clip) });
        }
        return { status: "success", sequence: String(seq.name), linked: doLink, items: items, undoSteps: 1 };
    }

    function init(a) {
        var out = { status: "success", app: { version: String(app.version), build: String(app.build) } };
        // Keep the extension alive while its panel is closed or hidden (Application.setExtensionPersistent,
        // ppro-scripting docsforadobe).
        if (a && a.extensionId) {
            try { app.setExtensionPersistent(String(a.extensionId), 1); out.persistent = true; } catch (e) { out.persistent = false; }
        }
        try { app.enableQE(); out.qe = typeof qe !== "undefined"; } catch (e2) { out.qe = false; }
        return out;
    }

    var OPS = {
        init: init,
        listProjects: function () { return { status: "success", projects: projectList() }; },
        saveProject: saveProject,
        setSpeed: setSpeed,
        addAudioTransition: addAudioTransition,
        link: function (a) { return linkOrUnlink(a, true); },
        unlink: function (a) { return linkOrUnlink(a, false); }
    };

    // The only global the panel calls. Never throws: errors come back as { status: "error", code, message }.
    $.global.__mcpSidecar_call = function (name, args) {
        var result;
        try {
            if (!OPS.hasOwnProperty(name)) throw fail("UNKNOWN_COMMAND", "Unknown sidecar operation: " + name);
            result = OPS[name](args || {});
        } catch (e) {
            result = { status: "error", code: e.mcpCode || "HOST_ERROR", message: String(e.message || e) };
            if (e.line) result.line = e.line;
            if (e.extra) {
                for (var k in e.extra) if (e.extra.hasOwnProperty(k)) result[k] = e.extra[k];
            }
        }
        return J.stringify(result);
    };
})();
