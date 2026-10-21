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
  // Editing with proxies: camB_3's original is on an unplugged drive, its
  // proxy is local. lost.MOV is offline with no proxy at all.
  const camB3 = media.find((m) => m.name === "camB_3.mp4");
  Object.assign(camB3, { path: "/Volumes/T7/Day 1/CamB/camB_3.MOV", proxyPath: camB3.path, offline: true });
  media.push({ bin: "Cam B", name: "lost.MOV", path: "/Volumes/T7/Day 1/CamB/lost.MOV", duration: 12, hasVideo: true, hasAudio: false, offline: true });
  // Realistic file times: cameras/recorders write the file when recording
  // stops, so mtime = start + duration (engine uses start = mtime - duration).
  const base = 1.7e9;
  for (const m of media) {
    if (m.offline) continue; // nothing on disk to touch
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

  const SUBFRAME = process.env.MOCK_SUBFRAME || "clone";
  console.log(`mock Premiere: sub-frame mode "${SUBFRAME}"`);
  const mock = createMock({ media, subFrame: SUBFRAME });
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
  const devRows = $("deviceList").querySelectorAll(".device").length;
  check("scan: 5 devices", devRows === 5, `${devRows} rows`);

  // ---- Analyze (with a garbage setting, like the -13 seen in real Premiere) ----
  $("autoConf").value = "-13";
  await click("analyzeBtn", () => !busy("analyzeBtn"));
  const summary = $("summary").textContent.replace(/\s+/g, " ");
  check("analyze: summary", /synced by audio/i.test(summary), summary.slice(0, 160));
  check("settings: bad confidence reset to default", $("autoConf").value === "0.5" && /setting autoConf: "-13"/.test(w.Syncu.log.lines().join("\n")), $("autoConf").value);
  check("analyze: proxy used for offline original", /analysed from their proxies/.test(summary), (summary.match(/\d+ clip\(s\) analysed[^.]*/) || [""])[0]);
  check("analyze: missing file explained", /1 file\(s\) can't be read/.test(summary) && /\/Volumes\/T7/.test(summary), (summary.match(/\d+ file\(s\) can't be read[^.]*\./) || [""])[0]);
  check("analyze: drift reported for full-length recorder", /Clock drift on \d+ long clip/.test(summary) && /clock drifts -40\.\d ppm/.test(w.Syncu.log.lines().join("\n")), (summary.match(/[^.]*clock drifts[^.]*/) || [""])[0]);
  check("analyze: review list shows unmatched + timestamp clips", !$("reviewSection").classList.contains("hidden"),
    $("reviewList").textContent.replace(/\s+/g, " ").slice(0, 200));

  // ---- Build, each mode ----
  for (const mode of ["timeline", "multicam", "takes"]) {
    const before = mock.sequences.length;
    w.document.querySelector(`input[name="output"][value="${mode}"]`).checked = true;
    await click("buildBtn", () => !busy("buildBtn"));
    const made = mock.sequences.slice(before);
    const err = [...$("summary").querySelectorAll(".row.err:not(.media)")].map((r) => r.textContent.trim()).join(" | ");
    check(`${mode}: built without errors`, !err && made.length > 0, err || `${made.length} sequence(s)`);
    for (const seq of made) verifySequence(mode, seq, false);
  }

  // ---- Opt-in drift cuts: re-analyze and build a synced timeline ----
  $("driftCuts").checked = true;
  await click("analyzeBtn", () => !busy("analyzeBtn"));
  {
    const before = mock.sequences.length;
    w.document.querySelector('input[name="output"][value="timeline"]').checked = true;
    await click("buildBtn", () => !busy("buildBtn"));
    const made = mock.sequences.slice(before);
    check("drift cuts: built", made.length === 1);
    for (const seq of made) verifySequence("driftcuts", seq, true);
  }
  $("driftCuts").checked = false;
  const accLines = w.Syncu.log.lines().join("\n").split("\n").filter((l) => /audio placed sample-accurately|audio placement accuracy|sub-frame/.test(l));
  check(`audio accuracy logged (${SUBFRAME})`, accLines.length > 0, accLines.slice(-2).map((l) => l.slice(13, 140)).join(" | "));

  // ---- Self-test ----
  const clipsInMock = [...mock.bins.values()].flatMap((b) => b.children);
  mock.setSelection([clipsInMock.find((c) => c.name === "camlong.mp4"), clipsInMock.find((c) => c.name === "recdrift.wav")]);
  await click("selfTestBtn", () => !busy("selfTestBtn"));
  const logText = w.Syncu.log.lines().join("\n");
  const selfLines = logText.split("\n").filter((l) => l.includes("self-test:"));
  check("self-test ran", selfLines.some((l) => l.includes("done")), `${selfLines.length} lines`);
  // With no sub-frame support at all, "exact audio placement" is expected to FAIL.
  const fails = selfLines.filter((l) => l.includes("FAIL") && !(SUBFRAME === "none" && l.includes("exact audio placement")));
  check("self-test: all OK in sim", fails.length === 0, fails.join(" | "));
  const exactLine = selfLines.find((l) => l.includes("exact audio placement")) || "";
  check("self-test: reports exact placement result", !!exactLine, exactLine.slice(13, 200));

  // ---- Report ----
  await click("copyReportBtn", () => !busy("copyReportBtn"));
  for (const s of ["helper", "settings", "scan", "analysis", "last build plan", "self-test", "panel log", "helper log"])
    check(`report has "${s}"`, clipboard.includes(`===== ${s}`));
  check("report includes helper log lines", /analyze done in/.test(clipboard));
  fs.writeFileSync(path.join(MEDIA, "sim-report.txt"), clipboard);
  await sleep(2500);
  check("log persisted to data folder", (memFiles["syncu-log.txt"] || "").includes("build"));

  const errLines = w.Syncu.log.lines().join("\n").split("\n").filter((l) => l.includes("[error]"));
  check("no errors logged", errLines.length === 0, errLines.slice(0, 5).join(" | "));
  check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  // ---- Helper stops mid-session: clear error + report says why ----
  helper.kill();
  await sleep(500);
  $("summary").innerHTML = "";
  await click("analyzeBtn", () => !busy("analyzeBtn"));
  check("helper down: clear error shown", /helper isn't ready/.test($("summary").textContent), $("summary").textContent.trim().slice(0, 100));
  check("helper down: pill turns red", $("engineStatus").className.includes("bad"), $("engineStatus").textContent);
  await click("copyReportBtn", () => !busy("copyReportBtn"));
  check("helper down: report explains", /NOT REACHABLE on 127\.0\.0\.1:47800 \(.+\)/.test(clipboard), (clipboard.match(/NOT REACHABLE.*/) || [""])[0]);

  console.log(failed ? `\n${failed} FAILED (report: ${MEDIA}/sim-report.txt)` : "\nall simulation checks passed");
  process.exit(failed ? 1 : 0);

  // ---- timeline checks ----
  function verifySequence(mode, seq, cuts) {
    const tag = `${mode}/${seq.name}`;
    const UNSYNCED = new Set(["other.wav", "lost.MOV"]);
    const allV = seq.video.flatMap((t) => t.items);
    const allA = seq.audio.flatMap((t) => t.items);
    const isUns = (i) => UNSYNCED.has(i.clip.name);
    if (seq.name.endsWith("not synced")) {
      const names = [...allV, ...allA].map((i) => i.clip.name).sort().join(",");
      check(`${tag}: holds the clips that didn't sync`, names === "lost.MOV,other.wav", names);
      check(`${tag}: marked`, seq.markers.some((m) => m.name === "Not synced"));
      return;
    }
    // In the synced timeline, not-synced clips come after everything else.
    const uns = [...allV, ...allA].filter(isUns);
    const syncedEnd = Math.max(...[...allV, ...allA].filter((i) => !isUns(i)).map((i) => i.end));
    if (mode === "timeline" || mode === "driftcuts") {
      check(`${tag}: not-synced clips placed after the synced material`, uns.length === 2 && uns.every((i) => i.start >= syncedEnd - 1e-6), uns.map((i) => `${i.clip.name}@${i.start.toFixed(1)}`).join(" "));
      check(`${tag}: not-synced area marked`, seq.markers.some((m) => m.name === "Not synced" && m.time >= syncedEnd - 1e-6));
    }
    const vItems = allV.filter((i) => !isUns(i));
    const aItems = allA.filter((i) => !isUns(i));
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
    check(`${tag}: unrelated clip not mixed into the synced material`, !aItems.some((i) => i.clip.name === "other.wav"));
    for (const it of vItems) {
      const want = truth[it.clip.name];
      const got = it.start - it.inPt - zero;
      const tol = it.clip.name === "gimbal.mp4" || it.clip.name === "camB_silent.mp4" ? 1.0 : halfFrame;
      check(`${tag}: ${it.clip.name} sync`, Math.abs(got - want) <= tol, `${got.toFixed(4)} vs ${want.toFixed(4)} (err ${((got - want) * 1000).toFixed(2)} ms, tol ${(tol * 1000).toFixed(1)} ms)`);
      const fr = (it.start * 254016000000) / seq.frameTicks;
      if (Math.abs(fr - Math.round(fr)) > 1e-6) check(`${tag}: ${it.clip.name} on frame`, false);
    }
    // Recorder: against the reference camera's actual frame. Sample-exact
    // unless the mock (like a worst-case Premiere) allows no sub-frame edits.
    const exactTol = SUBFRAME === "none" ? halfFrame : 0.00005;
    const rec = aItems.filter((i) => i.clip.name === "recdrift.wav").sort((a, b) => a.start - b.start);
    const recDur = media.find((m) => m.name === "recdrift.wav").duration;
    const errAt = (p, t) => Math.abs(p.start + (t - p.inPt) - zero - recTruth(t));
    if (!cuts) {
      const r = rec[0];
      check(`${tag}: recorder is one full-length clip`, rec.length === 1 && Math.abs(r.inPt) < 1e-9 && Math.abs(r.outPt - recDur) < 0.05,
        rec.map((p) => `${p.inPt.toFixed(2)}-${p.outPt.toFixed(2)}`).join(","));
      const mid = errAt(r, 0.5 * recDur);
      check(`${tag}: recorder in sync at its middle`, mid <= exactTol, `${(mid * 1000).toFixed(4)} ms (tol ${(exactTol * 1000).toFixed(3)})`);
      const ends = Math.max(errAt(r, 0.01), errAt(r, recDur - 0.01));
      check(`${tag}: recorder ends drift as reported (~13 ms)`, ends <= 0.0135 + exactTol, `${(ends * 1000).toFixed(2)} ms`);
    } else {
      check(`${tag}: recorder cut into pieces`, rec.length > 1, `${rec.length} piece(s)`);
      let worst = 0;
      for (const p of rec) for (const t of [p.inPt + 0.01, 0.5 * (p.inPt + p.outPt), p.outPt - 0.01]) worst = Math.max(worst, errAt(p, t));
      check(`${tag}: recorder sync ≤ 2.5 ms everywhere`, worst <= 0.0025 + exactTol, `worst ${(worst * 1000).toFixed(3)} ms`);
    }
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
