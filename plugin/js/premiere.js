// Thin wrapper over the Premiere UXP DOM. Several calls are only partly
// documented, so everything that edits goes through helpers that verify
// their own result, and runSelfTest() reports what actually works.
window.Syncu = window.Syncu || {};

Syncu.pp = (() => {
  const ppro = require("premierepro");
  const TICKS_PER_SECOND = 254016000000;
  let log = (msg) => console.log(msg);

  function setLogger(fn) {
    log = fn;
  }

  function ticks(seconds) {
    return ppro.TickTime.createWithTicks(String(Math.round(seconds * TICKS_PER_SECOND)));
  }

  function seconds(tickTime) {
    return Number(tickTime.ticks) / TICKS_PER_SECOND;
  }

  async function project() {
    const p = await ppro.Project.getActiveProject();
    if (!p) throw new Error("No open project");
    return p;
  }

  // Run create*Action calls inside lockedAccess and commit them as one undo step.
  function transact(proj, label, build) {
    let ok = false;
    let error = null;
    proj.lockedAccess(() => {
      try {
        ok = proj.executeTransaction((compound) => {
          for (const action of build()) if (action) compound.addAction(action);
        }, label);
      } catch (e) {
        error = e;
      }
    });
    if (error) throw error;
    if (!ok) throw new Error(`Premiere rejected: ${label}`);
  }

  async function itemName(item) {
    if (item.name) return item.name;
    if (item.getName) return await item.getName();
    return "?";
  }

  // ---- Gathering media ----

  // Flatten the project panel selection: bins are expanded recursively and
  // each clip remembers the bin it came from.
  async function selectedClips() {
    const proj = await project();
    const sel = await ppro.ProjectUtils.getSelection(proj);
    const items = await sel.getItems();
    const out = [];
    async function visit(item, binName) {
      const folder = ppro.FolderItem.cast(item);
      if (folder && folder.getItems) {
        let children = null;
        try {
          children = await folder.getItems();
        } catch (e) {
          children = null;
        }
        if (children) {
          const name = await itemName(item);
          for (const c of children) await visit(c, name);
          return;
        }
      }
      const clip = ppro.ClipProjectItem.cast(item);
      if (!clip) return;
      let path = "";
      try {
        path = await clip.getMediaFilePath();
      } catch (e) {
        path = "";
      }
      if (!path) return; // sequences, titles, offline media
      out.push({ projectItem: item, path, name: await itemName(item), bin: binName });
    }
    for (const it of items) await visit(it, null);
    return out;
  }

  // One device per track of the active sequence. Audio track items whose
  // file is already on a video track are that camera's own audio: skipped.
  async function timelineClips() {
    const proj = await project();
    const seq = await proj.getActiveSequence();
    if (!seq) throw new Error("No active sequence");
    const out = [];
    const videoPaths = new Set();
    const seen = new Set();
    const T = ppro.Constants.TrackItemType.CLIP;
    const vCount = await seq.getVideoTrackCount();
    for (let v = 0; v < vCount; v++) {
      const track = await seq.getVideoTrack(v);
      for (const ti of await track.getTrackItems(T, false)) {
        const pi = await ti.getProjectItem();
        const clip = ppro.ClipProjectItem.cast(pi);
        const path = clip ? await clip.getMediaFilePath() : "";
        if (!path) continue;
        videoPaths.add(path);
        const key = `V${v + 1}|${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ projectItem: pi, path, name: await itemName(pi), device: `V${v + 1}`, isVideo: true });
      }
    }
    const aCount = await seq.getAudioTrackCount();
    for (let a = 0; a < aCount; a++) {
      const track = await seq.getAudioTrack(a);
      for (const ti of await track.getTrackItems(T, false)) {
        const pi = await ti.getProjectItem();
        const clip = ppro.ClipProjectItem.cast(pi);
        const path = clip ? await clip.getMediaFilePath() : "";
        if (!path || videoPaths.has(path)) continue;
        const key = `A${a + 1}|${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ projectItem: pi, path, name: await itemName(pi), device: `A${a + 1}`, isVideo: false });
      }
    }
    return out;
  }

  // ---- Building ----

  async function ensureBin(proj, name) {
    const root = await proj.getRootItem();
    transact(proj, "Syncu: create bin", () => [root.createBinAction(name, true)]);
    // Find the bin we just made (makeUnique may have renamed it: take the last match).
    const kids = await root.getItems();
    let bin = null;
    for (const k of kids) {
      const n = await itemName(k);
      if (n === name || n.startsWith(name)) bin = k;
    }
    return bin;
  }

  // New sequence matching a clip's settings. Premiere puts that clip at 0
  // on V1/A1; we remove it so the caller starts from an empty sequence.
  async function createSequence(proj, name, settingsClip, bin) {
    const seq = await proj.createSequenceFromMedia(name, [ppro.ClipProjectItem.cast(settingsClip)], bin || undefined);
    if (!seq) throw new Error("Could not create sequence " + name);
    await clearSequence(proj, seq);
    return seq;
  }

  async function allTrackItems(seq) {
    const T = ppro.Constants.TrackItemType.CLIP;
    const items = [];
    const vc = await seq.getVideoTrackCount();
    for (let v = 0; v < vc; v++) items.push(...(await (await seq.getVideoTrack(v)).getTrackItems(T, false)));
    const ac = await seq.getAudioTrackCount();
    for (let a = 0; a < ac; a++) items.push(...(await (await seq.getAudioTrack(a)).getTrackItems(T, false)));
    return items;
  }

  async function removeItems(proj, seq, items) {
    if (!items.length) return;
    const editor = ppro.SequenceEditor.getEditor(seq);
    const sel = await seq.getSelection();
    // TrackItemSelection API: try the plausible spellings.
    for (const ti of items) {
      if (sel.addItem) sel.addItem(ti);
      else if (sel.add) sel.add(ti);
    }
    transact(proj, "Syncu: clear", () => [
      editor.createRemoveItemsAction(sel, false, ppro.Constants.MediaType.ANY, false),
    ]);
  }

  async function clearSequence(proj, seq) {
    const items = await allTrackItems(seq);
    try {
      await removeItems(proj, seq, items);
    } catch (e) {
      log(`warn: could not clear template clip (${e.message || e}); it stays at 0 on V1`);
    }
  }

  function overwriteAction(seq, projectItem, timeSec, vIdx, aIdx) {
    const editor = ppro.SequenceEditor.getEditor(seq);
    return editor.createOverwriteItemAction(projectItem, ticks(timeSec), vIdx, aIdx);
  }

  async function trackItemsOn(seq, kind, index) {
    const T = ppro.Constants.TrackItemType.CLIP;
    const track = kind === "video" ? await seq.getVideoTrack(index) : await seq.getAudioTrack(index);
    return track ? await track.getTrackItems(T, false) : [];
  }

  // Place source range [srcIn, srcOut] of an audio-only clip at timeline
  // `pos` on audio track `track`. Done on a scratch track so a full-length
  // overwrite never clobbers neighbouring pieces, then cloned into place.
  async function placeAudioPiece(proj, seq, projectItem, srcIn, srcOut, pos, track, scratchTrack) {
    transact(proj, "Syncu: stage piece", () => [overwriteAction(seq, projectItem, pos - srcIn, 0, scratchTrack)]);
    const staged = await trackItemsOn(seq, "audio", scratchTrack);
    if (staged.length !== 1) throw new Error(`staging track ${scratchTrack} has ${staged.length} items`);
    const ti = staged[0];
    transact(proj, "Syncu: trim piece", () => [
      ti.createSetInPointAction(ticks(srcIn)),
      ti.createSetOutPointAction(ticks(srcOut)),
    ]);
    const editor = ppro.SequenceEditor.getEditor(seq);
    transact(proj, "Syncu: place piece", () => [
      editor.createCloneTrackItemAction(ti, ticks(0), 0, track - scratchTrack, false, false),
    ]);
    await removeItems(proj, seq, [ti]);
  }

  async function muteAudioTrack(seq, index) {
    const t = await seq.getAudioTrack(index);
    if (t && t.setMute) await t.setMute(true);
  }

  async function frameTicks(seq) {
    // Sequence timebase = ticks per frame (e.g. "10594584000" at 23.976).
    return Number(await seq.getTimebase());
  }

  // ---- Self-test: exercise each uncertain API in a scratch sequence ----
  async function runSelfTest() {
    const results = [];
    const rec = (name, ok, detail) => {
      results.push(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
      log(results[results.length - 1]);
    };
    const proj = await project();
    const clips = await selectedClips();
    const video = clips.find((c) => !Syncu.devices.isAudioFile(c.path));
    const audio = clips.find((c) => Syncu.devices.isAudioFile(c.path));
    rec("selection", clips.length > 0, `${clips.length} clips (need ≥1 video + ≥1 audio-only file selected)`);
    if (!video || !audio) return results;

    let seq;
    try {
      seq = await proj.createSequenceFromMedia("Syncu self-test", [ppro.ClipProjectItem.cast(video.projectItem)]);
      rec("createSequenceFromMedia", !!seq);
      rec("timebase", true, `${await frameTicks(seq)} ticks/frame`);
    } catch (e) {
      rec("createSequenceFromMedia", false, String(e));
      return results;
    }

    try {
      const before = (await allTrackItems(seq)).length;
      await removeItems(proj, seq, await allTrackItems(seq));
      const after = (await allTrackItems(seq)).length;
      rec("remove items", after < before, `${before} -> ${after}`);
    } catch (e) {
      rec("remove items", false, String(e));
    }

    const t = 1.2345678; // deliberately not on a frame or sample boundary
    try {
      transact(proj, "test overwrite audio", () => [overwriteAction(seq, audio.projectItem, t, 0, 3)]);
      const it = (await trackItemsOn(seq, "audio", 3))[0];
      const got = seconds(await it.getStartTime());
      rec("audio sub-frame placement", Math.abs(got - t) < 1 / 48000, `asked ${t}, got ${got.toFixed(7)} (Δ ${((got - t) * 1000).toFixed(3)} ms)`);
    } catch (e) {
      rec("audio sub-frame placement", false, String(e));
    }

    try {
      transact(proj, "test overwrite video", () => [overwriteAction(seq, video.projectItem, t, 2, 5)]);
      const it = (await trackItemsOn(seq, "video", 2))[0];
      const got = seconds(await it.getStartTime());
      rec("video placement", true, `asked ${t}, got ${got.toFixed(7)} (frame-snapped: ${Math.abs(got - t) > 1e-6})`);
    } catch (e) {
      rec("video placement", false, String(e));
    }

    try {
      const it = (await trackItemsOn(seq, "audio", 3))[0];
      transact(proj, "test trim", () => [it.createSetInPointAction(ticks(2)), it.createSetOutPointAction(ticks(4))]);
      const s = seconds(await it.getStartTime());
      const i = seconds(await it.getInPoint());
      const o = seconds(await it.getOutPoint());
      rec("trim in/out", Math.abs(i - 2) < 1e-6 && Math.abs(o - 4) < 1e-6, `in ${i.toFixed(4)} out ${o.toFixed(4)} start ${s.toFixed(4)} (start moved with in-point: ${Math.abs(s - t) > 1e-6})`);
    } catch (e) {
      rec("trim in/out", false, String(e));
    }

    try {
      const it = (await trackItemsOn(seq, "audio", 3))[0];
      const editor = ppro.SequenceEditor.getEditor(seq);
      transact(proj, "test clone", () => [editor.createCloneTrackItemAction(it, ticks(0), 0, 2, false, false)]);
      const moved = await trackItemsOn(seq, "audio", 5);
      rec("clone to other track", moved.length >= 1, `${moved.length} item(s) on A6`);
    } catch (e) {
      rec("clone to other track", false, String(e));
    }

    try {
      const it = (await trackItemsOn(seq, "audio", 3))[0];
      const s0 = seconds(await it.getStartTime());
      transact(proj, "test move", () => [it.createMoveAction(ticks(0.5))]);
      const s1 = seconds(await it.getStartTime());
      rec("move", Math.abs(s1 - s0) > 1e-6, `start ${s0.toFixed(4)} -> ${s1.toFixed(4)} (by: ${Math.abs(s1 - s0 - 0.5) < 1e-4}, to: ${Math.abs(s1 - 0.5) < 1e-4})`);
    } catch (e) {
      rec("move", false, String(e));
    }

    try {
      await muteAudioTrack(seq, 3);
      const muted = await (await seq.getAudioTrack(3)).isMuted();
      rec("mute track", muted === true);
    } catch (e) {
      rec("mute track", false, String(e));
    }

    try {
      const pi = seq.getProjectItem ? await seq.getProjectItem() : null;
      rec("sequence -> project item (for nesting)", !!pi);
    } catch (e) {
      rec("sequence -> project item (for nesting)", false, String(e));
    }

    rec("done", true, "you can delete the 'Syncu self-test' sequence");
    return results;
  }

  return {
    ppro, ticks, seconds, project, transact, itemName, setLogger,
    selectedClips, timelineClips, ensureBin, createSequence, allTrackItems,
    removeItems, overwriteAction, trackItemsOn, placeAudioPiece, muteAudioTrack,
    frameTicks, runSelfTest, TICKS_PER_SECOND,
  };
})();
