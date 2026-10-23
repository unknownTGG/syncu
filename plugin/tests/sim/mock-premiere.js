// A small simulated Premiere Pro UXP DOM for end-to-end testing the panel
// without Premiere. Where Adobe's docs are vague it picks the pessimistic
// behaviour (new tracks always append at the end, actions must be created
// inside lockedAccess, selections die after their callback, video snaps to
// frames) so the panel code can't rely on lucky assumptions.
"use strict";

const TPS = 254016000000;

class TickTime {
  constructor(ticks) {
    this._t = Math.round(Number(ticks));
  }
  get ticks() {
    return String(this._t);
  }
  get ticksNumber() {
    return this._t;
  }
  get seconds() {
    return this._t / TPS;
  }
  static createWithTicks(t) {
    if (typeof t !== "string") throw new TypeError("createWithTicks expects a string");
    return new TickTime(t);
  }
  static createWithSeconds(s) {
    return new TickTime(s * TPS);
  }
  add(o) {
    return new TickTime(this._t + o._t);
  }
  subtract(o) {
    return new TickTime(this._t - o._t);
  }
}
TickTime.TIME_ZERO = new TickTime(0);

// subFrame: what real Premiere might allow for sub-frame audio.
//   "clone" - clone time offsets are exact; "move" - only moves are exact;
//   "none"  - everything snaps to frames. Direct placement always snaps
//   (that's what Premiere 26.5 does, per a real self-test).
function createMock({ media, frameTicks = 10594584000, subFrame = "clone" }) {
  let locked = 0;
  const actionLog = [];
  const assertLocked = (what) => {
    if (!locked) throw new Error(`${what} created outside lockedAccess (Premiere 26.3+ rejects this)`);
  };
  const action = (label, fn) => ({ __action: true, label, run: fn });

  // ---- script-object handles ----
  // Real Premiere sometimes invalidates the objects a plugin holds ("The
  // script object is no longer valid"). The panel only ever gets handles
  // (proxies); every `invalidateEvery` transactions all handles go stale
  // and any use of an old one throws, like in real Premiere.
  let gen = 0;
  let invalidateEvery = 0;
  let txCount = 0;
  // Busy spells: after every `busyEvery` transactions, every use of any
  // handle (even a freshly fetched one) fails for `busyMs`. A poisoned clip
  // is always rejected when an edit uses it.
  let busyEvery = 0, busyMs = 0, busyUntil = 0, busySpells = 0;
  let poisoned = null;
  const busy = () => Date.now() < busyUntil;
  const handleInfo = new WeakMap(); // proxy -> { target, gen }
  const handleCache = new WeakMap(); // target -> { gen, proxy }
  const STALE = "The script object is no longer valid.";
  function handle(target) {
    if (!target || typeof target !== "object" || handleInfo.has(target)) return target;
    const c = handleCache.get(target);
    if (c && c.gen === gen) return c.proxy;
    const myGen = gen;
    const proxy = new Proxy(target, {
      get(t, prop) {
        if (myGen !== gen || busy()) throw new Error(STALE);
        const v = t[prop];
        return typeof v === "function" ? v.bind(proxy) : v;
      },
    });
    handleInfo.set(proxy, { target, gen: myGen });
    handleCache.set(target, { gen: myGen, proxy });
    return proxy;
  }
  function unwrap(x) {
    const i = x && handleInfo.get(x);
    if (!i) return x;
    if (i.gen !== gen || busy()) throw new Error(STALE);
    if (poisoned && i.target.name === poisoned) throw new Error(STALE);
    return i.target;
  }

  // ---- project items ----
  let nextId = 1;
  class ProjectItem {
    constructor(kind, name) {
      this.kind = kind;
      this.name = name;
      this._id = nextId++;
    }
    getId() {
      return String(this._id);
    }
  }
  class Clip extends ProjectItem {
    constructor(m) {
      super("clip", m.name);
      Object.assign(this, { path: m.path, duration: m.duration, hasVideo: m.hasVideo, hasAudio: m.hasAudio,
        proxyPath: m.proxyPath || "", offline: !!m.offline });
    }
    async getMediaFilePath() {
      return this.path; // like Premiere: the original's path, even when offline
    }
    async hasProxy() {
      return !!this.proxyPath;
    }
    async getProxyPath() {
      return this.proxyPath;
    }
    async isOffline() {
      return this.offline;
    }
    async getInPoint(mediaType) {
      return TickTime.createWithSeconds(0);
    }
    async getOutPoint(mediaType) {
      return TickTime.createWithSeconds(this.duration);
    }
  }
  class Bin extends ProjectItem {
    constructor(name) {
      super("bin", name);
      this.children = [];
    }
    async getItems() {
      return this.children.map(handle);
    }
    createBinAction(name, makeUnique) {
      assertLocked("createBinAction");
      return action("bin", () => {
        let n = name;
        let k = 1;
        while (makeUnique && this.children.some((c) => c.name === n)) n = `${name} ${++k}`;
        this.children.push(new Bin(n));
      });
    }
  }

  // ---- timeline ----
  class TrackItem {
    constructor(seq, kind, trackIndex, clip, start, inPt, outPt) {
      Object.assign(this, { seq, kind, trackIndex, clip, start, inPt, outPt });
    }
    get end() {
      return this.start + (this.outPt - this.inPt);
    }
    async getStartTime() {
      return TickTime.createWithSeconds(this.start);
    }
    async getEndTime() {
      return TickTime.createWithSeconds(this.end);
    }
    async getInPoint() {
      return TickTime.createWithSeconds(this.inPt);
    }
    async getOutPoint() {
      return TickTime.createWithSeconds(this.outPt);
    }
    async getProjectItem() {
      return handle(this.clip);
    }
    async getName() {
      return this.clip.name;
    }
    // Trimming the in-point trims the head: start moves with it.
    createSetInPointAction(t) {
      assertLocked("createSetInPointAction");
      return action("setIn", () => {
        const d = t.seconds - this.inPt;
        this.inPt = t.seconds;
        this.start += d;
      });
    }
    createSetOutPointAction(t) {
      assertLocked("createSetOutPointAction");
      return action("setOut", () => {
        this.outPt = t.seconds;
      });
    }
    createMoveAction(t) {
      assertLocked("createMoveAction");
      return action("move", () => {
        this.start += t.seconds;
        if (subFrame !== "move") this.start = this.seq.snap(this.start);
      });
    }
  }

  class Track {
    constructor(kind) {
      this.kind = kind;
      this.items = [];
      this.muted = false;
    }
    getTrackItems(type, includeEmpty) {
      return this.items.slice().sort((a, b) => a.start - b.start);
    }
    async setMute(m) {
      this.muted = m;
      return true;
    }
    async isMuted() {
      return this.muted;
    }
  }

  class Sequence {
    constructor(name, ft) {
      this.name = name;
      this.frameTicks = ft;
      this.video = [new Track("video")];
      this.audio = [new Track("audio")];
      this.markers = [];
      this.projectItem = new ProjectItem("sequence", name);
      this.projectItem.sequence = this;
      const gid = `seq-${this.projectItem._id}`;
      this.guid = { toString: () => gid };
    }
    async getVideoTrackCount() {
      return this.video.length;
    }
    async getAudioTrackCount() {
      return this.audio.length;
    }
    async getVideoTrack(i) {
      return this.video[i];
    }
    async getAudioTrack(i) {
      return this.audio[i];
    }
    async getTimebase() {
      return String(this.frameTicks);
    }
    async getProjectItem() {
      return handle(this.projectItem);
    }
    async getEndTime() {
      let e = 0;
      for (const t of [...this.video, ...this.audio]) for (const i of t.items) e = Math.max(e, i.end);
      return TickTime.createWithSeconds(e);
    }
    snap(sec) {
      return (Math.round((sec * TPS) / this.frameTicks) * this.frameTicks) / TPS;
    }
    track(kind, index) {
      const list = kind === "video" ? this.video : this.audio;
      if (index < list.length) return list[index];
      list.push(new Track(kind)); // pessimistic: one new track, at the end
      return list[list.length - 1];
    }
    // Overwrite: clear [start, end) on the track, then add the item.
    put(kind, index, clip, start, inPt, outPt, exact = false) {
      const t = this.track(kind, index);
      const realIndex = (kind === "video" ? this.video : this.audio).indexOf(t);
      // Premiere snaps placement to frames, audio included.
      if (kind === "video" || !exact) start = this.snap(start);
      const end = start + (outPt - inPt);
      const keep = [];
      for (const it of t.items) {
        if (it.end <= start + 1e-12 || it.start >= end - 1e-12) {
          keep.push(it);
          continue;
        }
        if (it.start < start) keep.push(new TrackItem(this, kind, realIndex, it.clip, it.start, it.inPt, it.inPt + (start - it.start)));
        if (it.end > end) keep.push(new TrackItem(this, kind, realIndex, it.clip, end, it.inPt + (end - it.start), it.outPt));
      }
      const item = new TrackItem(this, kind, realIndex, clip, start, inPt, outPt);
      keep.push(item);
      t.items = keep;
      return item;
    }
  }

  const sequences = [];
  const root = new Bin("root");
  const bins = new Map();
  for (const m of media) {
    if (!bins.has(m.bin)) {
      const b = new Bin(m.bin);
      bins.set(m.bin, b);
      root.children.push(b);
    }
    bins.get(m.bin).children.push(new Clip(m));
  }
  let selection = [...bins.values()];
  let active = null;

  const project = {
    name: "Sim project",
    lockedAccess(cb) {
      locked++;
      try {
        cb();
      } finally {
        locked--;
      }
    },
    executeTransaction(cb, label) {
      if (!locked) throw new Error("executeTransaction outside lockedAccess");
      const actions = [];
      cb({ addAction: (a) => {
        if (!a || !a.__action) throw new Error(`addAction got a non-action in "${label}"`);
        actions.push(a);
      } });
      for (const a of actions) a.run();
      actionLog.push(`${label} (${actions.length})`);
      if (invalidateEvery && ++txCount % invalidateEvery === 0) gen++;
      if (busyEvery && actionLog.length % busyEvery === 0) (busyUntil = Date.now() + busyMs), busySpells++;
      return true;
    },
    async getRootItem() {
      return handle(root);
    },
    async getActiveSequence() {
      return handle(active);
    },
    async getSequences() {
      return sequences.map(handle);
    },
    async getSequence(guid) {
      const id = String(guid);
      return handle(sequences.find((x) => x.guid.toString() === id) || null);
    },
    async createSequenceFromMedia(name, clips, bin) {
      if (!clips || !clips[0]) throw new Error("createSequenceFromMedia: no clip");
      bin = unwrap(bin);
      const seq = new Sequence(name, frameTicks);
      const c = unwrap(clips[0]);
      if (c.hasVideo) seq.put("video", 0, c, 0, 0, c.duration);
      if (c.hasAudio) seq.put("audio", 0, c, 0, 0, c.duration);
      sequences.push(seq);
      (bin || root).children.push(seq.projectItem);
      active = seq;
      return handle(seq);
    },
  };

  const editorFor = (seqH) => ({
    get seq() {
      return unwrap(seqH);
    },
    createOverwriteItemAction(pi, t, vIdx, aIdx) {
      assertLocked("createOverwriteItemAction");
      const seq = this.seq;
      pi = unwrap(pi);
      if (!(t instanceof TickTime)) throw new TypeError("time must be a TickTime");
      return action("overwrite", () => {
        if (pi.sequence) {
          // Nested sequence: one item spanning the sequence.
          const end = pi.sequence.video.concat(pi.sequence.audio).flatMap((x) => x.items).reduce((e, i) => Math.max(e, i.end), 0);
          seq.put("video", vIdx, pi, t.seconds, 0, end);
          return;
        }
        if (pi.hasVideo) seq.put("video", vIdx, pi, t.seconds, 0, pi.duration);
        if (pi.hasAudio) seq.put("audio", aIdx, pi, t.seconds, 0, pi.duration);
      });
    },
    createInsertProjectItemAction(pi, t, vIdx, aIdx, limitShift) {
      assertLocked("createInsertProjectItemAction");
      const seq = this.seq;
      pi = unwrap(pi);
      return action("insert", () => {
        // Ripple everything at/after t on all tracks, then place.
        for (const tr of [...seq.video, ...seq.audio]) for (const it of tr.items) if (it.start >= t.seconds) it.start += pi.duration;
        if (pi.hasVideo) seq.put("video", vIdx, pi, t.seconds, 0, pi.duration);
        if (pi.hasAudio) seq.put("audio", aIdx, pi, t.seconds, 0, pi.duration);
      });
    },
    createCloneTrackItemAction(item, offset, vOff, aOff, alignToVideo, isInsert) {
      assertLocked("createCloneTrackItemAction");
      const seq = this.seq;
      return action("clone", () => {
        const list = item.kind === "video" ? seq.video : seq.audio;
        const target = item.trackIndex + (item.kind === "video" ? vOff : aOff);
        if (target < 0 || target >= list.length) throw new Error(`clone target track ${target} doesn't exist`);
        seq.put(item.kind, target, item.clip, item.start + offset.seconds, item.inPt, item.outPt, subFrame === "clone");
      });
    },
    createRemoveItemsAction(sel, ripple, mediaType, shift) {
      assertLocked("createRemoveItemsAction");
      const seq = this.seq;
      if (!sel.__valid) throw new Error("TrackItemSelection used outside its createEmptySelection callback");
      const items = sel.items.slice();
      return action("remove", () => {
        for (const tr of [...seq.video, ...seq.audio]) tr.items = tr.items.filter((i) => !items.includes(i));
      });
    },
  });

  const ppro = {
    TickTime,
    Constants: { TrackItemType: { EMPTY: 0, CLIP: 1, TRANSITION: 2 }, MediaType: { ANY: "any", VIDEO: "video", AUDIO: "audio" } },
    Project: { getActiveProject: async () => handle(project) },
    ProjectUtils: { getSelection: async () => ({ getItems: async () => selection.map(handle) }) },
    Guid: { fromString: (str) => ({ toString: () => String(str) }) },
    FolderItem: { cast: (i) => (i && i.kind === "bin" ? i : null) },
    ClipProjectItem: { cast: (i) => (i && i.kind === "clip" ? i : null) },
    SequenceEditor: { getEditor: (seq) => editorFor(seq) },
    TrackItemSelection: {
      createEmptySelection(cb) {
        const sel = { __valid: true, items: [], addItem(ti) {
          this.items.push(ti);
          return true;
        } };
        cb(sel);
        sel.__valid = false;
        return true;
      },
    },
    Markers: {
      getMarkers: async (seqH) => {
        const seq = unwrap(seqH);
        return {
        createAddMarkerAction(name, type, start, dur, comment) {
          assertLocked("createAddMarkerAction");
          return action("marker", () => seq.markers.push({ name, time: start.seconds, comment }));
        },
        getMarkers: () => seq.markers.slice(),
      };
      },
    },
  };

  return {
    ppro, project, sequences, actionLog,
    setSelection: (items) => (selection = items),
    bins,
    setActive: (s) => (active = s),
    setInvalidateEvery: (n) => {
      invalidateEvery = n;
      txCount = 0;
    },
    staleGenerations: () => gen,
    setBusySpells: (every, ms) => {
      busyEvery = every;
      busyMs = ms;
      busyUntil = 0;
    },
    busySpells: () => busySpells,
    setPoisoned: (name) => {
      poisoned = name;
    },
  };
}

module.exports = { createMock, TickTime, TPS };
