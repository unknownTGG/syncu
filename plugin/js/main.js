// Panel controller: Scan -> Analyze -> Review -> Build.
window.Syncu = window.Syncu || {};

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { clips: [], result: null, manualEdges: [] };
  const ctx = { state, selfTest: [], lastPlan: null };

  // Mirror log lines into the Diagnostics box.
  Syncu.log.onLine((line) => {
    const el = $("log");
    el.textContent += line + "\n";
    if (el.textContent.length > 200000) el.textContent = el.textContent.slice(-150000);
    el.scrollTop = el.scrollHeight;
  });

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  function settings() {
    return {
      source: document.querySelector('input[name="source"]:checked').value,
      output: $("outputMode").value,
      muteScratch: $("muteScratch").checked,
      driftTolMs: Number($("driftTol").value),
      autoConf: Number($("autoConf").value),
      coarseRate: Number($("coarseRate").value),
    };
  }

  function setProgress(frac, text) {
    $("progress").classList.toggle("hidden", frac === null);
    if (frac === null) return;
    $("progressBar").style.width = `${Math.round(frac * 100)}%`;
    $("progressText").textContent = text || "";
  }

  function showError(e) {
    const msg = (e && e.message) || String(e);
    $("summary").insertAdjacentHTML("beforeend",
      `<div class="row err"><div class="title">${esc(msg)}</div><div class="meta">Diagnostics → Copy report, and send it over.</div></div>`);
  }

  // Run a step: disable its button, log start/end/timing, surface errors.
  async function guard(btn, name, fn) {
    btn.disabled = true;
    const t0 = Date.now();
    Syncu.log(`▶ ${name}`);
    try {
      await fn();
      Syncu.log(`✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) {
      Syncu.log("error", `✖ ${name} failed: ${Syncu.log.errText(e)}`);
      showError(e);
    } finally {
      btn.disabled = false;
      setProgress(null);
      updateButtons();
    }
  }

  function updateButtons() {
    $("analyzeBtn").disabled = state.clips.length === 0;
    $("buildBtn").disabled = !(state.result && state.result.clips.some((c) => c.method !== "none"));
  }

  let lastHealth = null;
  async function checkEngine() {
    const h = await Syncu.engine.health();
    const pill = $("engineStatus");
    if (h && h.ok && h.ffmpegVersion === "") {
      pill.textContent = "ffmpeg missing";
      pill.className = "pill bad";
      pill.title = `Helper can't run ffmpeg at "${h.ffmpeg}". Mac: brew install ffmpeg, then restart the helper.`;
    } else if (h && h.ok) {
      pill.textContent = `engine ${h.version}`;
      pill.className = "pill ok";
      pill.title = `${h.ffmpegVersion} (${h.ffmpeg})`;
    } else {
      pill.textContent = "helper not running";
      pill.className = "pill bad";
      pill.title = "Run install-mac.command / install-windows.ps1 (see README)";
    }
    const status = h ? `${h.version} ffmpeg=${h.ffmpegVersion ? "ok" : "MISSING"}` : `down (${Syncu.engine.lastError})`;
    if (status !== lastHealth) Syncu.log(h ? "info" : "warn", `helper: ${status}${h ? ` (${h.os}, ${h.ffmpeg})` : ""}`);
    lastHealth = status;
    return !!(h && h.ok && h.ffmpegVersion !== "");
  }

  // ---- 1. Scan ----
  async function scan() {
    const mode = settings().source;
    const raw = mode === "timeline" ? await Syncu.pp.timelineClips() : await Syncu.pp.selectedClips();
    if (!raw.length) throw new Error(mode === "timeline" ? "The active sequence has no media clips" : "Select bins or clips in the Project panel first");
    raw.forEach((c, i) => (c.id = `c${i}`));
    state.clips = Syncu.devices.classify(raw, mode);
    state.result = null;
    state.manualEdges = [];
    for (const d of Syncu.devices.summarize(state.clips))
      Syncu.log(`device "${d.name}": ${d.video} video, ${d.audio} audio${d.groups.size ? `, ${d.groups.size} multi-file takes` : ""}`);
    if (Syncu.devices.summarize(state.clips).length < 2)
      Syncu.log("warn", "only one device found — clips on the same device are never matched with each other. Use one bin per camera/recorder, or rename devices in the list.");
    renderDevices();
    $("reviewSection").classList.add("hidden");
    $("summary").innerHTML = "";
  }

  function renderDevices() {
    const devs = Syncu.devices.summarize(state.clips);
    $("deviceList").innerHTML = devs
      .map((d, i) => {
        const kind = [d.video ? `${d.video} video` : "", d.audio ? `${d.audio} audio` : ""].filter(Boolean).join(" + ");
        const grp = d.groups.size ? ` · ${d.groups.size} multi-file takes` : "";
        return `<div class="row"><input data-dev="${i}" value="${esc(d.name)}" title="Rename to merge or split devices" /><div class="meta">${kind}${grp}</div></div>`;
      })
      .join("");
    $("deviceList").querySelectorAll("input[data-dev]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const old = devs[Number(inp.dataset.dev)].name;
        const name = inp.value.trim() || old;
        for (const c of state.clips) if (c.device === old) c.device = name;
        Syncu.log(`device renamed: "${old}" -> "${name}"`);
        renderDevices();
      });
    });
  }

  // ---- 2/3. Analyze ----
  async function analyze() {
    if (!(await checkEngine())) throw new Error("The Syncu helper isn't ready (see the red pill at the top).");
    const st = settings();
    const request = {
      clips: state.clips.map((c) => ({
        id: c.id, path: c.path, device: c.device, group: c.group || "",
        isVideo: !!c.isVideo, hasAudio: true,
      })),
      options: {
        autoConfidence: st.autoConf || 0.5,
        driftTolerance: (st.driftTolMs || 2) / 1000,
        coarseRate: st.coarseRate || 2000,
      },
      manualEdges: state.manualEdges,
    };
    setProgress(0, "Starting");
    state.result = await Syncu.engine.analyze(request, (f, m) => setProgress(f, m));
    const r = state.result;
    const n = (m) => r.clips.filter((c) => c.method === m).length;
    Syncu.log(`result: ${r.components} scene(s), ${n("audio") + n("manual")} by audio, ${n("timestamp")} by timestamp, ${n("none")} unplaced, ${r.edges.filter((e) => e.status === "review").length} match(es) to review`);
    renderSummary();
    renderReview();
  }

  function clipName(id) {
    const c = state.clips.find((x) => x.id === id);
    return c ? c.name : id;
  }

  function renderSummary() {
    const r = state.result;
    const n = (m) => r.clips.filter((c) => c.method === m).length;
    const drift = r.clips.filter((c) => c.segments.length > 1);
    let html = `<div class="row ok"><div class="title">${n("audio") + n("manual")} synced by audio · ${n("timestamp")} by timestamp · ${n("none")} not placed</div>
      <div class="meta">${r.components} scene(s)${drift.length ? ` · drift corrected on ${drift.length} clip(s)` : ""}</div></div>`;
    for (const c of drift)
      html += `<div class="row"><div class="meta">${esc(clipName(c.id))}: ${c.driftPpm.toFixed(1)} ppm → ${c.segments.length} pieces</div></div>`;
    $("summary").innerHTML = html;
  }

  // ---- 4. Review ----
  function renderReview() {
    const r = state.result;
    const rows = [];
    for (const [i, e] of r.edges.entries()) {
      if (e.status !== "review") continue;
      const opts = e.match.candidates
        .map((c, k) => `<option value="${c.offset}" ${k === 0 ? "selected" : ""}>${c.offset.toFixed(3)} s (score ${c.score.toFixed(1)})</option>`)
        .join("");
      rows.push(`<div class="row warn" data-edge="${i}">
        <div class="title">${esc(clipName(e.b))} ↔ ${esc(clipName(e.a))}</div>
        <div class="meta">confidence ${(e.match.confidence * 100).toFixed(0)}% — pick the right match:</div>
        <select class="cand">${opts}</select>
        <label>Nudge (ms) <input class="nudge" type="number" value="0" step="1" /></label>
        <label class="check"><input type="checkbox" class="use" /> Use this match</label></div>`);
    }
    for (const c of r.clips) {
      if (!c.needsReview) continue;
      const why = c.method === "timestamp" ? "placed by file time only — check it (marked on the timeline)" : "no audio match — not placed";
      rows.push(`<div class="row ${c.method === "none" ? "err" : "warn"}"><div class="title">${esc(clipName(c.id))}</div><div class="meta">${why}</div></div>`);
    }
    $("reviewSection").classList.toggle("hidden", rows.length === 0);
    $("reviewList").innerHTML = rows.join("");
  }

  function collectManualEdges() {
    const edges = [...state.manualEdges];
    $("reviewList").querySelectorAll("[data-edge]").forEach((row) => {
      if (!row.querySelector(".use").checked) return;
      const e = state.result.edges[Number(row.dataset.edge)];
      const off = Number(row.querySelector(".cand").value) + Number(row.querySelector(".nudge").value || 0) / 1000;
      edges.push({ a: e.a, b: e.b, offset: off });
      Syncu.log(`manual fix: ${e.a} <- ${e.b} offset ${off.toFixed(6)}`);
    });
    return edges;
  }

  // ---- 5. Build ----
  async function build() {
    const st = settings();
    const makePlan = (frameTicks) => {
      const plan = Syncu.build.planBuild(state.clips, state.result, { mode: st.output, frameTicks, muteScratch: st.muteScratch });
      ctx.lastPlan = plan;
      return plan;
    };
    // 23.976 until the first sequence tells us its real frame duration.
    const plan = makePlan(10594584000);
    for (const w of plan.warnings) Syncu.log("warn", w);
    Syncu.log(`plan: ${plan.sequences.length} sequence(s), ${plan.sequences.reduce((n, s) => n + s.placements.length, 0)} placement(s), ${plan.unplaced.length} unplaced`);
    setProgress(0, "Building");
    await Syncu.build.executePlan(plan, state.clips, (f, m) => setProgress(f, m), makePlan);
    $("summary").insertAdjacentHTML("beforeend", `<div class="row ok"><div class="title">Built ${ctx.lastPlan.sequences.length} sequence(s) in a new Syncu bin</div></div>`);
  }

  // ---- Report ----
  async function reportText() {
    return Syncu.buildReport({ ...ctx, settings: settings() });
  }

  async function copyReport() {
    const text = await reportText();
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (e) {
      try {
        await navigator.clipboard.setContent({ "text/plain": text });
        copied = true;
      } catch (e2) {
        Syncu.log("warn", `clipboard unavailable: ${Syncu.log.errText(e2)}`);
      }
    }
    $("reportStatus").textContent = copied ? `Report copied (${Math.round(text.length / 1024)} KB) — paste it to Claude.` : "Couldn't copy — use Save report.";
  }

  async function saveReport() {
    const text = await reportText();
    const lfs = require("uxp").storage.localFileSystem;
    const file = await lfs.getFileForSaving(`syncu-report-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`, { types: ["txt"] });
    if (!file) return;
    await file.write(text);
    $("reportStatus").textContent = `Saved ${file.name}`;
    Syncu.log(`report saved: ${file.nativePath || file.name}`);
  }

  // ---- Wiring ----
  $("scanBtn").addEventListener("click", () => guard($("scanBtn"), "scan", scan));
  $("analyzeBtn").addEventListener("click", () => guard($("analyzeBtn"), "analyze", analyze));
  $("reanalyzeBtn").addEventListener("click", () =>
    guard($("reanalyzeBtn"), "re-analyze", async () => {
      state.manualEdges = collectManualEdges();
      await analyze();
    })
  );
  $("buildBtn").addEventListener("click", () => guard($("buildBtn"), "build", build));
  $("selfTestBtn").addEventListener("click", () =>
    guard($("selfTestBtn"), "self-test", async () => {
      ctx.selfTest = await Syncu.pp.runSelfTest();
    })
  );
  $("copyReportBtn").addEventListener("click", () => guard($("copyReportBtn"), "copy report", copyReport));
  $("saveReportBtn").addEventListener("click", () => guard($("saveReportBtn"), "save report", saveReport));

  try {
    const host = require("uxp").host;
    Syncu.log(`Syncu panel ${Syncu.VERSION} on ${host.name} ${host.version}`);
  } catch (e) {
    Syncu.log(`Syncu panel ${Syncu.VERSION}`);
  }
  updateButtons();
  checkEngine();
  setInterval(checkEngine, 10000);
})();
