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

  // ---- Layout helpers ----
  // UXP doesn't scroll the page body; #scroll scrolls, and its height is also
  // set explicitly in case flex sizing doesn't take in a given UXP version.
  function fitScroll() {
    const h = (window.innerHeight || document.documentElement.clientHeight) - $("footer").offsetHeight;
    if (h > 80) $("scroll").style.height = `${h}px`;
  }

  function loadPref(key, def) {
    try {
      const v = localStorage.getItem(`syncu.${key}`);
      return v === null ? def : v;
    } catch (e) {
      return def;
    }
  }
  function savePref(key, v) {
    try {
      localStorage.setItem(`syncu.${key}`, v);
    } catch (e) {
      /* prefs are a convenience */
    }
  }

  // Collapsible sections (UXP has no <details>).
  function setCollapsed(id, collapsed) {
    const el = $(id);
    el.classList.toggle("collapsed", collapsed);
    const chev = el.querySelector(".chev");
    if (chev) chev.textContent = collapsed ? "▸" : "▾";
    savePref(`collapsed.${id}`, collapsed ? "1" : "0");
  }
  function expand(id) {
    $(id).classList.remove("hidden");
    setCollapsed(id, false);
  }

  // Highlight the selected option row / segment and refresh section subtitles.
  function refreshChoices() {
    document.querySelectorAll("label.option, label.seg").forEach((l) => {
      const inp = l.querySelector("input");
      l.classList.toggle("selected", !!(inp && inp.checked));
    });
    const outTitle = document.querySelector('input[name="output"]:checked');
    const t = outTitle && outTitle.parentElement.querySelector(".opt-title");
    $("outputSub").textContent = t ? t.textContent : "";
  }

  function markStep(id, done) {
    const st = $(id).querySelector(".step");
    if (st) st.classList.toggle("done", done);
  }

  function radio(name, fallback) {
    const el = document.querySelector(`input[name="${name}"]:checked`);
    return (el && el.value) || fallback;
  }

  // Read a number field; out-of-range or garbage resets to the default (and
  // says so), so a stray value can never reach the engine.
  const warned = new Set();
  function numberField(id, def, min, max) {
    const raw = String($(id).value ?? "").trim().replace(",", ".");
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v >= min && v <= max) return v;
    if (!warned.has(id + raw)) {
      warned.add(id + raw);
      Syncu.log("warn", `setting ${id}: "${raw}" is not between ${min} and ${max}; using ${def}`);
    }
    $(id).value = String(def);
    return def;
  }

  function settings() {
    return {
      source: radio("source", "bins"),
      output: radio("output", "timeline"),
      muteScratch: !!$("muteScratch").checked,
      driftCuts: !!$("driftCuts").checked,
      trimTakes: !!$("trimTakes").checked,
      driftTolMs: numberField("driftTol", 2, 0.25, 50),
      autoConf: numberField("autoConf", 0.5, 0.05, 0.99),
      coarseRate: Number(radio("accuracy", "2000")) || 2000,
    };
  }

  function setProgress(frac, text) {
    const wasHidden = $("progress").classList.contains("hidden");
    $("progress").classList.toggle("hidden", frac === null);
    if (wasHidden !== (frac === null)) fitScroll();
    if (frac === null) return;
    $("progressBar").style.width = `${Math.round(frac * 100)}%`;
    $("progressText").textContent = text || "";
  }

  function showError(e) {
    const msg = (e && e.message) || String(e);
    expand("secResults");
    $("summary").insertAdjacentHTML("beforeend",
      `<div class="row err"><div class="title">${esc(msg)}</div><div class="meta">Open Help &amp; diagnostics → Copy report, and send it over.</div></div>`);
    $("scroll").scrollTop = $("secResults").offsetTop;
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
    // Build works even if nothing synced: unsynced clips still go on the timeline.
    $("buildBtn").disabled = !(state.result && state.result.clips.some((c) => c.method !== "none" || c.duration > 0));
  }

  let lastHealth = null;
  async function checkEngine() {
    const h = await Syncu.engine.health();
    const pill = $("engineStatus");
    const label = pill.querySelector(".label");
    if (h && h.ok && h.ffmpegVersion === "") {
      label.textContent = "ffmpeg missing";
      pill.className = "status bad";
      pill.title = `Helper can't run ffmpeg at "${h.ffmpeg}". Mac: brew install ffmpeg, then restart the helper.`;
    } else if (h && h.ok) {
      label.textContent = "Ready";
      pill.className = "status ok";
      pill.title = `Helper ${h.version} · ${h.ffmpegVersion} (${h.ffmpeg})`;
    } else {
      label.textContent = "helper not running";
      pill.className = "status bad";
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
    $("secResults").classList.add("hidden");
    markStep("secSource", true);
    markStep("secResults", false);
  }

  function renderDevices() {
    const devs = Syncu.devices.summarize(state.clips);
    $("deviceList").innerHTML = devs
      .map((d, i) => {
        const isVideo = d.video > 0;
        const count = [d.video ? `${d.video} video` : "", d.audio ? `${d.audio} audio` : ""].filter(Boolean).join(" + ");
        const grp = d.groups.size ? ` · ${d.groups.size} multi-file` : "";
        return `<div class="device"><span class="kind ${isVideo ? "video" : "audio"}">${isVideo ? "CAM" : "REC"}</span>` +
          `<input data-dev="${i}" value="${esc(d.name)}" title="Rename to merge or split devices" />` +
          `<span class="count">${count}${grp}</span></div>`;
      })
      .join("");
    $("deviceHint").classList.toggle("hidden", devs.length === 0);
    $("sourceSub").textContent = devs.length ? `${devs.length} device${devs.length === 1 ? "" : "s"} · ${state.clips.length} clips` : "Choose clips to sync";
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
    Syncu.log(`settings: ${JSON.stringify(st)}`);
    const request = {
      clips: state.clips.map((c) => ({
        id: c.id, path: c.path, altPath: c.proxyPath || "", device: c.device, group: c.group || "",
        isVideo: !!c.isVideo, hasAudio: true, duration: c.duration > 0 ? c.duration : -1,
      })),
      options: {
        autoConfidence: st.autoConf,
        // Without drift cuts every file stays one full-length clip, aligned
        // at its middle (a huge tolerance means "never cut").
        driftTolerance: st.driftCuts ? st.driftTolMs / 1000 : 1e6,
        coarseRate: st.coarseRate,
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
    expand("secResults");
    markStep("secResults", true);
    markStep("secOutput", true);
    // Fold the setup sections (their headers keep a summary) so results show.
    setCollapsed("secSource", true);
    setCollapsed("secOutput", true);
    fitScroll();
    $("scroll").scrollTop = 0;
    $("resultsSub").textContent = `${n("audio") + n("manual")} synced${n("none") ? ` · ${n("none")} not placed` : ""}`;
  }

  function clipName(id) {
    const c = state.clips.find((x) => x.id === id);
    return c ? c.name : id;
  }

  function renderSummary() {
    const r = state.result;
    const n = (m) => r.clips.filter((c) => c.method === m).length;
    const drift = r.clips.filter((c) => c.segments.length > 1);
    const stat = (num, label, cls) => `<div class="stat ${num ? cls : ""}"><div class="num-big">${num}</div><div class="lbl">${label}</div></div>`;
    let html = `<div class="stats">${stat(n("audio") + n("manual"), "Synced by audio", "good")}${stat(n("timestamp"), "By file time", "warnc")}${stat(n("none"), "Not synced", "badc")}</div>`;
    // Media problems first: they explain everything else.
    const missing = r.clips.filter((c) => c.source === "missing");
    const proxied = r.clips.filter((c) => c.source === "proxy").length;
    if (missing.length) {
      const ex = state.clips.find((c) => c.id === missing[0].id);
      const vol = ex && (String(ex.path).match(/^\/Volumes\/[^/]+/) || [""])[0];
      html += `<div class="row err media"><div class="title">${missing.length} file(s) can't be read</div>
        <div class="meta">${vol ? `They're on ${esc(vol)}, which isn't connected. ` : "The files were moved or are offline. "}Connect the drive, or create/attach proxies in Premiere, then Analyze again.</div></div>`;
    }
    if (proxied) html += `<div class="row ok"><div class="meta">${proxied} clip(s) analysed from their proxies (originals offline).</div></div>`;
    const scenes = `${r.components} scene${r.components === 1 ? "" : "s"}`;
    html += `<div class="row ok"><div class="title">Ready to build</div>
      <div class="meta">${scenes}${drift.length ? ` · drift corrected on ${drift.length} clip(s)` : ""} · recorder audio placed full length${n("none") ? ` · ${n("none")} not-synced clip(s) go in a marked area at the end` : ""}</div></div>`;
    for (const c of drift)
      html += `<div class="row"><div class="meta">${esc(clipName(c.id))}: ${c.driftPpm.toFixed(1)} ppm → ${c.segments.length} pieces</div></div>`;
    // Full-length clips are aligned at their middle; say how far the ends drift.
    for (const c of r.clips) {
      if (c.segments.length !== 1) continue;
      const s = c.segments[0];
      const endErrMs = Math.abs(c.driftPpm) * 1e-6 * (s.end - s.start) * 0.5 * 1000;
      if (endErrMs < 2) continue;
      const msg = `${esc(clipName(c.id))}: clock drifts ${c.driftPpm.toFixed(1)} ppm — in sync at its middle, up to ${endErrMs.toFixed(0)} ms off at its ends. Turn on "Cut long recordings to fix clock drift" (Advanced) if that matters.`;
      html += `<div class="row warn"><div class="meta">${msg}</div></div>`;
      Syncu.log("warn", msg.replace(/<[^>]+>/g, ""));
    }
    $("summary").innerHTML = html;
  }

  // ---- 4. Review ----
  function renderReview() {
    const r = state.result;
    const rows = [];
    for (const [i, e] of r.edges.entries()) {
      if (e.status !== "review") continue;
      // Radio buttons, not a <select>: selects don't read reliably in Premiere's UXP.
      const opts = e.match.candidates
        .map((c, k) => `<label><input type="radio" class="cand" name="cand-${i}" value="${c.offset}" ${k === 0 ? "checked" : ""} /> ${c.offset.toFixed(3)} s · score ${c.score.toFixed(1)}${k === 0 ? " (best)" : ""}</label>`)
        .join("");
      rows.push(`<div class="row warn" data-edge="${i}">
        <div class="title">${esc(clipName(e.b))} ↔ ${esc(clipName(e.a))}</div>
        <div class="meta">Confidence ${(e.match.confidence * 100).toFixed(0)}% — pick the right offset:</div>
        ${opts}
        <label>Nudge <input class="nudge num" type="text" value="0" /> ms</label>
        <label class="check"><input type="checkbox" class="use" /> Use this match</label></div>`);
    }
    for (const c of r.clips) {
      if (!c.needsReview) continue;
      const why = c.method === "timestamp" ? "placed by file time only — check it (marked on the timeline)"
        : c.source === "missing" ? "file not found (drive offline?) and no proxy — goes in the “Not synced” area"
        : "no audio match — goes in the “Not synced” area to place by hand";
      rows.push(`<div class="row ${c.method === "none" ? "err" : "warn"}"><div class="title">${esc(clipName(c.id))}</div><div class="meta">${why}</div></div>`);
    }
    $("reviewSection").classList.toggle("hidden", rows.length === 0);
    $("reviewList").innerHTML = rows.join("");
    // Only offer re-analysis when there are matches to choose between.
    $("reanalyzeBtn").parentElement.classList.toggle("hidden", !r.edges.some((e) => e.status === "review"));
  }

  function collectManualEdges() {
    const edges = [...state.manualEdges];
    $("reviewList").querySelectorAll("[data-edge]").forEach((row) => {
      if (!row.querySelector(".use").checked) return;
      const e = state.result.edges[Number(row.dataset.edge)];
      const pick = row.querySelector("input.cand:checked") || row.querySelector("input.cand");
      const nudge = parseFloat(String(row.querySelector(".nudge").value).replace(",", ".")) || 0;
      const off = Number(pick.value) + nudge / 1000;
      edges.push({ a: e.a, b: e.b, offset: off });
      Syncu.log(`manual fix: ${e.a} <- ${e.b} offset ${off.toFixed(6)}`);
    });
    return edges;
  }

  // ---- 5. Build ----
  async function build() {
    const st = settings();
    Syncu.log(`settings: ${JSON.stringify(st)}`);
    const makePlan = (frameTicks) => {
      const plan = Syncu.build.planBuild(state.clips, state.result, {
        mode: st.output, frameTicks, muteScratch: st.muteScratch, trimTakes: st.trimTakes,
      });
      ctx.lastPlan = plan;
      return plan;
    };
    // 23.976 until the first sequence tells us its real frame duration.
    const plan = makePlan(10594584000);
    for (const w of plan.warnings) Syncu.log("warn", w);
    Syncu.log(`plan: ${plan.sequences.length} sequence(s), ${plan.sequences.reduce((n, s) => n + s.placements.length, 0)} placement(s), ${plan.unplaced.length} unplaced`);
    setProgress(0, "Building");
    await Syncu.build.executePlan(plan, state.clips, (f, m) => setProgress(f, m), makePlan);
    $("summary").insertAdjacentHTML("beforeend", `<div class="row ok"><div class="title">✓ Built ${ctx.lastPlan.sequences.length} sequence(s)</div><div class="meta">Look for the new “Syncu …” bin in the Project panel.</div></div>`);
    $("resultsSub").textContent = "Built";
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
    $("reportStatus").textContent = copied ? `✓ Report copied (${Math.round(text.length / 1024)} KB) — paste it to Claude.` : "Couldn't copy — use Save….";
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

  document.querySelectorAll("[data-toggle]").forEach((head) => {
    const id = head.dataset.toggle;
    head.addEventListener("click", () => {
      setCollapsed(id, !$(id).classList.contains("collapsed"));
      fitScroll();
    });
    const saved = loadPref(`collapsed.${id}`, null);
    if (saved !== null) setCollapsed(id, saved === "1");
    else if ($(id).classList.contains("collapsed") || id === "secAdvanced") setCollapsed(id, true);
  });
  document.querySelectorAll('input[type="radio"]').forEach((r) => r.addEventListener("change", refreshChoices));
  document.querySelectorAll("label.option, label.seg").forEach((l) =>
    l.addEventListener("click", () => setTimeout(refreshChoices, 0))
  );
  // Drift tolerance only matters when cutting.
  const syncDriftField = () => {
    $("driftTol").disabled = !$("driftCuts").checked;
    $("driftTol").parentElement.classList.toggle("disabled", !$("driftCuts").checked);
  };
  $("driftCuts").addEventListener("change", syncDriftField);
  syncDriftField();
  refreshChoices();
  $("versionLabel").textContent = `v${Syncu.VERSION}`;
  window.addEventListener("resize", fitScroll);
  fitScroll();
  setTimeout(fitScroll, 200);

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
