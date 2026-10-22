// Node tests for the pure parts of the panel: device detection and build
// planning. Run: node plugin/tests/plan.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = { window: {}, console };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["devices.js", "build.js"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", f), "utf8"), ctx, { filename: f });
const { devices, build } = ctx.Syncu;

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ": " + detail : ""}`);
  if (!ok) failed++;
}

// ---- devices ----
check("folder device: Sony card", devices.folderDevice("/Shoot/Cam A/Card 2/PRIVATE/M4ROOT/CLIP/C0001.MP4") === "Cam A");
check("folder device: GoPro", devices.folderDevice("D:\\Day1\\GoPro\\DCIM\\100GOPRO\\GX010023.MP4") === "GoPro");
check("take stem: Zoom", devices.takeStem("/a/ZOOM0004_Tr1.WAV") === "ZOOM0004");
check("take stem: Zoom LR", devices.takeStem("/a/ZOOM0004_LR.WAV") === "ZOOM0004");
check("take stem: F-series", devices.takeStem("/a/230101_0001_Tr2.wav") === "230101_0001");
const cl = devices.classify(
  [
    { id: "1", path: "/s/Zoom/ZOOM0001_Tr1.WAV", name: "ZOOM0001_Tr1.WAV", bin: "Zoom" },
    { id: "2", path: "/s/Zoom/ZOOM0001_Tr2.WAV", name: "ZOOM0001_Tr2.WAV", bin: "Zoom" },
    { id: "3", path: "/s/Zoom/ZOOM0002_Tr1.WAV", name: "ZOOM0002_Tr1.WAV", bin: "Zoom" },
    { id: "4", path: "/s/A/C0001.MP4", name: "C0001.MP4", bin: "Cam A" },
  ],
  "bins"
);
check("classify: grouped multi-file take", cl[0].group && cl[0].group === cl[1].group, cl[0].group);
check("classify: lone take not grouped", !cl[2].group);
check("classify: video flag", cl[3].isVideo === true && cl[0].isVideo === false);

// ---- planner, on a synthetic engine result ----
const TPS = 254016000000;
const FT = 10594584000; // 23.976 fps
const clips = [
  { id: "A", name: "A.mp4", device: "Cam A", isVideo: true },
  { id: "B1", name: "B1.mp4", device: "Cam B", isVideo: true },
  { id: "B2", name: "B2.mp4", device: "Cam B", isVideo: true },
  { id: "R", name: "R.wav", device: "Zoom", isVideo: false },
  { id: "X", name: "X.mp4", device: "Cam C", isVideo: true },
  { id: "S2A", name: "S2A.mp4", device: "Cam A", isVideo: true },
  { id: "S2R", name: "S2R.wav", device: "Zoom", isVideo: false },
];
const seg = (start, end, position) => ({ start, end, position });
const result = {
  components: 2,
  clips: [
    { id: "A", method: "audio", component: 0, driftPpm: 0, segments: [seg(0, 600, 1.00001)] },
    { id: "B1", method: "audio", component: 0, driftPpm: 0, segments: [seg(0, 60, 20.0123)] },
    { id: "B2", method: "audio", component: 0, driftPpm: 0, segments: [seg(0, 30, 300.5)] },
    // Recorder cut in 3 pieces for drift (positions slightly different per piece).
    { id: "R", method: "audio", component: 0, driftPpm: -40, segments: [seg(0, 200, 0.0), seg(200, 400, 199.996), seg(400, 640, 399.992)] },
    { id: "X", method: "none", component: -1, driftPpm: 0, segments: [] },
    { id: "S2A", method: "audio", component: 1, driftPpm: 0, segments: [seg(0, 100, 0.25)] },
    { id: "S2R", method: "audio", component: 1, driftPpm: 0, segments: [seg(0, 120, 0.0)] },
  ],
};
const onFrame = (sec) => Math.abs(((sec * TPS) / FT) - Math.round((sec * TPS) / FT)) < 1e-6;

for (const mode of ["timeline", "multicam", "takes"]) {
  const plan = build.planBuild(clips, result, { mode, frameTicks: FT, muteScratch: true, trimTakes: mode === "takes" });
  const all = plan.sequences.flatMap((s) => s.placements);
  check(`${mode}: unplaced reported`, plan.unplaced.length === 1 && plan.unplaced[0] === "X");
  check(`${mode}: every video on a frame`, all.filter((p) => p.kind === "av").every((p) => onFrame(p.pos)));
  check(`${mode}: nothing before 0`, all.every((p) => p.pos >= -1e-9), Math.min(...all.map((p) => p.pos)).toFixed(4));
  // No two placements on the same track overlap.
  for (const s of plan.sequences) {
    const spans = s.placements.map((p) => ({
      t: p.kind === "av" ? `V${p.videoTrack}` : `A${p.audioTrack}`,
      a: p.pos, b: p.pos + (p.kind === "av" ? 1 : p.srcOut - p.srcIn),
    }));
    const clash = spans.some((x, i) => spans.some((y, j) => i < j && x.t === y.t && x.a < y.b - 1e-9 && y.a < x.b - 1e-9));
    if (mode !== "timeline" || s === plan.sequences[0]) check(`${mode}: no overlaps on a track (${s.name})`, !clash);
  }
  // Relative sync is preserved: recorder piece vs reference camera A.
  for (const s of plan.sequences) {
    const a = s.placements.find((p) => p.clipId === "A");
    const r = s.placements.find((p) => p.clipId === "R" && p.srcIn <= 300 && p.srcOut >= 300);
    if (!a || !r) continue;
    // Truth: R at source 300 s sits at timeline 199.996 + 100 relative to A's zero at 1.00001.
    const rel = r.pos + (300 - r.srcIn) - a.pos;
    const want = 199.996 + 100 - 1.00001;
    check(`${mode}: recorder vs camera A sync (${s.name})`, Math.abs(rel - want) < 1e-6, `${rel.toFixed(6)} vs ${want.toFixed(6)}`);
  }
  if (mode === "timeline") check("timeline: one sequence", plan.sequences.length === 1);
  if (mode === "multicam") check("multicam: one sequence per scene", plan.sequences.length === 2);
  if (mode === "takes") {
    check("takes: master requested", !!plan.master);
    check("takes: 2 takes (scene 1 merged by overlap, scene 2)", plan.sequences.length === 2, `${plan.sequences.length} takes`);
  }
}

// Full-length audio (default): every recorder file is placed whole, never cut.
const fullResult = {
  components: 1,
  clips: [
    { id: "A", method: "audio", component: 0, driftPpm: 0, segments: [seg(0, 100, 300.0)] },
    { id: "B1", method: "audio", component: 0, driftPpm: 0, segments: [seg(0, 50, 320.0)] },
    { id: "R", method: "audio", component: 0, driftPpm: -30, segments: [seg(0, 3600, 0.0)] },
  ],
};
for (const mode of ["timeline", "multicam", "takes"]) {
  const p = build.planBuild(clips, fullResult, { mode, frameTicks: FT });
  const rec = p.sequences.flatMap((s) => s.placements).filter((x) => x.clipId === "R");
  check(`full audio/${mode}: recorder placed whole`, rec.length === p.sequences.length && rec.every((x) => x.whole && x.srcIn === 0 && x.srcOut === 3600));
  check(`full audio/${mode}: nothing before 0`, p.sequences.flatMap((s) => s.placements).every((x) => x.pos >= -1e-9));
  const a = p.sequences[0].placements.find((x) => x.clipId === "A");
  const r = rec[0];
  check(`full audio/${mode}: sync kept`, Math.abs((a.pos - r.pos) - 300.0) < FT / TPS, `${(a.pos - r.pos).toFixed(4)}`);
}
const trimmed = build.planBuild(clips, fullResult, { mode: "takes", frameTicks: FT, trimTakes: true });
const tr = trimmed.sequences[0].placements.find((x) => x.clipId === "R");
check("trimTakes: recorder trimmed to the take", tr && !tr.whole && tr.srcOut - tr.srcIn < 110, tr && `${tr.srcIn.toFixed(1)}-${tr.srcOut.toFixed(1)}`);

// Clips that didn't sync still go on the timeline, in a marked area.
const withUnsynced = {
  components: 1,
  clips: [...fullResult.clips, { id: "X", method: "none", component: -1, driftPpm: 0, segments: [], duration: 30, needsReview: true }],
};
const tl = build.planBuild(clips, withUnsynced, { mode: "timeline", frameTicks: FT });
const xs = tl.sequences[0].placements.filter((p) => p.clipId === "X");
const syncedEnd = Math.max(...tl.sequences[0].placements.filter((p) => p.clipId !== "X").map((p) => p.pos + (p.kind === "av" ? 0 : p.srcOut - p.srcIn)));
check("unsynced/timeline: clip placed after synced material", xs.length === 1 && xs[0].pos >= syncedEnd, xs[0] && xs[0].pos.toFixed(1));
check("unsynced/timeline: area marked", tl.sequences[0].markers.some((m) => m.name === "Not synced"));
check("unsynced/timeline: not reported as dropped", tl.unplaced.length === 0 && tl.unsynced.includes("X"));
const mcu = build.planBuild(clips, withUnsynced, { mode: "multicam", frameTicks: FT });
check("unsynced/multicam: separate 'not synced' sequence", mcu.sequences.some((s) => s.name.endsWith("not synced") && s.placements.some((p) => p.clipId === "X")));
// Several unsynced clips from three devices: one device after another,
// cameras before audio, never overlapping.
{
  const un = (id, duration) => ({ id, method: "none", component: -1, driftPpm: 0, segments: [], duration, needsReview: true });
  const many = build.planBuild(clips, { components: 0, clips: [un("S2R", 40), un("B1", 20), un("X", 30), un("B2", 25), un("R", 50)] },
                               { mode: "timeline", frameTicks: FT });
  const ps = many.sequences[0].placements.filter((p) => p.kind === "av" || p.kind === "audio");
  const span = new Map();
  for (const p of ps) {
    const len = p.srcOut - p.srcIn;
    const s = span.get(p.clipId) || [Infinity, -Infinity];
    span.set(p.clipId, [Math.min(s[0], p.pos), Math.max(s[1], p.pos + len)]);
  }
  const iv = [...span.entries()].sort((a, b) => a[1][0] - b[1][0]);
  const overlap = iv.some((x, i) => i && x[1][0] < iv[i - 1][1][1] - 1e-6);
  check("unsynced: no two clips overlap in time", !overlap, iv.map((x) => `${x[0]}@${x[1][0].toFixed(1)}`).join(" "));
  const order = iv.map((x) => x[0]).join(",");
  check("unsynced: cameras one after another, then audio", order === "B1,B2,X,S2R,R", order);
}
const nothing = build.planBuild(clips, { components: 0, clips: [{ id: "X", method: "none", component: -1, driftPpm: 0, segments: [], duration: 30 }] }, { mode: "timeline", frameTicks: FT });
check("unsynced: builds even when nothing synced", nothing.sequences.length === 1 && nothing.sequences[0].placements.length === 1);

// Scratch audio tracks come after recorder tracks and get muted.
const mc = build.planBuild(clips, result, { mode: "multicam", frameTicks: FT, muteScratch: true }).sequences[0];
const recTracks = mc.placements.filter((p) => p.kind === "audio").map((p) => p.audioTrack);
const camAudio = mc.placements.filter((p) => p.kind === "av").map((p) => p.audioTrack);
check("tracks: recorder first, scratch after", Math.max(...recTracks) < Math.min(...camAudio), `rec ${[...new Set(recTracks)]} cam ${[...new Set(camAudio)]}`);
check("tracks: drift pieces stay on one track", new Set(recTracks).size === 1);
check("tracks: scratch muted", camAudio.every((t) => mc.muteTracks.includes(t)));
check("tracks: Cam A (most footage) on V1", mc.placements.find((p) => p.clipId === "A").videoTrack === 0);

console.log(failed ? `\n${failed} FAILED` : "\nall planner tests passed");
process.exit(failed ? 1 : 0);
