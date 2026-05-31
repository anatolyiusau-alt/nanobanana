#!/usr/bin/env node
/* ============================================================
   Nano Banana Studio — локальный бэкенд-прокси для Vertex AI
   ------------------------------------------------------------
   Зачем нужен: организации часто запрещают API-ключи и требуют
   Application Default Credentials (ADC). ADC-токен нельзя получить
   из браузера, поэтому этот лёгкий сервер:
     1) берёт access-token через gcloud (ADC),
     2) проксирует запросы в Vertex AI generateContent,
     3) раздаёт сам сайт (index.html).

   Зависимостей нет — только встроенные модули Node.js.
   Запуск:  node server.js
   ============================================================ */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

/* ---------------- Конфигурация (через env или UI) ---------------- */
const PORT = parseInt(process.env.PORT || "5173", 10);
const ENV_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.VERTEX_PROJECT ||
  process.env.GCP_PROJECT ||
  "";
const ENV_LOCATION = process.env.VERTEX_LOCATION || "global";
const ENV_MODEL = process.env.VERTEX_MODEL || "gemini-3-pro-image-preview";

const ROOT = __dirname;

/* ============================================================
   ПОЛУЧЕНИЕ ACCESS-ТОКЕНА (ADC через gcloud)
   Кэшируем на 50 минут (токен живёт ~60 мин).
============================================================ */
let tokenCache = { token: null, expires: 0 };

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 25000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = (stderr || "").toString();
        return reject(err);
      }
      resolve((stdout || "").toString().trim());
    });
  });
}

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) {
    return tokenCache.token;
  }
  // Пробуем сначала ADC-токен, затем токен активного аккаунта gcloud.
  const attempts = [
    ["gcloud", ["auth", "application-default", "print-access-token"]],
    ["gcloud", ["auth", "print-access-token"]],
  ];
  let lastErr = null;
  for (const [cmd, args] of attempts) {
    try {
      const token = await runCmd(cmd, args);
      if (token) {
        tokenCache = { token, expires: Date.now() + 50 * 60 * 1000 };
        return token;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  const detail = lastErr && lastErr.stderr ? "\n" + lastErr.stderr.trim() : "";
  throw new Error(
    "Не удалось получить токен доступа через gcloud (ADC). " +
      "Установите Google Cloud CLI и выполните настройку ADC:\n" +
      "  bash <(curl -sSL https://storage.googleapis.com/cloud-samples-data/adc/setup_adc.sh)\n" +
      "или:  gcloud auth application-default login" +
      detail
  );
}

async function resolveProject(provided) {
  if (provided && provided.trim()) return provided.trim();
  if (ENV_PROJECT) return ENV_PROJECT;
  try {
    const p = await runCmd("gcloud", ["config", "get-value", "project"]);
    if (p && p !== "(unset)") return p;
  } catch (_) {
    /* ignore */
  }
  return "";
}

/* ============================================================
   ВЫЗОВ VERTEX AI
============================================================ */
function vertexHost(location) {
  return location === "global"
    ? "aiplatform.googleapis.com"
    : `${location}-aiplatform.googleapis.com`;
}

function callVertex({ token, project, location, model, body }) {
  return new Promise((resolve, reject) => {
    const host = vertexHost(location);
    const reqPath =
      `/v1/projects/${encodeURIComponent(project)}` +
      `/locations/${encodeURIComponent(location)}` +
      `/publishers/google/models/${encodeURIComponent(model)}:generateContent`;

    const payload = Buffer.from(JSON.stringify(body));
    const options = {
      method: "POST",
      host,
      path: reqPath,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": payload.length,
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (_) {
          json = { raw: text };
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/* ============================================================
   HTTP-УТИЛИТЫ
============================================================ */
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limitBytes = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("Запрос слишком большой"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

/* ============================================================
   ОБРАБОТЧИКИ API
============================================================ */
async function handleHealth(req, res) {
  try {
    const token = await getAccessToken();
    const project = await resolveProject("");
    sendJSON(res, 200, {
      ok: true,
      hasToken: !!token,
      project: project || null,
      location: ENV_LOCATION,
      model: ENV_MODEL,
      message: project
        ? "ADC работает, проект определён."
        : "ADC работает, но проект не задан — укажите Project ID в настройках.",
    });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: e.message });
  }
}

async function handleGenerate(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: "Некорректное тело запроса" });
  }

  const prompt = (payload.prompt || "").trim();
  if (!prompt) return sendJSON(res, 400, { ok: false, error: "Пустой промпт" });

  const location = (payload.location || ENV_LOCATION || "global").trim();
  const model = (payload.model || ENV_MODEL).trim();
  const aspectRatio = payload.aspectRatio || "1:1";
  const imageSize = payload.imageSize || "2K";
  const refs = Array.isArray(payload.refs) ? payload.refs : [];

  let project;
  try {
    project = await resolveProject(payload.project || "");
  } catch (e) {
    project = "";
  }
  if (!project) {
    return sendJSON(res, 400, {
      ok: false,
      error:
        "Не задан Project ID. Укажите его в настройках или выполните `gcloud config set project <ID>`.",
    });
  }

  // Собираем parts: текст + (опц.) референсные изображения.
  const parts = [{ text: prompt }];
  for (const r of refs) {
    if (r && r.data) {
      parts.push({ inlineData: { mimeType: r.mimeType || "image/png", data: r.data } });
    }
  }

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio, imageSize },
    },
  };

  try {
    const token = await getAccessToken();
    const { status, json } = await callVertex({ token, project, location, model, body });

    if (status < 200 || status >= 300) {
      const msg =
        (json && json.error && json.error.message) ||
        (json && json.raw) ||
        `Vertex AI вернул HTTP ${status}`;
      return sendJSON(res, status, { ok: false, error: msg, raw: json });
    }

    // Извлекаем изображение из ответа.
    const cand = json && json.candidates && json.candidates[0];
    const outParts = (cand && cand.content && cand.content.parts) || [];
    let image = null;
    let textOut = "";
    for (const p of outParts) {
      const inline = p.inlineData || p.inline_data;
      if (inline && inline.data) {
        const mime = inline.mimeType || inline.mime_type || "image/png";
        image = { mimeType: mime, data: inline.data };
      } else if (p.text) {
        textOut += p.text;
      }
    }

    if (!image) {
      const reason = cand && cand.finishReason ? ` (причина: ${cand.finishReason})` : "";
      return sendJSON(res, 200, {
        ok: false,
        error: (textOut || "Модель не вернула изображение") + reason,
      });
    }

    return sendJSON(res, 200, {
      ok: true,
      image,
      text: textOut,
      meta: { project, location, model, aspectRatio, imageSize },
    });
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: e.message });
  }
}

/* ============================================================
   СЕРВЕР
============================================================ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // API
  if (pathname === "/api/health" && req.method === "GET") {
    return handleHealth(req, res);
  }
  if (pathname === "/api/generate" && req.method === "POST") {
    return handleGenerate(req, res);
  }

  // Статика
  if (pathname === "/" || pathname === "/index.html") {
    return serveStatic(res, path.join(ROOT, "index.html"));
  }
  // Защита от выхода за пределы папки
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT, safe);
  if (filePath.startsWith(ROOT) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return serveStatic(res, filePath);
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404 Not Found");
});

server.listen(PORT, () => {
  console.log("\n  🍌  Nano Banana Studio");
  console.log("  ───────────────────────────────────────────");
  console.log(`  Сервер запущен:   http://localhost:${PORT}`);
  console.log(`  Проект (env):     ${ENV_PROJECT || "(определяется через gcloud)"}`);
  console.log(`  Регион:           ${ENV_LOCATION}`);
  console.log(`  Модель:           ${ENV_MODEL}`);
  console.log("  ───────────────────────────────────────────");
  console.log("  Откройте ссылку в браузере. Ctrl+C — остановить.\n");
});
