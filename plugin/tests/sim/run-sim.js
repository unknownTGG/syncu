// End-to-end simulation: real panel code + real helper + real media, with a
// mock Premiere. Drives the UI (Scan -> Analyze -> Build in all three modes,
// self-test, report) and checks the resulting timelines against the truth
// the engine test suite used to generate the media.
//
//   node run-sim.js <media-dir from engine/tests/run_tests.py> [engine-binary]
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { JSDOM } = require(process.env.JSDOM_PATH || "jsdom");
const { createMock } = require("./mock-premiere");

const MEDIA = process.argv[2];
const ENGINE = process.argv[3] || path.join(__dirname, "../../../engine/build/syncu-engine");
const PLUGIN = path.join(__dirname, "../..");
const SR = 48000;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ": " + detail : ""}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function duration(file) {
  let out = "";
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    out = String(e.stderr);
  }
  const m = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

// Truth: scene time at each file's time zero (see engine/tests/run_tests.py).
const camB = [20, 90, 200, 320, 500];
const truth = { "camlong.mp4": 0, "camB_off.mov": 599.8, "camB_silent.mp4": 400, "gimbal.mp4": 252 };
camB.forEach((s, i) => (truth[`camB_${i}.mp4`] = s - 0.25 / SR));
const recTruth = (t) => 5 + t / (1 + 40e-6); // recdrift.wav local t -> scene time

