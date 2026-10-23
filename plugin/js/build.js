// Turns an engine result into sequences in Premiere.
//   planBuild(): pure layout (tracks, frame snapping, takes) - unit-testable.
//   executePlan(): performs the plan through Syncu.pp.
window.Syncu = window.Syncu || {};

Syncu.build = (() => {
  const TPS = 254016000000;

  // Lanes: per device, a list of tracks; a piece goes on the first lane of
  // its device (preferring `prefer`) where it doesn't overlap anything.
  class Lanes {
    constructor() {
      this.byDevice = new Map();
    }
    place(device, start, end, prefer = 0) {
      if (!this.byDevice.has(device)) this.byDevice.set(device, []);
      const lanes = this.byDevice.get(device);
      const fits = (lane) => lane.every(([s, e]) => end <= s + 1e-9 || start >= e - 1e-9);
      while (lanes.length <= prefer) lanes.push([]);
      let i = prefer;
      while (i < lanes.length && !fits(lanes[i])) i++;
      if (i === lanes.length) lanes.push([]);
      lanes[i].push([start, end]);
      return i;
    }
    count(device) {
      return (this.byDevice.get(device) || []).length;
    }
  }

  function snap(sec, frameTicks) {
    return (Math.round((sec * TPS) / frameTicks) * frameTicks) / TPS;
  }

  function ceilFrame(sec, frameTicks) {
    return (Math.ceil((sec * TPS) / frameTicks - 1e-9) * frameTicks) / TPS;
  }

  // clips: [{id, device, group, isVideo, name}] ; result: engine analyze output.
  // opts: {mode: "timeline"|"multicam"|"takes", frameTicks, gap, handles, muteScratch}
  function planBuild(clips, result, opts) {
    const frameTicks = opts.frameTicks || TPS / 25;
    const gap = opts.gap ?? 10;
    const handles = opts.handles ?? 1;
    const warnings = [];
    const info = new Map(clips.map((c) => [c.id, c]));
    const placed = result.clips.filter((r) => r.method !== "none" && r.segments.length);
    // Clips that didn't sync still go on the timeline ("not synced" area)
    // when we know their length; only clips with no known length are skipped.
    const unsyncedRes = result.clips.filter((r) => r.method === "none" && r.duration > 0 && info.has(r.id));
    const unplaced = result.clips.filter((r) => r.method === "none" && !(r.duration > 0)).map((r) => r.id);

    // Items in timeline seconds (component-local).
    const comps = new Map();
    for (const r of placed) {
      const c = info.get(r.id);
      if (!c) continue;
      if (!comps.has(r.component)) comps.set(r.component, []);
      const segs = r.segments.map((s) => ({ srcIn: s.start, srcOut: s.end, pos: s.position }));
      let vpos = null;
      if (c.isVideo) {
        // Video is never cut: use the mapping of the segment holding the middle.
        const mid = 0.5 * (segs[0].srcIn + segs[segs.length - 1].srcOut);
        const s = segs.find((x) => mid >= x.srcIn && mid <= x.srcOut) || segs[0];
        vpos = s.pos - s.srcIn;
        if (segs.length > 1) warnings.push(`${c.name}: video drifts ${r.driftPpm.toFixed(1)} ppm; aligned at its middle`);
      }
      comps.get(r.component).push({
        id: r.id, clip: c, isVideo: c.isVideo, segs, vpos, review: !!r.needsReview, method: r.method,
        start: segs[0].pos, end: segs[segs.length - 1].pos + (segs[segs.length - 1].srcOut - segs[segs.length - 1].srcIn),
      });
    }

    // Not-synced clips: one device after another (cameras first, then audio),
    // back to back 2 s apart, so nothing overlaps and it's clear what's left.
    // Positions are relative to the area's start.
    function unsyncedItems() {
      const devices = [];
      for (const r of unsyncedRes) {
        const c = info.get(r.id);
        if (!devices.includes(c.device)) devices.push(c.device);
      }
      const hasVideo = (d) => unsyncedRes.some((r) => info.get(r.id).device === d && info.get(r.id).isVideo);
      const order = [...devices.filter(hasVideo), ...devices.filter((d) => !hasVideo(d))];
      const sorted = order.flatMap((d) => unsyncedRes.filter((r) => info.get(r.id).device === d));
      let cursor = 0;
      const out = [];
      for (const r of sorted) {
        const c = info.get(r.id);
        const at = ceilFrame(cursor, frameTicks);
        cursor = at + r.duration + 2;
        out.push({
          id: r.id, clip: c, isVideo: c.isVideo, review: true, method: "none", unsynced: true,
          segs: [{ srcIn: 0, srcOut: r.duration, pos: at }], vpos: c.isVideo ? at : null,
          start: at, end: at + r.duration,
        });
      }
      return out;
    }
    const unsynced = unsyncedItems();

    // Shift a component so its longest video lands exactly on a frame; then
    // every other video is snapped to the nearest frame (picture can't sit
    // between frames) while audio keeps its exact, sub-frame position.
    function frameAlign(items) {
      const vids = items.filter((i) => i.isVideo);
      if (!vids.length) return 0;
      const ref = vids.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
      return ceilFrame(ref.vpos, frameTicks) - ref.vpos; // in [0, 1 frame)
    }

    // Build one sequence from items shifted by `offset`. Audio overlapping
    // [from, to] (timeline seconds before the shift) is kept; it's only
    // trimmed to that range when `trim` is set (otherwise full length).
    function makeSequence(name, items, offset, from = -Infinity, to = Infinity, trim = false) {
      const lanes = new Lanes();
      const placements = [];
      const vids = items.filter((i) => i.isVideo);
      const auds = items.filter((i) => !i.isVideo);
      // Video device order: most footage first -> V1.
      const vidDur = new Map();
      for (const v of vids) vidDur.set(v.clip.device, (vidDur.get(v.clip.device) || 0) + (v.end - v.start));
      const vDevices = [...vidDur.keys()].sort((a, b) => vidDur.get(b) - vidDur.get(a));
      const aDevices = [...new Set(auds.map((a) => a.clip.device))].sort();

      // Recorder audio first: A1..An. Group members keep their own lanes.
      const audioLaneBase = new Map();
      let nextAudio = 0;
      const recPlacements = [];
      for (const dev of aDevices) {
        const devItems = auds.filter((a) => a.clip.device === dev);
        const groupIndex = new Map();
        for (const it of devItems) {
          // Track per file in a group (sorted by name): Tr1, Tr2, LR...
          const g = it.clip.group;
          if (!g) continue;
          const members = devItems.filter((x) => x.clip.group === g).map((x) => x.clip.name).sort();
          groupIndex.set(it.id, members.indexOf(it.clip.name));
        }
        for (const it of devItems) {
          let prevEnd = -Infinity;
          for (const s0 of it.segs) {
            // Drift pieces of one file may overlap by a few ms at the (quiet)
            // cut; trim the overlap so the file stays on a single track.
            const s = { ...s0 };
            if (s.pos < prevEnd) {
              s.srcIn += prevEnd - s.pos;
              s.pos = prevEnd;
            }
            prevEnd = s.pos + (s.srcOut - s.srcIn);
            const sEnd = s.pos + (s.srcOut - s.srcIn);
            if (sEnd <= from || s.pos >= to) continue;
            const lo = trim ? Math.max(s.srcIn, s.srcIn + (from - s.pos)) : s.srcIn;
            const hi = trim ? Math.min(s.srcOut, s.srcOut - (sEnd - to)) : s.srcOut;
            if (hi - lo < 0.5) continue;
            const pos = s.pos + (lo - s.srcIn) + offset;
            const lane = lanes.place("A:" + dev, pos, pos + (hi - lo), groupIndex.get(it.id) || 0);
            recPlacements.push({ dev, lane, item: it, srcIn: lo, srcOut: hi, pos });
          }
        }
        audioLaneBase.set(dev, nextAudio);
        nextAudio += lanes.count("A:" + dev);
      }
      for (const p of recPlacements) {
        const whole = p.item.segs.length === 1 && Math.abs(p.srcIn - p.item.segs[0].srcIn) < 1e-9 &&
          Math.abs(p.srcOut - p.item.segs[0].srcOut) < 1e-9;
        placements.push({
          kind: "audio", clipId: p.item.id, name: p.item.clip.name,
          audioTrack: audioLaneBase.get(p.dev) + p.lane,
          pos: p.pos, srcIn: p.srcIn, srcOut: p.srcOut, whole,
        });
      }

      // Cameras: V-lanes per device; scratch audio on tracks after recorders.
      const scratchBase = nextAudio;
      const vLaneBase = new Map();
      let nextV = 0;
      const vPlacements = [];
      for (const dev of vDevices) {
        for (const it of vids.filter((v) => v.clip.device === dev)) {
          const pos = snap(it.vpos + offset, frameTicks);
          const s = pos + it.segs[0].srcIn;
          const e = pos + it.segs[it.segs.length - 1].srcOut;
          if (e < from + offset || s > to + offset) continue;
          const lane = lanes.place("V:" + dev, s, e, 0);
          vPlacements.push({ dev, lane, item: it, pos, err: pos - (it.vpos + offset) });
        }
        vLaneBase.set(dev, nextV);
        nextV += lanes.count("V:" + dev);
      }
      const muteTracks = [];
      for (const p of vPlacements) {
        const track = vLaneBase.get(p.dev) + p.lane;
        placements.push({
          kind: "av", clipId: p.item.id, name: p.item.clip.name,
          videoTrack: track, audioTrack: scratchBase + track, pos: p.pos, snapError: p.err,
        });
        if (!muteTracks.includes(scratchBase + track)) muteTracks.push(scratchBase + track);
      }
      // Flag clips that need a human look (timestamp-placed etc.).
      const markers = [];
      const flagged = new Set();
      for (const p of placements) {
        const it = items.find((i) => i.id === p.clipId);
        if (!it || !it.review || flagged.has(it.id)) continue;
        flagged.add(it.id);
        if (it.unsynced) continue; // the area has one marker of its own
        markers.push({ name: `Syncu: check ${it.clip.name}`, time: p.pos, comment: `placed by ${it.method}; verify sync` });
      }
      const settingsClipId = vPlacements.length
        ? vPlacements.reduce((a, b) => (b.item.end - b.item.start > a.item.end - a.item.start ? b : a)).item.id
        : placements[0] && placements[0].clipId;
      return {
        name, placements, settingsClipId, markers,
        muteTracks: opts.muteScratch === false ? [] : muteTracks.sort((a, b) => a - b),
        stagingTrack: scratchBase + nextV + 1,
      };
    }

    const sequences = [];
    const compIds = [...comps.keys()].sort((a, b) => a - b);
    const label = opts.label || "Syncu";

    if (opts.mode === "timeline") {
      // All scenes in one sequence, back to back with a gap.
      let cursor = 0;
      const all = [];
      for (const c of compIds) {
        const items = comps.get(c);
        const align = frameAlign(items);
        const start = Math.min(...items.map((i) => i.start));
        const off = ceilFrame(cursor - start, frameTicks) + align;
        for (const it of items) all.push({ ...it, _off: off });
        cursor = ceilFrame(Math.max(...items.map((i) => i.end)) + off + gap, frameTicks);
      }
      // Re-express everything with offsets folded in so makeSequence sees one scene.
      const shifted = all.map((it) => ({
        ...it,
        vpos: it.vpos === null ? null : it.vpos + it._off,
        segs: it.segs.map((s) => ({ ...s, pos: s.pos + it._off })),
        start: it.start + it._off, end: it.end + it._off,
      }));
      // Not-synced clips after everything else, behind a marker.
      const unsyncedAt = cursor;
      for (const it of unsynced)
        shifted.push({
          ...it,
          vpos: it.vpos === null ? null : it.vpos + unsyncedAt,
          segs: it.segs.map((sg) => ({ ...sg, pos: sg.pos + unsyncedAt })),
          start: it.start + unsyncedAt, end: it.end + unsyncedAt,
        });
      const seqPlan = makeSequence(`${label} - synced`, shifted, 0);
      if (unsynced.length)
        seqPlan.markers.push({ name: "Not synced", time: unsyncedAt, comment: `${unsynced.length} clip(s) Syncu couldn't sync — place by hand` });
      compIds.forEach((c, n) => {
        const t = Math.min(...shifted.filter((i) => i.clip && comps.get(c).some((x) => x.id === i.id)).map((i) => i.start));
        if (compIds.length > 1 && isFinite(t)) seqPlan.markers.push({ name: `Scene ${n + 1}`, time: t, comment: "" });
      });
      sequences.push(seqPlan);
    } else if (opts.mode === "multicam") {
      compIds.forEach((c, n) => {
        const items = comps.get(c);
        sequences.push(makeSequence(`${label} - scene ${n + 1} (multicam source)`, items, frameAlign(items)));
      });
    } else {
      // Per take: merge overlapping video clips into takes.
      let takeNo = 0;
      for (const c of compIds) {
        const items = comps.get(c);
        const align = frameAlign(items);
        const vids = items.filter((i) => i.isVideo).sort((a, b) => a.start - b.start);
        const takes = [];
        for (const v of vids) {
          const last = takes[takes.length - 1];
          if (last && v.start <= last.end + 1) {
            last.end = Math.max(last.end, v.end);
            last.items.push(v);
          } else takes.push({ start: v.start, end: v.end, items: [v] });
        }
        if (!vids.length) takes.push({ start: Math.min(...items.map((i) => i.start)), end: Math.max(...items.map((i) => i.end)), items: [] });
        for (const t of takes) {
          takeNo++;
          const from = t.start - handles;
          const to = t.end + handles;
          const members = items.filter((i) => (i.isVideo ? t.items.includes(i) : i.end > from && i.start < to));
          // Shift so the earliest clip starts at 0 (the take itself, or a
          // full-length recorder file that began before it), in whole frames.
          const earliest = opts.trimTakes ? from : Math.min(from, ...members.map((i) => i.start));
          const off = ceilFrame(-earliest, frameTicks) + align;
          sequences.push(makeSequence(`${label} - take ${String(takeNo).padStart(3, "0")}`, members, off, from, to, !!opts.trimTakes));
        }
      }
    }

    // Other modes: not-synced clips get a sequence of their own.
    if (opts.mode !== "timeline" && unsynced.length) {
      const sq = makeSequence(`${label} - not synced`, unsynced, 0);
      sq.markers.push({ name: "Not synced", time: 0, comment: `${unsynced.length} clip(s) Syncu couldn't sync — place by hand` });
      sq.unsyncedOnly = true;
      sequences.push(sq);
    }

    return {
      frameTicks,
      unsynced: unsynced.map((u) => u.id),
      sequences,
      master: opts.mode === "takes" ? { name: `${label} - master` } : null,
      unplaced,
      warnings,
    };
  }

  // ---- Execution in Premiere ----
  // replan(frameTicks) rebuilds the plan once the real sequence frame
  // duration is known (from the first sequence Premiere creates).
  // A bad number (NaN, negative time, absurd track) handed to Premiere can
  // crash it outright, so check every placement first and skip bad ones.
  function validatePlan(plan, byId, log) {
    const okNum = (x) => typeof x === "number" && Number.isFinite(x);
    for (const sp of plan.sequences) {
      const before = sp.placements.length;
      sp.placements = sp.placements.filter((p) => {
        const c = byId.get(p.clipId);
        const why =
          !c || !c.projectItem ? "clip not in the project" :
          !okNum(p.pos) || p.pos < 0 || p.pos > 7 * 24 * 3600 ? `bad position ${p.pos}` :
          !Number.isInteger(p.audioTrack) || p.audioTrack < 0 || p.audioTrack > 98 ? `bad audio track ${p.audioTrack}` :
          p.kind === "av" && (!Number.isInteger(p.videoTrack) || p.videoTrack < 0 || p.videoTrack > 98) ? `bad video track ${p.videoTrack}` :
          p.kind === "audio" && (!okNum(p.srcIn) || !okNum(p.srcOut) || p.srcIn < 0 || p.srcOut <= p.srcIn) ? `bad source range ${p.srcIn}-${p.srcOut}` :
          "";
        if (why) log("warn", `skipping ${p.name || p.clipId}: ${why}`);
        return !why;
      });
      if (sp.placements.length < before) log("warn", `"${sp.name}": ${before - sp.placements.length} placement(s) skipped as invalid`);
      if (!Number.isInteger(sp.stagingTrack) || sp.stagingTrack < 0 || sp.stagingTrack > 98) throw new Error(`bad staging track ${sp.stagingTrack}`);
      sp.markers = (sp.markers || []).filter((m) => okNum(m.time) && m.time >= 0 && (m.duration === undefined || (okNum(m.duration) && m.duration >= 0)));
    }
    return plan;
  }

  async function executePlan(plan, clips, onStep, replan) {
    const pp = Syncu.pp;
    const log = (...a) => Syncu.log(...a);
    // Every Premiere step reads the project, sequence and clips from `ctx`,
    // so when Premiere invalidates them mid-build the step is retried with
    // fresh ones (never by starting a new sequence).
    const ctx = pp.buildContext(clips);
    await ctx.refresh();
    const byId = new Map(clips.map((c) => [c.id, c]));
    const item = (id) => byId.get(id).projectItem;
    validatePlan(plan, byId, log);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    ctx.binName = `Syncu ${stamp}`;
    ctx.bin = await pp.ensureBin(ctx.proj, ctx.binName);
    const made = []; // {id, name} of finished sequences, for the master
    let step = 0;
    const total = plan.sequences.reduce((n, s) => n + s.placements.length, 0) || 1;

    for (let si = 0; si < plan.sequences.length; si++) {
      let sp = plan.sequences[si];
      log(`creating sequence "${sp.name}" (${sp.placements.length} placements)`);
      await Syncu.log.flush();
      // Creating is the one step that must not be repeated blindly.
      const idOf = (x) => {
        try {
          return x.guid ? x.guid.toString() : null;
        } catch (e) {
          return null;
        }
      };
      const named = async () => (await ctx.proj.getSequences()).filter((x) => x.name === sp.name);
      const before = await named();
      const beforeIds = new Set(before.map(idOf));
      const seq = await ctx.step("create sequence", async () => {
        // A retry after the sequence was already made reuses it.
        const now = await named();
        const fresh = now.find((x) => idOf(x) && !beforeIds.has(idOf(x))) || (now.length > before.length ? now[now.length - 1] : null);
        if (fresh) return fresh;
        return pp.createSequence(ctx.proj, sp.name, item(sp.settingsClipId), ctx.bin, false);
      });
      ctx.setSequence(seq);
      await ctx.step("clear template clip", async () =>
        pp.removeItems(ctx.proj, ctx.seq, await pp.allTrackItems(ctx.seq), "Syncu: clear template clip"));
      if (si === 0 && replan) {
        const ft = await ctx.step("read frame rate", () => pp.frameTicks(ctx.seq));
        if (ft && ft !== plan.frameTicks) {
          log(`sequence frame is ${ft} ticks (planned with ${plan.frameTicks}); re-planning`);
          plan = validatePlan(replan(ft), byId, log);
          sp = plan.sequences[0];
        }
      }
      // Tracks first, in order (Premiere appends new tracks at the end).
      const nV = Math.max(1, ...sp.placements.filter((p) => p.kind === "av").map((p) => p.videoTrack + 1));
      const nA = Math.max(sp.stagingTrack + 1, ...sp.placements.map((p) => p.audioTrack + 1));
      const firstAudio = sp.placements.find((p) => p.kind === "audio");
      log(`making tracks V${nV} A${nA}`);
      await Syncu.log.flush();
      await pp.ensureTracks(null, null, nV, nA, () => item(sp.settingsClipId), firstAudio ? () => item(firstAudio.clipId) : null, ctx);

      // Cameras (video + scratch audio), in small batches. Video can only sit
      // on frames anyway; recorder audio goes through exact placement below.
      const exactAudio = pp.subFrame.method !== "none";
      const simple = sp.placements.filter((p) => p.kind === "av" || (!exactAudio && p.whole));
      const audioExact = sp.placements.filter((p) => p.kind === "audio" && !simple.includes(p));
      log(`"${sp.name}": placing ${simple.length} clip(s) directly, ${audioExact.length} audio clip(s) sample-accurately`);
      await pp.transactInBatches(() => ctx.proj, `Syncu: place clips (${sp.name})`, simple, (p) =>
        p.kind === "av"
          ? pp.overwriteAction(ctx.seq, item(p.clipId), p.pos, p.videoTrack, p.audioTrack)
          : pp.overwriteAction(ctx.seq, item(p.clipId), p.pos - p.srcIn, 0, p.audioTrack),
      15, ctx.step);
      step += simple.length;
      if (onStep) onStep(step / total, sp.name);

      // Check camera placements landed where planned (video snaps to frames).
      try {
        for (const p of simple.slice(0, 8)) {
          const items = p.kind === "av" ? await pp.trackItemsOn(ctx.seq, "video", p.videoTrack) : await pp.trackItemsOn(ctx.seq, "audio", p.audioTrack);
          const want = p.kind === "av" ? p.pos : p.pos - p.srcIn;
          let best = Infinity;
          for (const ti of items) best = Math.min(best, Math.abs(pp.seconds(await ti.getStartTime()) - want));
          if (best > 0.0005) log("warn", `${p.name}: expected at ${want.toFixed(4)} on ${p.kind === "av" ? "V" + (p.videoTrack + 1) : "A" + (p.audioTrack + 1)}, nearest clip is ${(best * 1000).toFixed(2)} ms away`);
        }
      } catch (e) {
        log("warn", `placement check skipped: ${Syncu.log.errText(e).split("\n")[0]}`);
      }

      // Recorder audio: full-length clips (default) or drift/take pieces,
      // each placed to the sample and verified.
      let worst = 0;
      for (const p of audioExact) {
        log("debug", `placing ${p.name} on A${p.audioTrack + 1} at ${p.pos.toFixed(6)}`);
        await Syncu.log.flush();
        const err = await pp.placeAudioExact(null, null, null, p.srcIn, p.srcOut, p.pos, p.audioTrack, sp.stagingTrack, p.whole,
          { get proj() { return ctx.proj; }, get seq() { return ctx.seq; }, item: () => item(p.clipId),
            step: (label, fn) => ctx.step(`${p.name}: ${label}`, fn) });
        worst = Math.max(worst, Math.abs(err));
        await pp.sleep(20);
        step++;
        if (onStep) onStep(step / total, sp.name);
      }
      if (audioExact.length)
        log(worst <= 1 / 48000
          ? `"${sp.name}": audio placed sample-accurately (${audioExact.length} clip(s), method: ${pp.subFrame.method || "direct"})`
          : `"${sp.name}": audio placement accuracy ${(worst * 1000).toFixed(2)} ms worst over ${audioExact.length} clip(s)`);
      for (const t of sp.muteTracks) {
        try {
          await ctx.step(`mute A${t + 1}`, () => pp.muteAudioTrack(ctx.seq, t));
        } catch (e) {
          log("warn", `could not mute A${t + 1}: ${Syncu.log.errText(e)}`);
        }
      }
      try {
        // The markers object is fetched per batch: an old one may be stale.
        const marks = sp.markers || [];
        for (let i = 0; i < marks.length; i += 15) {
          const part = marks.slice(i, i + 15);
          await ctx.step("markers", async () => {
            const m = await pp.ppro.Markers.getMarkers(ctx.seq);
            pp.transact(ctx.proj, `Syncu: markers (${i + 1}-${i + part.length})`, () =>
              part.map((k) => m.createAddMarkerAction(k.name, "Comment", pp.ticks(k.time), pp.ticks(k.duration || 0), k.comment || "")));
          });
          await pp.sleep(40);
        }
      } catch (e) {
        log("warn", `markers not added: ${Syncu.log.errText(e).split("\n")[0]}`);
      }
      if (ctx.refreshes) log(`"${sp.name}": recovered from ${ctx.refreshes} invalidated object(s) during the build`);
      if (!sp.unsyncedOnly) made.push({ id: ctx.seqId, name: ctx.seqName }); // the master nests takes only
    }

    if (plan.master && made.length) {
      try {
        const first = item(plan.sequences[0].settingsClipId);
        const master = await ctx.step("create master", () => pp.createSequence(ctx.proj, plan.master.name, first, ctx.bin));
        ctx.setSequence(master);
        const ft = (await pp.frameTicks(ctx.seq)) || plan.frameTicks;
        const entries = [];
        let cursor = 0;
        const all = await ctx.proj.getSequences();
        for (const m of made) {
          const seq = all.find((x) => (m.id && x.guid && x.guid.toString() === m.id) || x.name === m.name);
          if (!seq) continue;
          entries.push({ pi: await seq.getProjectItem(), at: cursor });
          cursor = ceilFrame(pp.seconds(await seq.getEndTime()) + cursor + 2, ft);
        }
        await ctx.step("master timeline", async () =>
          pp.transact(ctx.proj, "Syncu: master timeline", () => entries.map((e) => pp.overwriteAction(ctx.seq, e.pi, e.at, 0, 0))));
        log(`master timeline: ${entries.length} take(s) nested`);
      } catch (e) {
        log("warn", `master timeline not built: ${Syncu.log.errText(e)}`);
      }
    }
    return made;
  }

  return { planBuild, executePlan, validatePlan, snap, ceilFrame };
})();
