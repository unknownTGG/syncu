// Panel controller: Scan -> Analyze -> Review -> Build.
window.Syncu = window.Syncu || {};

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { clips: [], result: null, manualEdges: [] };

  Syncu.log = (msg) => {
    const el = $("log");
    el.textContent += msg + "\n";
    el.scrollTop = el.scrollHeight;
    console.log("[syncu]", msg);
  };
  Syncu.pp.setLogger(Syncu.log);

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  function setProgress(frac, text) {
    $("progress").classList.toggle("hidden", frac === null);
    if (frac === null) return;
    $("progressBar").style.width = `${Math.round(frac * 100)}%`;
    $("progressText").textContent = text || "";
  }

  async function guard(btn, fn) {
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      Syncu.log(`error: ${e.message || e}`);
      $("summary").innerHTML = `<div class="row err">${esc(e.message || e)}</div>`;
    } finally {
      btn.disabled = false;
      setProgress(null);
    }
  }

  async function checkEngine() {
    const h = await Syncu.engine.health();
    const pill = $("engineStatus");
    if (h && h.ok) {
      pill.textContent = `engine ${h.version}`;
      pill.className = "pill ok";
      pill.title = `ffmpeg: ${h.ffmpeg}`;
    } else {
      pill.textContent = "helper not running";
      pill.className = "pill bad";
      pill.title = "Start 'Syncu Helper' (see README)";
    }
    return !!(h && h.ok);
  }

  // ---- 1. Scan ----
  async function scan() {
    const mode = document.querySelector('input[name="source"]:checked').value;
    const raw = mode === "timeline" ? await Syncu.pp.timelineClips() : await Syncu.pp.selectedClips();
    if (!raw.length) throw new Error(mode === "timeline" ? "Active sequence has no clips" : "Select bins or clips in the Project panel first");
    raw.forEach((c, i) => (c.id = `c${i}`));
    state.clips = Syncu.devices.classify(raw, mode);
    state.result = null;
    state.manualEdges = [];
    renderDevices();
    $("analyzeBtn").disabled = false;
    $("buildBtn").disabled = true;
    $("reviewSection").classList.add("hidden");
    $("summary").innerHTML = "";
  }

  function renderDevices() {
    const devs = Syncu.devices.summarize(state.clips);
    $("deviceList").innerHTML = devs
      .map((d, i) => {
        const kind = d.video ? `${d.video} video` : `${d.audio} audio`;
        const grp = d.groups.size ? ` · ${d.groups.size} multi-file takes` : "";
        return `<div class="row"><input data-dev="${i}" value="${esc(d.name)}" title="Rename to merge devices" /><div class="meta">${kind}${d.video && d.audio ? ` + ${d.audio} audio` : ""}${grp}</div></div>`;
      })
      .join("");
    $("deviceList").querySelectorAll("input[data-dev]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const old = devs[Number(inp.dataset.dev)].name;
        for (const c of state.clips) if (c.device === old) c.device = inp.value.trim() || old;
        renderDevices();
      });
    });
  }

  // ---- 2/3. Analyze ----
  async function analyze() {
    if (!(await checkEngine())) throw new Error("Syncu Helper isn't running. Start it, then try again.");
    const request = {
      clips: state.clips.map((c) => ({
        id: c.id, path: c.path, device: c.device, group: c.group || "",
        isVideo: !!c.isVideo, hasAudio: true,
      })),
      options: {
        autoConfidence: Number($("autoConf").value) || 0.5,
        driftTolerance: (Number($("driftTol").value) || 2) / 1000,
        coarseRate: Number($("coarseRate").value) || 2000,
      },
      manualEdges: state.manualEdges,
    };
    setProgress(0, "Starting");
    const t0 = Date.now();
    state.result = await Syncu.engine.analyze(request, (f, m) => setProgress(f, m));
    Syncu.log(`analysis took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    renderSummary();
    renderReview();
    $("buildBtn").disabled = !state.result.clips.some((c) => c.method !== "none");
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
      const why = c.method === "timestamp" ? "placed by file time only — check it" : "no audio match — not placed";
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
    });
    return edges;
  }

  // ---- 5. Build ----
  async function build() {
    const makePlan = (frameTicks) =>
      Syncu.build.planBuild(state.clips, state.result, {
        mode: $("outputMode").value,
        frameTicks,
        muteScratch: $("muteScratch").checked,
      });
    // 23.976 until the first sequence tells us its real frame duration.
    const plan = makePlan(10594584000);
    for (const w of plan.warnings) Syncu.log(`note: ${w}`);
    Syncu.log(`building ${plan.sequences.length} sequence(s)`);
    setProgress(0, "Building");
    await Syncu.build.executePlan(plan, state.clips, (f, m) => setProgress(f, m), makePlan);
    Syncu.log("build finished");
    $("summary").insertAdjacentHTML("beforeend", `<div class="row ok"><div class="title">Built ${plan.sequences.length} sequence(s) in a new Syncu bin</div></div>`);
  }

  // ---- Wiring ----
  $("scanBtn").addEventListener("click", () => guard($("scanBtn"), scan));
  $("analyzeBtn").addEventListener("click", () => guard($("analyzeBtn"), analyze));
  $("reanalyzeBtn").addEventListener("click", () =>
    guard($("reanalyzeBtn"), async () => {
      state.manualEdges = collectManualEdges();
      await analyze();
    })
  );
  $("buildBtn").addEventListener("click", () => guard($("buildBtn"), build));
  $("selfTestBtn").addEventListener("click", () =>
    guard($("selfTestBtn"), async () => {
      Syncu.log("— self-test (select ≥1 video and ≥1 audio-only clip in the Project panel) —");
      await Syncu.pp.runSelfTest();
    })
  );
  $("copyLogBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("log").textContent);
    } catch (e) {
      require("uxp").clipboard?.copyText?.($("log").textContent);
    }
  });

  checkEngine();
  setInterval(checkEngine, 10000);
})();
