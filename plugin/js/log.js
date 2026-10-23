// Logging + bug reports. Everything noteworthy goes through Syncu.log so a
// single "Copy report" gives the full picture (panel + helper).
window.Syncu = window.Syncu || {};

Syncu.VERSION = "0.1.13";

(() => {
  const lines = [];
  const MAX = 3000;
  let listener = null;
  let flushTimer = null;

  function stamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  function errText(e) {
    if (!e) return String(e);
    if (e instanceof Error || e.stack) return `${e.message || e}${e.stack ? "\n    " + String(e.stack).split("\n").slice(0, 6).join("\n    ") : ""}`;
    if (typeof e === "object") {
      try {
        return JSON.stringify(e);
      } catch (x) {
        return String(e);
      }
    }
    return String(e);
  }

  // Syncu.log("message") or Syncu.log("warn", "message") / ("error", err)
  Syncu.log = (levelOrMsg, maybeMsg) => {
    let level = "info";
    let msg = levelOrMsg;
    if (maybeMsg !== undefined && ["info", "warn", "error", "debug"].includes(levelOrMsg)) {
      level = levelOrMsg;
      msg = maybeMsg;
    }
    const text = typeof msg === "string" ? msg : errText(msg);
    const line = `${stamp()} [${level}] ${text}`;
    lines.push(line);
    if (lines.length > MAX) lines.splice(0, lines.length - MAX);
    (level === "error" ? console.error : console.log)("[syncu]", line);
    if (listener) listener(line, level);
    scheduleFlush(line);
  };
  Syncu.log.errText = errText;
  Syncu.log.lines = () => lines.slice();
  Syncu.log.onLine = (fn) => (listener = fn);

  // Every line also goes to the helper, which keeps it on disk: if Premiere
  // crashes mid-build, the next report still shows where it got to.
  const HELPER = "http://127.0.0.1:47800/panel-log";
  let pending = [];
  let previous = [];
  // Fetch what the helper kept from earlier sessions before adding to it.
  const ready = (async () => {
    try {
      const res = await fetch(HELPER, { headers: { "X-Syncu": "1" } });
      previous = (await res.json()).lines || [];
    } catch (e) {
      previous = [];
    }
  })();

  async function send() {
    if (flushTimer) clearTimeout(flushTimer), (flushTimer = null);
    await ready;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    try {
      await fetch(HELPER, {
        method: "POST",
        headers: { "X-Syncu": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ lines: batch }),
      });
    } catch (e) {
      // Helper down: keep a bounded backlog for when it's back.
      pending = batch.concat(pending).slice(-500);
    }
  }
  function scheduleFlush(line) {
    pending.push(line);
    if (!flushTimer) flushTimer = setTimeout(send, 250);
  }
  // Awaited before risky Premiere calls, so the log is saved if one crashes.
  Syncu.log.flush = () => send().catch(() => {});
  // Lines saved by the helper from before this panel session started.
  Syncu.log.previous = async () => {
    await ready;
    return previous.slice();
  };
  setTimeout(() => Syncu.log(`--- panel session ${Syncu.VERSION} started ---`), 0);

  window.addEventListener("error", (ev) => Syncu.log("error", `uncaught: ${ev.message} at ${ev.filename}:${ev.lineno}`));
  window.addEventListener("unhandledrejection", (ev) => Syncu.log("error", `unhandled promise: ${errText(ev.reason)}`));

  // ---- Report ----
  // ctx: { state, settings, selfTest, lastPlan, lastBuildError }
  Syncu.buildReport = async (ctx) => {
    const out = [];
    const sec = (t) => out.push("", `===== ${t} =====`);
    out.push(`Syncu report — ${new Date().toISOString()}`);
    out.push(`panel ${Syncu.VERSION}`);
    try {
      const host = require("uxp").host;
      out.push(`host: ${host.name || "?"} ${host.version || "?"} (uiLocale ${host.uiLocale || "?"})`);
    } catch (e) {
      out.push(`host: unknown (${e.message})`);
    }
    try {
      const os = require("os");
      out.push(`os: ${os.platform()} ${os.release ? os.release() : ""} ${os.arch ? os.arch() : ""}`);
    } catch (e) {
      out.push("os: unknown");
    }

    sec("helper");
    const health = await Syncu.engine.health();
    out.push(health ? JSON.stringify(health) : `NOT REACHABLE on 127.0.0.1:47800 (${Syncu.engine.lastError})`);

    sec("settings");
    out.push(JSON.stringify(ctx.settings));

    const st = ctx.state || {};
    sec(`scan (${(st.clips || []).length} clips)`);
    const home = /^(\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/;
    for (const c of st.clips || [])
      out.push(`${c.id}\t${c.device}\t${c.group || "-"}\t${c.isVideo ? "video" : "audio"}\t${String(c.path).replace(home, "~")}`);

    if (st.result) {
      const r = st.result;
      sec(`analysis (${r.components} scenes)`);
      for (const c of r.clips)
        out.push(`${c.id}\t${c.method}\tscene ${c.component}\tpos ${c.position.toFixed(6)}\tdrift ${c.driftPpm.toFixed(2)}ppm\tconf ${c.confidence.toFixed(2)}\tsegs ${c.segments.length}${c.needsReview ? "\tREVIEW" : ""}`);
      out.push("-- accepted / rejected-as-inconsistent matches --");
      for (const e of r.edges.filter((e) => e.status === "used" || e.status === "manual" || e.status === "outlier"))
        out.push(`${e.status}\t${e.a}<-${e.b}\toffset ${e.match.offset.toFixed(6)}\tconf ${e.match.confidence.toFixed(2)}\tratio ${e.match.peakRatio.toFixed(2)}\tcorr ${e.match.correlation.toFixed(2)}\tagree ${(e.match.agreement || 0).toFixed(2)}\tresid ${(e.residual * 1000).toFixed(3)}ms`);
      out.push(`review-level pairs: ${r.edges.filter((e) => e.status === "review").length}, rejected pairs: ${r.edges.filter((e) => e.status === "rejected").length}`);
      // Near misses explain why a clip didn't sync; keep the strongest few.
      const near = r.edges.filter((e) => (e.status === "review" || e.status === "rejected") &&
                                         (e.match.agreement > 0 || e.match.confidence >= 0.15))
        .sort((x, y) => y.match.confidence - x.match.confidence).slice(0, 200);
      if (near.length) out.push("-- strongest unused matches (up to 200) --");
      for (const e of near)
        out.push(`${e.status}\t${e.a}<-${e.b}\toffset ${e.match.offset.toFixed(6)}\tconf ${e.match.confidence.toFixed(2)}\tratio ${e.match.peakRatio.toFixed(2)}\tcorr ${e.match.correlation.toFixed(2)}\tagree ${(e.match.agreement || 0).toFixed(2)}\toverlap ${e.match.overlap.toFixed(1)}s`);
    }
    if (st.manualEdges && st.manualEdges.length) {
      sec("manual fixes");
      out.push(JSON.stringify(st.manualEdges));
    }
    if (ctx.lastPlan) {
      sec("last build plan");
      const p = ctx.lastPlan;
      out.push(`frameTicks ${p.frameTicks}, ${p.sequences.length} sequence(s), unplaced ${p.unplaced.length}`);
      for (const s of p.sequences) {
        out.push(`* ${s.name}: settings ${s.settingsClipId}, staging A${s.stagingTrack + 1}, mute ${s.muteTracks.map((t) => "A" + (t + 1)).join(",") || "-"}`);
        for (const pl of s.placements)
          out.push(pl.kind === "av"
            ? `    av ${pl.clipId} V${pl.videoTrack + 1}/A${pl.audioTrack + 1} @${pl.pos.toFixed(6)} snap ${(pl.snapError * 1000).toFixed(2)}ms`
            : `    audio ${pl.clipId} A${pl.audioTrack + 1} @${pl.pos.toFixed(6)} src ${pl.srcIn.toFixed(3)}-${pl.srcOut.toFixed(3)}${pl.whole ? "" : " (piece)"}`);
      }
      for (const w of p.warnings) out.push(`note: ${w}`);
    }
    if (ctx.selfTest && ctx.selfTest.length) {
      sec("self-test");
      out.push(...ctx.selfTest);
    }

    sec("panel log");
    out.push(...lines.slice(-600));

    // After a crash this is the session that was running at the time.
    const prev = await Syncu.log.previous();
    if (prev.length) {
      sec("previous panel session (saved by the helper)");
      let start = prev.length;
      while (start > 0 && !/--- panel session .* started ---/.test(prev[start - 1])) start--;
      out.push(...prev.slice(Math.max(0, start - 1, prev.length - 400)));
    }

    sec("helper log");
    try {
      const res = await fetch("http://127.0.0.1:47800/log", { headers: { "X-Syncu": "1" } });
      const j = await res.json();
      out.push(...(j.lines || []).slice(-500));
    } catch (e) {
      out.push(`(unavailable: ${e.message || e})`);
    }
    return out.join("\n");
  };
})();
