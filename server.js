// ruben-website — statische server + Qwen-chatbot-proxy.
//
// Draait op 0.0.0.0:3000; nginx zet dat door naar https://ruben.sdai.nl.
//
// Twee taken:
//   1. Statische bestanden serveren uit deze map — maar NOOIT dotfiles (.env!).
//   2. POST /api/chat doorsturen naar Qwen op de eigen GPU-server van SDAI.
//      De API-key blijft hier op de server; de browser ziet hem nooit.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ---------------------------------------------------------------------------
// .env inlezen (geen dependency nodig)
// ---------------------------------------------------------------------------
function loadEnv(file) {
  const env = {};
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return env;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[t.slice(0, i).trim()] = v;
  }
  return env;
}

const fileEnv = loadEnv(path.join(ROOT, ".env"));
const QWEN_API_KEY = process.env.QWEN_API_KEY || fileEnv.QWEN_API_KEY || "";
const QWEN_BASE_URL = (process.env.QWEN_BASE_URL || fileEnv.QWEN_BASE_URL || "https://q38-27b.sdai.nl/v1").replace(/\/+$/, "");
const QWEN_MODEL = process.env.QWEN_MODEL || fileEnv.QWEN_MODEL || "qwen3.8-27b";
const SYSTEM_PROMPT =
  process.env.QWEN_SYSTEM_PROMPT ||
  fileEnv.QWEN_SYSTEM_PROMPT ||
  "Je bent de behulpzame assistent op de website van Ruben. Antwoord in het Nederlands, " +
    "kort en concreet. Weet je iets niet zeker, zeg dat dan.";

// ---------------------------------------------------------------------------
// Statische bestanden
// ---------------------------------------------------------------------------
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

// Bestanden die nooit naar buiten mogen, ook al staan ze in deze map.
const BLOCKED = new Set([".env", "server.js", "package.json", "package-lock.json", ".gitignore"]);

function isBlocked(rel) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  // Elk paddeel dat met een punt begint (.env, .git, .ssh, ...) is verboden.
  if (parts.some((p) => p.startsWith("."))) return true;
  if (parts.some((p) => BLOCKED.has(p))) return true;
  return false;
}

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8" });
  res.end(body);
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  if (isBlocked(rel)) return send(res, 403, "403 — Verboden");
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) return send(res, 403, "403 — Verboden");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "<h1>404 — Not Found</h1>", "text/html; charset=utf-8");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// POST /api/chat — doorsturen naar Qwen
// ---------------------------------------------------------------------------
const MAX_BODY = 100 * 1024; // 100 kB
const MAX_MESSAGES = 40; // laatste N berichten uit de geschiedenis
const MAX_CHARS_PER_MSG = 4000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sanitize(messages) {
  if (!Array.isArray(messages)) return null;
  const clean = [];
  for (const m of messages) {
    if (!m || typeof m.content !== "string") continue;
    const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    const content = m.content.trim().slice(0, MAX_CHARS_PER_MSG);
    if (content) clean.push({ role, content });
  }
  if (!clean.length) return null;
  return clean.slice(-MAX_MESSAGES);
}

async function handleChat(req, res) {
  if (!QWEN_API_KEY) {
    return send(
      res,
      500,
      JSON.stringify({ error: "Geen QWEN_API_KEY gevonden in .env — zie de handleiding." }),
      "application/json"
    );
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, JSON.stringify({ error: "Ongeldige JSON in het verzoek." }), "application/json");
  }

  const messages = sanitize(payload && payload.messages);
  if (!messages) {
    return send(res, 400, JSON.stringify({ error: "Veld 'messages' ontbreekt of is leeg." }), "application/json");
  }

  const started = Date.now();
  try {
    const upstream = await fetch(QWEN_BASE_URL + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + QWEN_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        max_tokens: 800,
        temperature: 0.7,
        // Qwen3.8 is een denkmodel: zonder deze vlag verbrandt het al zijn tokens
        // aan reasoning_content en blijft 'content' leeg (finish_reason: length).
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(150000),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      console.error("[api/chat] Qwen gaf HTTP", upstream.status, text.slice(0, 500));
      return send(
        res,
        502,
        JSON.stringify({ error: "Het model is even niet bereikbaar (HTTP " + upstream.status + "). Probeer het nog eens." }),
        "application/json"
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("[api/chat] geen JSON van Qwen:", text.slice(0, 500));
      return send(res, 502, JSON.stringify({ error: "Onverwacht antwoord van het model." }), "application/json");
    }

    const choice = (data.choices && data.choices[0]) || {};
    const reply = ((choice.message && choice.message.content) || "").trim();
    const truncated = choice.finish_reason === "length";

    if (!reply) {
      console.error("[api/chat] leeg antwoord; finish_reason =", choice.finish_reason);
      return send(
        res,
        502,
        JSON.stringify({ error: "Het model gaf geen antwoord. Probeer het opnieuw of stel de vraag anders." }),
        "application/json"
      );
    }

    console.log("[api/chat] ok in", Date.now() - started, "ms;", (data.usage && data.usage.total_tokens) || "?", "tokens");
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(
      JSON.stringify({
        reply,
        truncated,
        model: data.model || QWEN_MODEL,
        usage: data.usage || null,
        ms: Date.now() - started,
      })
    );
  } catch (err) {
    const aborted = err && (err.name === "TimeoutError" || err.name === "AbortError");
    console.error("[api/chat]", aborted ? "timeout" : err);
    return send(
      res,
      504,
      JSON.stringify({
        error: aborted
          ? "Het model deed er te lang over (de GPU wordt gedeeld). Probeer het nog eens."
          : "Kon het model niet bereiken.",
      }),
      "application/json"
    );
  }
}

// ---------------------------------------------------------------------------
http
  .createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/api/chat") {
      if (req.method !== "POST") return send(res, 405, JSON.stringify({ error: "Gebruik POST." }), "application/json");
      return handleChat(req, res);
    }
    if (url === "/api/health") {
      return send(
        res,
        200,
        JSON.stringify({ ok: true, model: QWEN_MODEL, key: QWEN_API_KEY ? "aanwezig" : "ontbreekt" }),
        "application/json"
      );
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "405 — Method Not Allowed");
    serveStatic(req, res);
  })
  .listen(PORT, "0.0.0.0", () =>
    console.log(
      `ruben-website serving ${ROOT} on http://0.0.0.0:${PORT} (Qwen-model: ${QWEN_MODEL}, key ${QWEN_API_KEY ? "geladen" : "ONTBREEKT"})`
    )
  );
