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
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

/* ---------------- Конфигурация (через env или UI) ---------------- */
const PORT = parseInt(process.env.PORT || "5173", 10);
const ENV_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.VERTEX_PROJECT ||
  process.env.GCP_PROJECT ||
  "";
const ENV_LOCATION = process.env.VERTEX_LOCATION || "global";
const ENV_MODEL = process.env.VERTEX_MODEL || "gemini-3-pro-image-preview";

// Прокси: берём из переменных окружения; если их нет — позже попробуем gcloud config.
const ENV_PROXY =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  process.env.NB_PROXY ||
  "";

const ROOT = __dirname;

/* ============================================================
   ПОЛУЧЕНИЕ ACCESS-ТОКЕНА (ADC через gcloud)
   Кэшируем на 50 минут (токен живёт ~60 мин).
============================================================ */
let tokenCache = { token: null, expires: 0 };

// Запускаем команду через оболочку (exec), чтобы на Windows корректно
// находился gcloud.cmd (PATHEXT). Во все команды передаются только
// константные строки без пользовательского ввода — это безопасно.
function runCmd(command) {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { timeout: 25000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = (stderr || "").toString();
          return reject(err);
        }
        resolve((stdout || "").toString().trim());
      }
    );
  });
}

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) {
    return tokenCache.token;
  }
  // Пробуем сначала ADC-токен, затем токен активного аккаунта gcloud.
  const attempts = [
    "gcloud auth application-default print-access-token",
    "gcloud auth print-access-token",
  ];
  let lastErr = null;
  for (const command of attempts) {
    try {
      const token = await runCmd(command);
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
      "Установите Google Cloud CLI и выполните вход:\n" +
      "  gcloud auth application-default login\n" +
      "(на Linux/Mac также подойдёт setup_adc.sh)" +
      detail
  );
}

async function resolveProject(provided) {
  if (provided && provided.trim()) return provided.trim();
  if (ENV_PROJECT) return ENV_PROJECT;
  try {
    const p = await runCmd("gcloud config get-value project");
    if (p && p !== "(unset)") return p;
  } catch (_) {
    /* ignore */
  }
  return "";
}

/* ============================================================
   ОПРЕДЕЛЕНИЕ ПРОКСИ
   Сначала переменные окружения, затем конфигурация gcloud
   (gcloud config get-value proxy/*). Результат кэшируется.
============================================================ */
let proxyCache = undefined; // undefined = ещё не определяли

async function resolveProxy() {
  if (proxyCache !== undefined) return proxyCache;
  if (ENV_PROXY) {
    proxyCache = normalizeProxy(ENV_PROXY);
    return proxyCache;
  }
  // Пробуем настройки прокси из gcloud (часто в корпоративной среде они заданы там).
  try {
    const [type, addr, port, user, pass] = await Promise.all([
      runCmd("gcloud config get-value proxy/type").catch(() => ""),
      runCmd("gcloud config get-value proxy/address").catch(() => ""),
      runCmd("gcloud config get-value proxy/port").catch(() => ""),
      runCmd("gcloud config get-value proxy/username").catch(() => ""),
      runCmd("gcloud config get-value proxy/password").catch(() => ""),
    ]);
    const clean = (v) => (v && v !== "(unset)" ? v.trim() : "");
    const a = clean(addr), p = clean(port);
    if (a && p) {
      const scheme = clean(type).includes("https") ? "https" : "http";
      const auth = clean(user) ? `${encodeURIComponent(clean(user))}:${encodeURIComponent(clean(pass))}@` : "";
      proxyCache = normalizeProxy(`${scheme}://${auth}${a}:${p}`);
      return proxyCache;
    }
  } catch (_) {
    /* ignore */
  }
  proxyCache = null;
  return proxyCache;
}

function normalizeProxy(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return {
      hostname: u.hostname,
      port: parseInt(u.port || (u.protocol === "https:" ? "443" : "80"), 10),
      tls: u.protocol === "https:",
      username: u.username ? decodeURIComponent(u.username) : "",
      password: u.password ? decodeURIComponent(u.password) : "",
      href: `${u.protocol}//${u.hostname}:${u.port}`,
    };
  } catch (_) {
    return null;
  }
}

