/* EM2 D2P1 Meeting Kit Generator — production server (v4.0)
   - Serves the app from /public
   - /api/claude  : proxies the Anthropic Messages API with the server-side key
   - /api/ahrefs  : deterministic data pull straight from the Ahrefs REST API
   - /api/health  : configuration + liveness probe
   Keys never reach the browser. Node 18+ (global fetch). */

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const AHREFS_BASE = process.env.AHREFS_BASE || "https://api.ahrefs.com/v3";

// injectable for tests
app.set("upstream", (...args) => fetch(...args));

/* ---------- optional passcode gate ---------- */
app.use("/api", (req, res, next) => {
  const pass = process.env.APP_PASSCODE;
  if (!pass) return next();
  if (req.get("x-d2p1-pass") === pass) return next();
  res.status(401).json({ error: "passcode required" });
});

/* ---------- health ---------- */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    ahrefsKey: Boolean(process.env.AHREFS_API_KEY),
    passcode: Boolean(process.env.APP_PASSCODE),
    version: "4.0.0"
  });
});

/* ---------- Anthropic proxy ---------- */
const ALLOWED = ["model", "max_tokens", "temperature", "system", "messages", "tools", "tool_choice"];
app.post("/api/claude", async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: { message: "Server missing ANTHROPIC_API_KEY — set it in .env" } });
    }
    const body = {};
    for (const k of ALLOWED) if (req.body[k] !== undefined) body[k] = req.body[k];
    const upstream = app.get("upstream");
    const r = await upstream(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: { message: "Upstream failure: " + String(e.message || e).slice(0, 160) } });
  }
});

/* ---------- Ahrefs: deterministic pull, no model in the loop ---------- */
function ahrefsHeaders() {
  return { Authorization: "Bearer " + process.env.AHREFS_API_KEY, Accept: "application/json" };
}
app.post("/api/ahrefs", async (req, res) => {
  try {
    if (!process.env.AHREFS_API_KEY) {
      return res.status(500).json({ error: "Server missing AHREFS_API_KEY — set it in .env" });
    }
    const upstream = app.get("upstream");

    if (req.body && req.body.probe) {
      const r = await upstream(AHREFS_BASE + "/subscription-info/limits-and-usage", { headers: ahrefsHeaders() });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) return res.status(r.status || 502).json({ error: "Ahrefs probe failed (HTTP " + r.status + ")" });
      const lim = j.limits_and_usage || {};
      return res.json({ ok: true, units_left: (lim.units_limit_workspace || 0) - (lim.units_usage_workspace || 0) });
    }

    const domain = String(req.body && req.body.domain || "").trim()
      .replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    if (!domain) return res.status(400).json({ error: "domain required" });

    const [batchRes, aiRes] = await Promise.all([
      upstream(AHREFS_BASE + "/batch-analysis/batch-analysis", {
        method: "POST",
        headers: Object.assign({ "content-type": "application/json" }, ahrefsHeaders()),
        body: JSON.stringify({
          select: ["url", "domain_rating", "org_traffic", "org_keywords", "org_cost", "refdomains", "backlinks", "org_keywords_1_3", "paid_traffic"],
          targets: [{ url: domain, mode: "subdomains", protocol: "both" }]
        })
      }),
      upstream(AHREFS_BASE + "/site-explorer/ai-responses-count?" + new URLSearchParams({
        target: domain, mode: "subdomains",
        select: "chatgpt,gemini,perplexity,copilot,grok,google_ai_overviews"
      }).toString(), { headers: ahrefsHeaders() })
    ]);

    const batch = await batchRes.json().catch(() => null);
    const aiJ = await aiRes.json().catch(() => null);
    if (!batchRes.ok || !batch || !batch.targets || !batch.targets[0]) {
      return res.status(batchRes.status || 502).json({ error: "Ahrefs batch-analysis failed (HTTP " + batchRes.status + "): " + JSON.stringify(batch).slice(0, 140) });
    }
    const t = batch.targets[0];
    const aiRaw = (aiJ && aiJ.ai_responses_count) || {};
    const c = (k) => (aiRaw[k] && aiRaw[k].citations) || 0;
    const ai = {
      chatgpt: c("chatgpt"), gemini: c("gemini"), perplexity: c("perplexity"),
      copilot: c("copilot"), grok: c("grok"), aio: c("google_ai_overviews")
    };
    ai.total = ai.chatgpt + ai.gemini + ai.perplexity + ai.copilot + ai.grok + ai.aio;

    res.json({
      dr: t.domain_rating,
      org_traffic: t.org_traffic,
      org_keywords: t.org_keywords,
      org_cost_usd: Math.round((t.org_cost || 0) / 100),
      refdomains: t.refdomains,
      backlinks: t.backlinks,
      top3: t.org_keywords_1_3,
      paid_traffic: t.paid_traffic,
      ai: ai,
      aiAvailable: Boolean(aiRes.ok && aiJ && aiJ.ai_responses_count)
    });
  } catch (e) {
    res.status(502).json({ error: "Ahrefs upstream failure: " + String(e.message || e).slice(0, 160) });
  }
});

const PORT = process.env.PORT || 8787;
if (require.main === module) {
  app.listen(PORT, () => console.log("EM2 D2P1 production server on http://localhost:" + PORT));
}
module.exports = app;
