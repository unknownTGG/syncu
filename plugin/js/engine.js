// Client for the Syncu helper (syncu-engine serve) on 127.0.0.1:47800.
window.Syncu = window.Syncu || {};

Syncu.engine = (() => {
  const BASE = "http://127.0.0.1:47800";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function call(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: { "X-Syncu": "1", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  }

  return {
    lastError: "",

    async health() {
      try {
        const h = await call("GET", "/health");
        this.lastError = "";
        return h;
      } catch (e) {
        // Keep the reason: "helper not running" and "Premiere blocked the
        // request" need different fixes.
        this.lastError = (e && (e.message || String(e))) || "unknown";
        return null;
      }
    },

    // Runs a full analysis; onProgress(fraction, message) while it works.
    async analyze(request, onProgress) {
      const start = await call("POST", "/analyze", request);
      if (!start.ok) throw new Error(start.error || "helper refused the request");
      for (;;) {
        await sleep(400);
        const s = await call("GET", `/job?id=${start.job}`);
        if (!s.ok) throw new Error(s.error || "lost the analysis job");
        if (onProgress) onProgress(s.progress, s.message);
        if (s.done) {
          if (!s.result.ok) throw new Error(s.result.error || "analysis failed");
          return s.result;
        }
      }
    },
  };
})();