/* ============================================================
   ВЫЗОВ VERTEX AI
============================================================ */
function vertexHost(location) {
  return location === "global"
    ? "aiplatform.googleapis.com"
    : `${location}-aiplatform.googleapis.com`;
}

// Создаёт TLS-соединение к host:port. Если задан прокси — туннелирует
// через HTTP CONNECT (стандартный способ доступа к HTTPS через корп-прокси).
function createUpstreamSocket(host, port, proxy) {
  return new Promise((resolve, reject) => {
    if (!proxy) {
      const socket = tls.connect({ host, port, servername: host }, () => resolve(socket));
      socket.once("error", reject);
      return;
    }
    // Подключаемся к прокси (обычный TCP или TLS до самого прокси).
    const toProxy = proxy.tls
      ? tls.connect({ host: proxy.hostname, port: proxy.port, servername: proxy.hostname })
      : net.connect({ host: proxy.hostname, port: proxy.port });

    toProxy.once("error", reject);
    toProxy.once(proxy.tls ? "secureConnect" : "connect", () => {
      let head = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
      if (proxy.username) {
        const cred = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
        head += `Proxy-Authorization: Basic ${cred}\r\n`;
      }
      head += "Connection: keep-alive\r\n\r\n";
      toProxy.write(head);
    });

    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      toProxy.removeListener("data", onData);
      const statusLine = buf.split("\r\n")[0];
      const m = statusLine.match(/\s(\d{3})\s/);
      if (!m || m[1] !== "200") {
        reject(new Error("Прокси отклонил CONNECT: " + statusLine.trim()));
        toProxy.destroy();
        return;
      }
      // Поверх туннеля поднимаем TLS до реального хоста Google.
      const secure = tls.connect({ socket: toProxy, servername: host }, () => resolve(secure));
      secure.once("error", reject);
    };
    toProxy.on("data", onData);
  });
}

function callVertex({ token, project, location, model, body }) {
  return new Promise(async (resolve, reject) => {
    const host = vertexHost(location);
    const reqPath =
      `/v1/projects/${encodeURIComponent(project)}` +
      `/locations/${encodeURIComponent(location)}` +
      `/publishers/google/models/${encodeURIComponent(model)}:generateContent`;

    const payload = Buffer.from(JSON.stringify(body));

    let proxy = null;
    try {
      proxy = await resolveProxy();
    } catch (_) {
      proxy = null;
    }

    const options = {
      method: "POST",
      host,
      port: 443,
      path: reqPath,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": payload.length,
      },
      // Если есть прокси — пробрасываем уже готовый TLS-сокет через туннель.
      createConnection: proxy
        ? (_opts, cb) => {
            createUpstreamSocket(host, 443, proxy).then((s) => cb(null, s), cb);
          }
        : undefined,
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
    req.on("error", (err) => {
      reject(decorateNetworkError(err, proxy));
    });
    req.write(payload);
    req.end();
  });
}

// Делает сетевые ошибки понятнее для пользователя.
function decorateNetworkError(err, proxy) {
  const code = err && err.code ? err.code : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new Error(
      "Не удалось разрешить адрес aiplatform.googleapis.com (DNS). " +
        (proxy
          ? "Прокси задан, но соединение не прошло — проверьте адрес/порт прокси."
          : "Похоже, вы за корпоративным прокси/VPN. Укажите прокси: запустите сервер с переменной HTTPS_PROXY, например в Windows:\n  set HTTPS_PROXY=http://proxy.company.com:8080 && node server.js") +
        " (" + code + ")"
    );
  }
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ECONNRESET") {
    return new Error(
      "Сетевое соединение с Vertex AI не установлено (" + code + "). " +
        "Проверьте интернет/VPN" + (proxy ? " и настройки прокси." : " или укажите прокси через HTTPS_PROXY.")
    );
  }
  return err;
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
    const proxy = await resolveProxy();
    sendJSON(res, 200, {
      ok: true,
      hasToken: !!token,
      project: project || null,
      location: ENV_LOCATION,
      model: ENV_MODEL,
      proxy: proxy ? proxy.href : null,
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
  console.log(`  Прокси (env):     ${ENV_PROXY || "(нет; попробую взять из gcloud config)"}`);
  console.log("  ───────────────────────────────────────────");
  console.log("  Откройте ссылку в браузере. Ctrl+C — остановить.\n");
});
