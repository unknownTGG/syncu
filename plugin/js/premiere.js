// Thin wrapper over the Premiere UXP DOM. Several calls are only partly
// documented, so editing helpers verify their own result and log what
// happened; runSelfTest() checks each uncertain call in a scratch sequence.
window.Syncu = window.Syncu || {};

Syncu.pp = (() => {
  const ppro = require("premierepro");
  const TICKS_PER_SECOND = 254016000000;
  const log = (...a) => Syncu.log(...a);

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

  // Create actions inside lockedAccess (required since 26.3) and commit them
  // as one undo step. `build` returns an array of actions (falsy skipped).
  function transact(proj, label, build) {
    let ok = false;
    let error = null;
    let count = 0;
    proj.lockedAccess(() => {
      try {
        const actions = build().filter(Boolean);
        count = actions.length;
        if (!count) {
          ok = true;
          return;
        }
        ok = proj.executeTransaction((compound) => {
          for (const a of actions) compound.addAction(a);
        }, label);
      } catch (e) {
        error = e;
      }
    });
    if (error) {
      log("error", `${label}: ${Syncu.log.errText(error)}`);
      throw error;
    }
    if (!ok) throw new Error(`Premiere rejected "${label}" (${count} actions)`);
  }

  function itemName(item) {
    try {
      return item.name || "?";
    } catch (e) {
      return "?";
    }
  }

  // ---- Gathering media ----

  // Flatten the project panel selection: bins are expanded recursively and
  // each clip remembers the bin it came from.
  async function selectedClips() {
    const proj = await project();
    const sel = await ppro.ProjectUtils.getSelection(proj);
    const items = await sel.getItems();
    log(`project selection: ${items.length} item(s)`);
    const out = [];
    const skipped = [];
    async function visit(item, binName, depth) {
      const folder = ppro.FolderItem.cast(item);
      if (folder && depth < 20) {
        let children = null;
        try {
          children = await folder.getItems();
        } catch (e) {
          children = null;
        }
        if (children) {
          for (const c of children) await visit(c, itemName(item), depth + 1);
          return;
        }
      }
      const clip = ppro.ClipProjectItem.cast(item);
      let path = "";
      try {
        path = clip ? await clip.getMediaFilePath() : "";
      } catch (e) {
        path = "";
      }
      if (!path) {
        skipped.push(itemName(item)); // sequences, titles, offline media
        return;
      }
      out.push({ projectItem: item, path, name: itemName(item), bin: binName });
    }
    for (const it of items) await visit(it, null, 0);
    if (skipped.length) log(`skipped ${skipped.length} non-media item(s): ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? "…" : ""}`);
    return out;
  }

  // One device per track of the active sequence. Audio track items whose
  // file is already on a video track are that camera's own audio: skipped.
  async function timelineClips() {
    const proj = await project();
    const seq = await proj.getActiveSequence();
    if (!seq) throw new Error("No active sequence");
    log(`timeline source: "${seq.name}"`);
    const out = [];
    const videoPaths = new Set();
    const seen = new Set();
    const T = ppro.Constants.TrackItemType.CLIP;
    const add = async (ti, device, isVideo) => {
      const pi = await ti.getProjectItem();
      const clip = ppro.ClipProjectItem.cast(pi);
      let path = "";
      try {
        path = clip ? await clip.getMediaFilePath() : "";
      } catch (e) {
        path = "";
      }
      if (!path || (!isVideo && videoPaths.has(path))) return;
      if (isVideo) videoPaths.add(path);
      const key = `${device}|${path}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ projectItem: pi, path, name: itemName(pi), device, isVideo });
    };
    const vCount = await seq.getVideoTrackCount();
    for (let v = 0; v < vCount; v++)
      for (const ti of (await seq.getVideoTrack(v)).getTrackItems(T, false)) await add(ti, `V${v + 1}`, true);
    const aCount = await seq.getAudioTrackCount();
    for (let a = 0; a < aCount; a++)
      for (const ti of (await seq.getAudioTrack(a)).getTrackItems(T, false)) await add(ti, `A${a + 1}`, false);
    return out;
  }

  // ---- Building ----

  async function ensureBin(proj, name) {
    const root = await proj.getRootItem();
    const before = new Set((await root.getItems()).map(itemName));
    transact(proj, "Syncu: create bin", () => [root.createBinAction(name, true)]);
    const after = await root.getItems();
    // makeUnique may have renamed it: take the new item that starts with name.
    const bin = after.find((k) => !before.has(itemName(k)) && itemName(k).startsWith(name)) ||
      after.find((k) => itemName(k) === name);
    if (!bin) log("warn", `bin "${name}" not found after creating it; sequences go to the project root`);
    return bin || null;
  }

  async function allTrackItems(seq) {
    const T = ppro.Constants.TrackItemType.CLIP;
    const items = [];
    const vc = await seq.getVideoTrackCount();
    for (let v = 0; v < vc; v++) items.push(...(await seq.getVideoTrack(v)).getTrackItems(T, false));
    const ac = await seq.getAudioTrackCount();
    for (let a = 0; a < ac; a++) items.push(...(await seq.getAudioTrack(a)).getTrackItems(T, false));
    return items;
  }

  // Remove track items using a fresh TrackItemSelection (documented way:
  // the selection is only valid inside the createEmptySelection callback).
  async function removeItems(proj, seq, items, label = "Syncu: remove") {
    if (!items.length) return;
    const editor = ppro.SequenceEditor.getEditor(seq);
    let ok = false;
    let error = null;
    proj.lockedAccess(() => {
      try {
        ppro.TrackItemSelection.createEmptySelection((sel) => {
          for (const ti of items) sel.addItem(ti, true);
          ok = proj.executeTransaction((compound) => {
            compound.addAction(editor.createRemoveItemsAction(sel, false, ppro.Constants.MediaType.ANY, false));
          }, label);
        });
      } catch (e) {
        error = e;
      }
    });
    if (error) throw error;
    if (!ok) throw new Error(`Premiere rejected "${label}"`);
  }

  function overwriteAction(seq, projectItem, timeSec, vIdx, aIdx) {
    return ppro.SequenceEditor.getEditor(seq).createOverwriteItemAction(projectItem, ticks(timeSec), vIdx, aIdx);
  }

  function insertAction(seq, projectItem, timeSec, vIdx, aIdx) {
    return ppro.SequenceEditor.getEditor(seq).createInsertProjectItemAction(projectItem, ticks(timeSec), vIdx, aIdx, false);
  }

  async function trackCounts(seq) {
    return { v: await seq.getVideoTrackCount(), a: await seq.getAudioTrackCount() };
  }

  // Make sure the sequence has at least nV video and nA audio tracks.
  // Premiere creates a track when an insert targets index == track count, so
  // add them one at a time with a throwaway clip, then clear everything.
  async function ensureTracks(proj, seq, nV, nA, videoItem, audioItem) {
    for (let guard = 0; guard < 200; guard++) {
      const c = await trackCounts(seq);
      if (c.v >= nV && c.a >= nA) break;
      if (c.v < nV) transact(proj, "Syncu: add video track", () => [insertAction(seq, videoItem, 0, c.v, c.a)]);
      else transact(proj, "Syncu: add audio track", () => [insertAction(seq, audioItem || videoItem, 0, c.v, c.a)]);
      const n = await trackCounts(seq);
      if (n.v === c.v && n.a === c.a) {
        log("warn", `could not add tracks (stuck at V${c.v}/A${c.a}, wanted V${nV}/A${nA})`);
        break;
      }
    }
    await removeItems(proj, seq, await allTrackItems(seq), "Syncu: clear helper clips");
    const c = await trackCounts(seq);
    log(`tracks ready: V${c.v} A${c.a} (wanted V${nV} A${nA})`);
    return c;
  }

  // New, empty sequence matching a clip's settings. Premiere puts that clip
  // at 0 on V1/A1; it is removed so placement starts from a clean slate.
  async function createSequence(proj, name, settingsItem, bin) {
    const clip = ppro.ClipProjectItem.cast(settingsItem);
    const seq = bin
      ? await proj.createSequenceFromMedia(name, [clip], bin)
      : await proj.createSequenceFromMedia(name, [clip]);
    if (!seq) throw new Error("Could not create sequence " + name);
    await removeItems(proj, seq, await allTrackItems(seq), "Syncu: clear template clip");
    log(`created sequence "${name}" (timebase ${await seq.getTimebase()} ticks/frame)`);
    return seq;
  }

  async function trackItemsOn(seq, kind, index) {
    const T = ppro.Constants.TrackItemType.CLIP;
    const count = kind === "video" ? await seq.getVideoTrackCount() : await seq.getAudioTrackCount();
    if (index >= count) return [];
    const track = kind === "video" ? await seq.getVideoTrack(index) : await seq.getAudioTrack(index);
    return track.getTrackItems(T, false);
  }

  // Place source range [srcIn, srcOut] of an audio clip at timeline `pos`
  // on audio track `track`: staged full-length on an empty scratch track (so
  // nothing gets overwritten), trimmed, cloned into place, scratch removed.
  async function placeAudioPiece(proj, seq, projectItem, srcIn, srcOut, pos, track, stagingTrack) {
    transact(proj, "Syncu: stage piece", () => [overwriteAction(seq, projectItem, pos - srcIn, 0, stagingTrack)]);
    const staged = await trackItemsOn(seq, "audio", stagingTrack);
    if (staged.length !== 1) throw new Error(`staging track A${stagingTrack + 1} has ${staged.length} items (expected 1)`);
    const ti = staged[0];
    transact(proj, "Syncu: trim piece", () => [ti.createSetInPointAction(ticks(srcIn)), ti.createSetOutPointAction(ticks(srcOut))]);
    // Whether trimming the in-point moves the clip's start isn't documented:
    // measure where the trimmed piece sits and let the clone fix any gap.
    const trimmed = (await trackItemsOn(seq, "audio", stagingTrack))[0];
    const delta = pos - seconds(await trimmed.getStartTime());
    const editor = ppro.SequenceEditor.getEditor(seq);
    transact(proj, "Syncu: place piece", () => [
      editor.createCloneTrackItemAction(trimmed, ticks(delta), 0, track - stagingTrack, false, false),
    ]);
    await removeItems(proj, seq, [trimmed], "Syncu: clear staging");
    // Verify: a clip on the target track should now start at pos.
    const placed = (await trackItemsOn(seq, "audio", track));
    let best = Infinity;
    for (const p of placed) best = Math.min(best, Math.abs(seconds(await p.getStartTime()) - pos));
    if (best > 0.001) log("warn", `piece on A${track + 1} landed ${(best * 1000).toFixed(2)} ms from target ${pos.toFixed(4)}`);
  }

  async function muteAudioTrack(seq, index) {
    const t = await seq.getAudioTrack(index);
    if (t && t.setMute) await t.setMute(true);
  }

  async function frameTicks(seq) {
    return Number(await seq.getTimebase()); // ticks per frame, e.g. 10594584000 at 23.976
  }

  async function addMarkers(proj, seq, markers) {
    if (!markers.length) return;
    try {
      const m = await ppro.Markers.getMarkers(seq);
      transact(proj, "Syncu: markers", () =>
        markers.map((k) => m.createAddMarkerAction(k.name, "Comment", ticks(k.time), ticks(k.duration || 0), k.comment || ""))
      );
    } catch (e) {
      log("warn", `markers not added: ${Syncu.log.errText(e)}`);
    }
  }

  // ---- Self-test: exercise each uncertain API in a scratch sequence ----
  async function runSelfTest() {
    const results = [];
    const rec = (name, ok, detail) => {
      const line = `${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`;
      results.push(line);
      log(ok ? "info" : "warn", `self-test: ${line}`);
    };
    const step = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        rec(name, false, Syncu.log.errText(e).split("\n")[0]);
      }
    };
    try {
      rec("host", true, `${require("uxp").host.name} ${require("uxp").host.version}`);
    } catch (e) {
      rec("host", false, String(e));
    }
    const proj = await project();
    const clips = await selectedClips();
    const video = clips.find((c) => !Syncu.devices.isAudioFile(c.path));
    const audio = clips.find((c) => Syncu.devices.isAudioFile(c.path));
    rec("selection", !!(video && audio), `${clips.length} clips; video: ${video ? video.name : "none"}, audio-only: ${audio ? audio.name : "none"}`);
    if (!video || !audio) {
      rec("stopped", false, "select one video clip and one audio-only clip (e.g. a WAV) in the Project panel");
      return results;
    }

    let seq = null;
    await step("createSequenceFromMedia", async () => {
      seq = await proj.createSequenceFromMedia("Syncu self-test", [ppro.ClipProjectItem.cast(video.projectItem)]);
      const c = await trackCounts(seq);
      rec("createSequenceFromMedia", !!seq, `V${c.v} A${c.a}, timebase ${await frameTicks(seq)} ticks/frame`);
    });
    if (!seq) return results;

    await step("remove items", async () => {
      const before = (await allTrackItems(seq)).length;
      await removeItems(proj, seq, await allTrackItems(seq));
      const after = (await allTrackItems(seq)).length;
      rec("remove items", after === 0 && before > 0, `${before} -> ${after}`);
    });

    await step("track creation", async () => {
      const c0 = await trackCounts(seq);
      transact(proj, "test insert past last audio track", () => [insertAction(seq, audio.projectItem, 0, 0, c0.a + 3)]);
      const c1 = await trackCounts(seq);
      let where = -1;
      for (let i = 0; i < c1.a; i++) if ((await trackItemsOn(seq, "audio", i)).length) where = i;
      rec("track creation", c1.a > c0.a, `asked A${c0.a + 4} with ${c0.a} tracks -> now ${c1.a} tracks, clip on A${where + 1}`);
      await removeItems(proj, seq, await allTrackItems(seq));
      const r = await ensureTracks(proj, seq, 3, 6, video.projectItem, audio.projectItem);
      rec("ensureTracks", r.v >= 3 && r.a >= 6 && (await allTrackItems(seq)).length === 0, `V${r.v} A${r.a}`);
    });

    const t = 1.2345678; // deliberately not on a frame or sample boundary
    await step("audio sub-frame placement", async () => {
      transact(proj, "test overwrite audio", () => [overwriteAction(seq, audio.projectItem, t, 0, 3)]);
      const items = await trackItemsOn(seq, "audio", 3);
      const got = seconds(await items[0].getStartTime());
      rec("audio sub-frame placement", Math.abs(got - t) < 1 / 48000, `asked ${t}, got ${got.toFixed(7)} (Δ ${((got - t) * 1000).toFixed(3)} ms)`);
    });

    await step("video placement", async () => {
      transact(proj, "test overwrite video", () => [overwriteAction(seq, video.projectItem, t, 2, 5)]);
      const it = (await trackItemsOn(seq, "video", 2))[0];
      const got = seconds(await it.getStartTime());
      const a5 = await trackItemsOn(seq, "audio", 5);
      rec("video placement", true, `asked ${t}, got ${got.toFixed(7)} (frame-snapped: ${Math.abs(got - t) > 1e-6}); camera audio items on A6: ${a5.length}`);
    });

    await step("trim in/out", async () => {
      const it = (await trackItemsOn(seq, "audio", 3))[0];
      const s0 = seconds(await it.getStartTime());
      transact(proj, "test trim", () => [it.createSetInPointAction(ticks(2)), it.createSetOutPointAction(ticks(4))]);
      const it2 = (await trackItemsOn(seq, "audio", 3))[0];
      const s = seconds(await it2.getStartTime());
      const i = seconds(await it2.getInPoint());
      const o = seconds(await it2.getOutPoint());
      rec("trim in/out", Math.abs(i - 2) < 1e-6 && Math.abs(o - 4) < 1e-6,
        `in ${i.toFixed(4)} out ${o.toFixed(4)}; start ${s0.toFixed(4)} -> ${s.toFixed(4)} (expected ${(s0 + 2).toFixed(4)} if in-point trims the head)`);
    });

    await step("clone to other track", async () => {
      const it = (await trackItemsOn(seq, "audio", 3))[0];
      const s = seconds(await it.getStartTime());
      const editor = ppro.SequenceEditor.getEditor(seq);
      transact(proj, "test clone", () => [editor.createCloneTrackItemAction(it, ticks(0), 0, -2, false, false)]);
      const moved = await trackItemsOn(seq, "audio", 1);
      const ms = moved.length ? seconds(await moved[0].getStartTime()) : NaN;
      rec("clone to other track", moved.length === 1 && Math.abs(ms - s) < 1e-6, `${moved.length} item(s) on A2, start ${ms.toFixed(6)} vs ${s.toFixed(6)}`);
    });

    await step("move", async () => {
      const it = (await trackItemsOn(seq, "audio", 3))[0];
      const s0 = seconds(await it.getStartTime());
      transact(proj, "test move", () => [it.createMoveAction(ticks(0.5))]);
      const s1 = seconds(await (await trackItemsOn(seq, "audio", 3))[0].getStartTime());
      rec("move", Math.abs(s1 - s0) > 1e-6, `start ${s0.toFixed(4)} -> ${s1.toFixed(4)} (by: ${Math.abs(s1 - s0 - 0.5) < 1e-4}, to: ${Math.abs(s1 - 0.5) < 1e-4})`);
    });

    await step("mute track", async () => {
      await muteAudioTrack(seq, 3);
      rec("mute track", (await (await seq.getAudioTrack(3)).isMuted()) === true);
    });

    await step("markers", async () => {
      await addMarkers(proj, seq, [{ name: "Syncu test", time: 1, comment: "self-test" }]);
      const m = await ppro.Markers.getMarkers(seq);
      rec("markers", m.getMarkers().length >= 1, `${m.getMarkers().length} marker(s)`);
    });

    await step("nesting", async () => {
      const pi = await seq.getProjectItem();
      rec("sequence -> project item (for nesting)", !!pi, pi ? itemName(pi) : "");
    });

    rec("done", true, "you can delete the 'Syncu self-test' sequence");
    return results;
  }

  return {
    ppro, ticks, seconds, project, transact, itemName,
    selectedClips, timelineClips, ensureBin, createSequence, allTrackItems, ensureTracks,
    removeItems, overwriteAction, trackItemsOn, placeAudioPiece, muteAudioTrack, addMarkers,
    frameTicks, runSelfTest, TICKS_PER_SECOND,
  };
})();
