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
    const unplaced = result.clips.filter((r) => r.method === "none").map((r) => r.id);

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

    // Shift a component so its longest video lands exactly on a frame; then
    // every other video is snapped to the nearest frame (picture can't sit
    // between frames) while audio keeps its exact, sub-frame position.
    function frameAlign(items) {
      const vids = items.filter((i) => i.isVideo);
      if (!vids.length) return 0;
      const ref = vids.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
      return ceilFrame(ref.vpos, frameTicks) - ref.vpos; // in [0, 1 frame)
    }

    // Build one sequence from items shifted by `offset`, keeping only audio
    // within [from, to] (timeline seconds before the shift).
    function makeSequence(name, items, offset, from = -Infinity, to = Infinity) {
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
            const lo = Math.max(s.srcIn, s.srcIn + (from - s.pos));
            const hi = Math.min(s.srcOut, s.srcOut - (s.pos + (s.srcOut - s.srcIn) - to));
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
      const seqPlan = makeSequence(`${label} - synced`, shifted, 0);
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
          // Shift so the take starts at 0, by a whole number of frames.
          const off = ceilFrame(-from, frameTicks) + align;
          sequences.push(makeSequence(`${label} - take ${String(takeNo).padStart(3, "0")}`, members, off, from, to));
        }
      }
    }

    return {
      frameTicks,
      sequences,
      master: opts.mode === "takes" ? { name: `${label} - master` } : null,
      unplaced,
      warnings,
    };
  }

  // ---- Execution in Premiere ----
  // replan(frameTicks) rebuilds the plan once the real sequence frame
  // duration is known (from the first sequence Premiere creates).
  async function executePlan(plan, clips, onStep, replan) {
    const pp = Syncu.pp;
    const log = (...a) => Syncu.log(...a);
    const proj = await pp.project();
    const byId = new Map(clips.map((c) => [c.id, c]));
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const bin = await pp.ensureBin(proj, `Syncu ${stamp}`);
    const made = [];
    let step = 0;
    const total = plan.sequences.reduce((n, s) => n + s.placements.length, 0) || 1;

    for (let si = 0; si < plan.sequences.length; si++) {
      let sp = plan.sequences[si];
      const settings = byId.get(sp.settingsClipId);
      const seq = await pp.createSequence(proj, sp.name, settings.projectItem, bin);
      if (si === 0 && replan) {
        const ft = await pp.frameTicks(seq);
        if (ft && ft !== plan.frameTicks) {
          log(`sequence frame is ${ft} ticks (planned with ${plan.frameTicks}); re-planning`);
          plan = replan(ft);
          sp = plan.sequences[0];
        }
      }
      // Tracks first, in order (Premiere appends new tracks at the end).
      const nV = Math.max(1, ...sp.placements.filter((p) => p.kind === "av").map((p) => p.videoTrack + 1));
      const nA = Math.max(sp.stagingTrack + 1, ...sp.placements.map((p) => p.audioTrack + 1));
      const firstAudio = sp.placements.find((p) => p.kind === "audio");
      await pp.ensureTracks(proj, seq, nV, nA, settings.projectItem, firstAudio ? byId.get(firstAudio.clipId).projectItem : null);

      // Video+audio and whole audio clips: one undo step.
      const simple = sp.placements.filter((p) => p.kind === "av" || p.whole);
      log(`"${sp.name}": placing ${simple.length} clip(s), ${sp.placements.length - simple.length} trimmed piece(s)`);
      pp.transact(proj, `Syncu: place clips (${sp.name})`, () =>
        simple.map((p) =>
          p.kind === "av"
            ? pp.overwriteAction(seq, byId.get(p.clipId).projectItem, p.pos, p.videoTrack, p.audioTrack)
            : pp.overwriteAction(seq, byId.get(p.clipId).projectItem, p.pos - p.srcIn, 0, p.audioTrack)
        )
      );
      step += simple.length;
      if (onStep) onStep(step / total, sp.name);

      // Check a few placements landed where planned.
      for (const p of simple.slice(0, 8)) {
        const items = p.kind === "av" ? await pp.trackItemsOn(seq, "video", p.videoTrack) : await pp.trackItemsOn(seq, "audio", p.audioTrack);
        const want = p.kind === "av" ? p.pos : p.pos - p.srcIn;
        let best = Infinity;
        for (const ti of items) best = Math.min(best, Math.abs(pp.seconds(await ti.getStartTime()) - want));
        if (best > 0.0005) log("warn", `${p.name}: expected at ${want.toFixed(4)} on ${p.kind === "av" ? "V" + (p.videoTrack + 1) : "A" + (p.audioTrack + 1)}, nearest clip is ${(best * 1000).toFixed(2)} ms away`);
      }

      // Drift-cut / take-trimmed audio pieces.
      for (const p of sp.placements.filter((x) => x.kind === "audio" && !x.whole)) {
        await pp.placeAudioPiece(proj, seq, byId.get(p.clipId).projectItem, p.srcIn, p.srcOut, p.pos, p.audioTrack, sp.stagingTrack);
        step++;
        if (onStep) onStep(step / total, sp.name);
      }
      for (const t of sp.muteTracks) {
        try {
          await pp.muteAudioTrack(seq, t);
        } catch (e) {
          log("warn", `could not mute A${t + 1}: ${Syncu.log.errText(e)}`);
        }
      }
      await pp.addMarkers(proj, seq, sp.markers || []);
      made.push(seq);
    }

    if (plan.master && made.length) {
      try {
        const first = byId.get(plan.sequences[0].settingsClipId);
        const master = await pp.createSequence(proj, plan.master.name, first.projectItem, bin);
        const ft = (await pp.frameTicks(master)) || plan.frameTicks;
        const entries = [];
        let cursor = 0;
        for (const seq of made) {
          entries.push({ pi: await seq.getProjectItem(), at: cursor });
          cursor = ceilFrame(pp.seconds(await seq.getEndTime()) + cursor + 2, ft);
        }
        pp.transact(proj, "Syncu: master timeline", () => entries.map((e) => pp.overwriteAction(master, e.pi, e.at, 0, 0)));
        log(`master timeline: ${entries.length} take(s) nested`);
      } catch (e) {
        log("warn", `master timeline not built: ${Syncu.log.errText(e)}`);
      }
    }
    return made;
  }

  return { planBuild, executePlan, snap, ceilFrame };
})();