async function main() {
  const media = [
    ["Cam A", "camlong.mp4"],
    ...camB.map((_, i) => ["Cam B", `camB_${i}.mp4`]),
    ["Cam B", "camB_off.mov"], ["Cam B", "camB_silent.mp4"],
    ["Gimbal", "gimbal.mp4"], ["Zoom", "recdrift.wav"], ["Phone", "other.wav"],
  ].map(([bin, name]) => {
    const p = path.join(MEDIA, name);
    const isAudio = name.endsWith(".wav");
    return { bin, name, path: p, duration: duration(p), hasVideo: !isAudio, hasAudio: name !== "camB_silent.mp4" && name !== "gimbal.mp4" };
  });
  // Realistic file times: cameras/recorders write the file when recording
  // stops, so mtime = start + duration (engine uses start = mtime - duration).
  const base = 1.7e9;
  for (const m of media) {
    const start = m.name === "recdrift.wav" ? 5 : m.name === "other.wav" ? 1000 : truth[m.name];
    const t = base + start + m.duration;
    fs.utimesSync(m.path, t, t);
  }
  check("media present", media.every((m) => m.duration > 0), media.map((m) => `${m.name}=${m.duration.toFixed(1)}`).join(" "));

  // Helper on the real port.
  const helper = spawn(ENGINE, ["serve", "47800"], { stdio: ["ignore", "ignore", "pipe"] });
  let helperErr = "";
  helper.stderr.on("data", (d) => (helperErr += d));
  await sleep(500);

  const mock = createMock({ media });
  const html = fs.readFileSync(path.join(PLUGIN, "index.html"), "utf8").replace(/<script[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const w = dom.window;
  const memFiles = {};
  let clipboard = "";
  w.fetch = fetch;
  w.navigator.clipboard = { writeText: async (t) => (clipboard = t) };
  w.require = (name) => {
    if (name === "premierepro") return mock.ppro;
    if (name === "uxp") return {
      host: { name: "Premiere Pro (sim)", version: "26.2.0", uiLocale: "en_US" },
      storage: { localFileSystem: {
        getDataFolder: async () => ({
          createFile: async (n) => ({ write: async (t) => (memFiles[n] = t) }),
          getEntry: async (n) => ({ read: async () => memFiles[n] || "" }),
        }),
        getFileForSaving: async (n) => ({ name: n, nativePath: "/sim/" + n, write: async (t) => (memFiles[n] = t) }),
      } },
    };
    if (name === "os") return { platform: () => "sim", release: () => "1", arch: () => "x64" };
    throw new Error("unexpected require " + name);
  };
  const errors = [];
  w.console.error = (...a) => errors.push(a.join(" "));
  for (const f of ["log.js", "engine.js", "devices.js", "premiere.js", "build.js", "main.js"])
    w.eval(fs.readFileSync(path.join(PLUGIN, "js", f), "utf8") + `\n//# sourceURL=${f}`);
  const $ = (id) => w.document.getElementById(id);
  const click = async (id, until, timeout = 300000) => {
    $(id).dispatchEvent(new w.Event("click"));
    const t0 = Date.now();
    await sleep(50);
    while (!until() && Date.now() - t0 < timeout) await sleep(100);
  };
  const busy = (id) => $(id).disabled;

  await sleep(300);
  check("helper pill green", $("engineStatus").className.includes("ok"), $("engineStatus").textContent);

  // ---- Scan ----
  await click("scanBtn", () => !busy("scanBtn"));
  const devRows = $("deviceList").querySelectorAll(".row").length;
  check("scan: 5 devices", devRows === 5, `${devRows} rows`);

  // ---- Analyze ----
  await click("analyzeBtn", () => !busy("analyzeBtn"));
  const summary = $("summary").textContent.replace(/\s+/g, " ");
  check("analyze: summary", /synced by audio/.test(summary), summary.slice(0, 160));
  check("analyze: review list shows unmatched + timestamp clips", !$("reviewSection").classList.contains("hidden"),
    $("reviewList").textContent.replace(/\s+/g, " ").slice(0, 200));

  // ---- Build, each mode ----
  for (const mode of ["timeline", "multicam", "takes"]) {
    const before = mock.sequences.length;
    $("outputMode").value = mode;
    await click("buildBtn", () => !busy("buildBtn"));
    const made = mock.sequences.slice(before);
    const err = [...$("summary").querySelectorAll(".row.err")].map((r) => r.textContent.trim()).join(" | ");
    check(`${mode}: built without errors`, !err && made.length > 0, err || `${made.length} sequence(s)`);
    for (const seq of made) verifySequence(mode, seq);
  }

  // ---- Self-test ----
  const clipsInMock = [...mock.bins.values()].flatMap((b) => b.children);
  mock.setSelection([clipsInMock.find((c) => c.name === "camlong.mp4"), clipsInMock.find((c) => c.name === "recdrift.wav")]);
  await click("selfTestBtn", () => !busy("selfTestBtn"));
  const logText = $("log").textContent;
  const selfLines = logText.split("\n").filter((l) => l.includes("self-test:"));
  check("self-test ran", selfLines.some((l) => l.includes("done")), `${selfLines.length} lines`);
  check("self-test: all OK in sim", !selfLines.some((l) => l.includes("FAIL")), selfLines.filter((l) => l.includes("FAIL")).join(" | "));

  // ---- Report ----
  await click("copyReportBtn", () => !busy("copyReportBtn"));
  for (const s of ["helper", "settings", "scan", "analysis", "last build plan", "self-test", "panel log", "helper log"])
    check(`report has "${s}"`, clipboard.includes(`===== ${s}`));
  check("report includes helper log lines", /analyze done in/.test(clipboard));
  fs.writeFileSync(path.join(MEDIA, "sim-report.txt"), clipboard);
  await sleep(2500);
  check("log persisted to data folder", (memFiles["syncu-log.txt"] || "").includes("build"));

  const errLines = logText.split("\n").filter((l) => l.includes("[error]"));
  check("no errors logged", errLines.length === 0, errLines.slice(0, 5).join(" | "));
  check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  helper.kill();
  console.log(failed ? `\n${failed} FAILED (report: ${MEDIA}/sim-report.txt)` : "\nall simulation checks passed");
  process.exit(failed ? 1 : 0);

  // ---- timeline checks ----
  function verifySequence(mode, seq) {
    const tag = `${mode}/${seq.name}`;
    const vItems = seq.video.flatMap((t) => t.items);
    const aItems = seq.audio.flatMap((t) => t.items);
    if (!vItems.length && aItems.some((i) => i.clip.sequence)) return;
    if (seq.name.endsWith("master")) {
      check(`${tag}: nests take sequences`, vItems.length > 0 && vItems.every((i) => i.clip.sequence), `${vItems.length} nested`);
      return;
    }
    const ref = vItems.find((i) => i.clip.name === "camlong.mp4");
    if (!ref) {
      check(`${tag}: has reference camera`, false);
      return;
    }
    const zero = ref.start - ref.inPt;
    const halfFrame = 0.5 * seq.frameTicks / 254016000000 + 1e-6;
    const names = new Map();
    for (const it of vItems) names.set(it.clip.name, (names.get(it.clip.name) || 0) + 1);
    check(`${tag}: each video clip once`, [...names.values()].every((n) => n === 1), JSON.stringify([...names]));
    check(`${tag}: unrelated clip not placed`, !aItems.some((i) => i.clip.name === "other.wav"));
    for (const it of vItems) {
      const want = truth[it.clip.name];
      const got = it.start - it.inPt - zero;
      const tol = it.clip.name === "gimbal.mp4" || it.clip.name === "camB_silent.mp4" ? 1.0 : halfFrame;
      check(`${tag}: ${it.clip.name} sync`, Math.abs(got - want) <= tol, `${got.toFixed(4)} vs ${want.toFixed(4)} (err ${((got - want) * 1000).toFixed(2)} ms, tol ${(tol * 1000).toFixed(1)} ms)`);
      const fr = (it.start * 254016000000) / seq.frameTicks;
      if (Math.abs(fr - Math.round(fr)) > 1e-6) check(`${tag}: ${it.clip.name} on frame`, false);
    }
    // Recorder pieces: exact sync at their middle and edges, against the camera's actual frame.
    const rec = aItems.filter((i) => i.clip.name === "recdrift.wav").sort((a, b) => a.start - b.start);
    check(`${tag}: recorder placed`, rec.length > 0, `${rec.length} piece(s)`);
    let worst = 0;
    for (const p of rec)
      for (const t of [p.inPt + 0.01, 0.5 * (p.inPt + p.outPt), p.outPt - 0.01]) {
        const tl = p.start + (t - p.inPt) - zero;
        worst = Math.max(worst, Math.abs(tl - recTruth(t)));
      }
    check(`${tag}: recorder sync ≤ 2.5 ms everywhere`, worst <= 0.0025, `worst ${(worst * 1000).toFixed(3)} ms`);
    const recTracks = new Set(rec.map((p) => p.trackIndex));
    check(`${tag}: recorder on one track`, recTracks.size === 1, [...recTracks].join(","));
    for (let i = 1; i < rec.length; i++)
      if (rec[i].start < rec[i - 1].end - 1e-9) check(`${tag}: pieces don't overlap`, false, `${i}`);
    // Camera scratch audio sits under its video, on muted tracks.
    const scratch = aItems.filter((i) => i.clip.hasVideo);
    const misaligned = scratch.filter((a) => !vItems.some((v) => v.clip === a.clip && Math.abs(v.start - a.start) < 1e-9));
    check(`${tag}: scratch audio aligned with video`, misaligned.length === 0, `${misaligned.length} misaligned of ${scratch.length}`);
    const scratchMuted = scratch.every((a) => seq.audio[a.trackIndex].muted);
    const recUnmuted = rec.every((p) => !seq.audio[p.trackIndex].muted);
    check(`${tag}: scratch muted, recorder audible`, scratchMuted && recUnmuted);
    check(`${tag}: recorder tracks above scratch`, rec.every((p) => scratch.every((s) => p.trackIndex < s.trackIndex)));
    // Timestamp-placed clips are flagged with markers.
    const flagged = seq.markers.map((m) => m.name).join(", ");
    check(`${tag}: review markers`, /camB_silent/.test(flagged) && /gimbal/.test(flagged), flagged);
    // No stray helper/staging clips: every audio item is a recorder piece or a camera's scratch.
    const stray = aItems.filter((a) => !rec.includes(a) && !scratch.includes(a));
    check(`${tag}: no stray clips`, stray.length === 0, stray.map((s) => s.clip.name).join(","));
  }
}

main().catch((e) => {
  console.error("SIM CRASHED:", e);
  process.exit(2);
});
