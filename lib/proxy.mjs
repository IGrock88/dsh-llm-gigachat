/**
 * dsh-llm-gigachat / lib/proxy.mjs
 *
 * In-process OAuth proxy for Sber GigaChat, derived from the validated
 * `gigachat-proxy.mjs` stand-alone script (see repository root history / docs).
 * Behaviour preserved:
 *   1. OAuth 2.0 client-credentials exchange (SBER_API_KEY = base64(clientId:secret))
 *      -> access_token cached until `expires_at - margin`, single-flight, 401 refresh.
 *   2. UPSTREAM SERIALIZATION: personal GigaChat plans allow ~1 in-flight request
 *      (more => HTTP 429). FIFO queue, `maxConcurrency` workers.
 *   3. DEGENERATE "<" GUARD: a degraded reply of exactly "<" is transparently retried.
 *   4. TOOL-CALL TRANSLATION: GigaChat 3 ignores modern `tools`/`tool_choice` but
 *      speaks legacy OpenAI v1 `functions`/`function_call` (arguments as OBJECT).
 *      Request: tools->functions, tool_choice->function_call, tool_calls->function_call,
 *      role:"tool"->role:"function" (non-JSON content wrapped into a JSON string —
 *      GigaChat validates function results as JSON). Response: function_call->tool_calls.
 *
 * Unlike the stand-alone script, this module is a factory: credentials come from
 * an async resolver (the dsh credentials seam), all constants are options, and it
 * integrates with dsh lifecycle/logging. TLS verification stays off by default —
 * the Russian NCC (НУЦ Минцифры) CA-signed certificates GigaChat uses are not in
 * the default Node trust store on Windows; see README for hardening.
 */
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";

export const DEFAULT_MODELS = [
  { id: "GigaChat-3-Ultra", name: "GigaChat 3 Ultra" },
  { id: "GigaChat-3-Pro", name: "GigaChat 3 Pro" }
];

const TOKEN_MARGIN_MS = 60_000;
const QUEUE_LIMIT = 64;
const DEGENERATE_MAX_RETRIES = 2;
const SLEEP_MS = 400;

const joinUrl = (base, path) => `${String(base).replace(/\/+$/, "")}${path}`;

/** Minimal JSON request helper over http/https with fixed options. */
function requestJson(url, options, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.request(url, {
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      rejectUnauthorized: options.rejectUnauthorized ?? false,
    }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function isValidJson(s) {
  try { JSON.parse(s); return true; } catch { return false; }
}

/** Translate a modern OpenAI request body into GigaChat legacy function-calling form. */
export function translateRequest(body) {
  const b = JSON.parse(JSON.stringify(body));
  if (Array.isArray(b.tools) && b.tools.length > 0) {
    b.functions = b.tools.map((t) => t.function ?? t);
    delete b.tools;
    if (b.tool_choice && typeof b.tool_choice === "object" && b.tool_choice.type === "function") {
      b.function_call = b.tool_choice.function?.name ? { name: b.tool_choice.function.name } : "auto";
    } else if (b.tool_choice !== undefined) {
      b.function_call = b.tool_choice;
    }
    delete b.tool_choice;
  }
  const idToName = new Map();
  for (const msg of b.messages ?? []) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      const first = msg.tool_calls[0];
      const name = first?.function?.name ?? "";
      let argsObj = first?.function?.arguments;
      if (typeof argsObj === "string") { try { argsObj = JSON.parse(argsObj); } catch { /* keep */ } }
      if (first?.id) idToName.set(first.id, name);
      msg.function_call = { name, arguments: argsObj };
      delete msg.tool_calls;
    } else if (msg.role === "tool") {
      msg.role = "function";
      msg.name = idToName.get(msg.tool_call_id) ?? msg.name;
      delete msg.tool_call_id;
      if (typeof msg.content !== "string" || !isValidJson(msg.content)) {
        msg.content = JSON.stringify(msg.content);
      }
    }
  }
  return b;
}

/** Legacy function_call -> modern tool_calls (arguments as JSON string). */
function toModernToolCalls(fc, index = 0) {
  let args = fc.arguments;
  if (typeof args !== "string") { try { args = JSON.stringify(args ?? {}); } catch { args = "{}"; } }
  return [{
    index,
    id: fc.id ?? `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: { name: fc.name ?? "", arguments: args },
  }];
}

/** Response (stream chunk): delta.function_call -> delta.tool_calls; finish_reason. */
function translateStreamChunk(j) {
  const choice = j.choices?.[0];
  if (!choice) return j;
  const delta = choice.delta;
  if (delta && delta.function_call) {
    delta.tool_calls = toModernToolCalls(delta.function_call, choice.index ?? 0);
    delete delta.function_call;
    delete delta.functions_state_id;
    if (typeof delta.content !== "string") delta.content = "";
  }
  if (choice.finish_reason === "function_call") choice.finish_reason = "tool_calls";
  return j;
}

/** Response (non-stream): message.function_call -> message.tool_calls; finish_reason. */
function translateNonStream(j) {
  const choice = j.choices?.[0];
  const msg = choice?.message;
  if (msg && msg.function_call) {
    msg.tool_calls = toModernToolCalls(msg.function_call);
    delete msg.function_call;
    if (msg.content === undefined) msg.content = null;
  }
  if (choice?.finish_reason === "function_call") choice.finish_reason = "tool_calls";
  return j;
}

/** Degenerate "<"-answer: exactly the character "<" (text or one SSE event). */
function isDegenerateRaw(text) {
  const t = text.trim();
  if (t === "<") return true;
  return /^data:\s*\{.*?"choices"\s*:\s*\[\s*\{[^}]*"delta"\s*:\s*\{[^}]*"content"\s*:\s*"<"\s*\}[^}]*\}\s*\]/.test(t) &&
         !t.includes("[DONE]") && (t.match(/data:/g) ?? []).length <= 1;
}

/**
 * SSE-поток upstream -> клиент: построчный разбор, трансляция tool_calls,
 * удержание первого "<"-события для защиты от вырожденного ответа.
 * onEnd(degenerate: boolean): поток завершён (или ответ оказался ровно "<").
 */
function pipeSse(upstream, res, onEnd, onToolCall) {
  let emitted = false;
  let holding = null;
  let done = false;
  let buffer = [];
  let buffered = 0;
  const MAX_BUFFER = 256 * 1024;

  const emit = (buf) => {
    emitted = true;
    if (!res.writableEnded) { try { res.write(buf); } catch { /* ignore */ } }
  };

  const renderEvent = (eventBytes) => {
    const event = eventBytes.toString("utf8");
    const m = /data:\s*(.*)/.exec(event.replace(/\r/g, ""));
    if (!m) return eventBytes;
    const payload = m[1].trim();
    if (payload === "[DONE]") return Buffer.from("data: [DONE]\n\n");
    try {
      const j = JSON.parse(payload);
      const hadFc = JSON.stringify({
        del: j.choices?.[0]?.delta?.function_call ?? null,
        mes: j.choices?.[0]?.message?.function_call ?? null,
      }) !== '{"del":null,"mes":null}';
      const translated = translateStreamChunk(j);
      if (hadFc && typeof onToolCall === "function") onToolCall();
      return Buffer.from(`data: ${JSON.stringify(translated)}\n\n`);
    } catch {
      return eventBytes;
    }
  };

  const flushHeld = () => {
    if (holding !== null) { emit(renderEvent(holding)); holding = null; }
  };

  const collect = () => {
    for (;;) {
      const all = Buffer.concat(buffer);
      const idx = all.indexOf("\n\n");
      if (idx < 0) break;
      const eventBytes = all.subarray(0, idx + 2);
      buffer = [all.subarray(idx + 2)];
      buffered = buffer[0].length;
      const ev = eventBytes.toString("utf8");
      const m = /data:\s*(.*)/.exec(ev.replace(/\r/g, ""));
      let isLoneLt = false;
      if (m) {
        const payload = m[1].trim();
        if (payload !== "[DONE]") {
          try {
            const j = JSON.parse(payload);
            const d = j.choices?.[0]?.delta;
            isLoneLt = typeof d?.content === "string" && d.content === "<";
          } catch { /* ignore */ }
        }
      }
      if (holding !== null) {
        emit(renderEvent(holding));
        holding = null;
      }
      if (isLoneLt) holding = eventBytes;
      else emit(renderEvent(eventBytes));
      if (buffered === 0) break;
    }
  };

  const onData = (c) => {
    if (done) return;
    buffer.push(c);
    buffered += c.length;
    if (buffered > MAX_BUFFER) {
      flushHeld();
      emit(Buffer.concat(buffer));
      buffer = []; buffered = 0;
      upstream.removeListener("data", onData);
      upstream.on("data", (d) => emit(d));
      return;
    }
    collect();
  };

  upstream.on("data", onData);
  upstream.on("end", () => {
    if (done) return;
    done = true;
    const rest = Buffer.concat(buffer);
    buffer = [];
    if (holding !== null) {
      const degenerate = isDegenerateRaw(renderEvent(holding).toString("utf8")) && rest.length === 0 && !emitted;
      if (degenerate) { onEnd(true); return; }
      emit(renderEvent(holding));
      holding = null;
    }
    if (rest.length) emit(rest);
    if (!res.writableEnded) res.end();
    onEnd(false);
  });
  upstream.on("error", () => {
    if (done) return;
    done = true;
    if (holding !== null) { emit(renderEvent(holding)); holding = null; }
    if (!res.writableEnded) res.end();
    onEnd(false);
  });
}

/**
 * Create the GigaChat OAuth proxy.
 * @param options
 *   host, port            — listen address (default 127.0.0.1:8787)
 *   upstreamBaseURL       — chat completions base (default https://api.giga.chat/v1)
 *   oauthURL              — token endpoint (default ngw.devices.sberbank.ru:9443)
 *   oauthFallback         — secondary token endpoint (default api.giga.chat/api/v2/oauth)
 *   scope                 — OAuth scope (default GIGACHAT_API_PERS)
 *   apiKeyEnv             — credential reference name (default SBER_API_KEY)
 *   resolveCredentials    — async () => string|undefined (clientId:secret base64)
 *   maxConcurrency        — upstream in-flight cap (default 1)
 *   rejectUnauthorized    — TLS verify flag (default false)
 *   models                — model list served by GET /v1/models
 *   logger                — { info, warn, error } sink (defaults to console)
 * @returns { server, listen(), close(), stats, address() }
 */
export function createGigaChatProxy(options = {}) {
  const {
    host = "127.0.0.1",
    port = 8787,
    upstreamBaseURL = "https://api.giga.chat/v1",
    oauthURL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
    oauthFallback = "https://api.giga.chat/api/v2/oauth",
    scope = "GIGACHAT_API_PERS",
    maxConcurrency = 1,
    rejectUnauthorized = false,
    resolveCredentials,
    models = DEFAULT_MODELS,
    logger = console,
  } = options;

  const stats = { served: 0, rateLimited: 0, serverErrors: 0, degenerateRetries: 0, toolCallsTranslated: 0 };
  let active = 0;
  const queue = [];
  let cachedToken = null;
  let inflight = null;
  let server = null;

  function logInfo(...args) { try { logger.info(...args); } catch { /* ignore */ } }
  function logError(...args) { try { logger.error(...args); } catch { console.error(...args); } }

  async function fetchToken() {
    const credentials = typeof resolveCredentials === "function" ? await resolveCredentials() : undefined;
    if (!credentials) {
      throw new Error(`no GigaChat credentials: set the "${options.apiKeyEnv ?? "SBER_API_KEY"}" credential through the Models page (value = base64(clientId:clientSecret)) or export the variable`);
    }
    const basic = `Basic ${credentials}`;
    const form = `scope=${encodeURIComponent(scope)}`;
    const run = async (url) => requestJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": basic,
        "RqUID": randomUUID(),
        "Accept": "application/json",
      },
      rejectUnauthorized,
    }, form);
    let res;
    try {
      res = await run(oauthURL);
      if (res.status >= 400) { logInfo(`OAuth ${oauthURL} -> ${res.status}, fallback`); res = await run(oauthFallback); }
    } catch (err) {
      logInfo(`OAuth ${oauthURL} недоступен (${err.code ?? err.message}), fallback`);
      res = await run(oauthFallback);
    }
    if (res.status !== 200) throw new Error(`GigaChat OAuth ${res.status}: ${res.text.slice(0, 300)}`);
    let json;
    try { json = JSON.parse(res.text); } catch { throw new Error(`GigaChat OAuth: not JSON: ${res.text.slice(0, 300)}`); }
    if (!json.access_token) throw new Error(`GigaChat OAuth: no access_token: ${res.text.slice(0, 300)}`);
    const expiresInMs = typeof json.expires_in === "number" ? json.expires_in * 1000 : 30 * 60 * 1000;
    const expiresAtMs = typeof json.expires_at === "number" ? json.expires_at
      : typeof json.expires_at === "string" ? (Date.parse(json.expires_at) || Date.now() + expiresInMs)
      : Date.now() + expiresInMs;
    logInfo(`GigaChat token refreshed: ${Math.round(expiresInMs / 1000)}s, expires ${new Date(expiresAtMs).toISOString()}`);
    return { token: json.access_token, expiresAtMs };
  }

  async function getToken(force = false) {
    if (!force && cachedToken && Date.now() + TOKEN_MARGIN_MS < cachedToken.expiresAtMs) return cachedToken.token;
    if (inflight) return inflight;
    inflight = (async () => {
      try { const t = await fetchToken(); cachedToken = t; return t.token; }
      finally { inflight = null; }
    })();
    return inflight;
  }

  function upstreamRequest(base, path, headers, body, token) {
    return new Promise((resolve, reject) => {
      const mod = base.startsWith("https:") ? https : http;
      const h = { ...headers, "Authorization": `Bearer ${token}` };
      delete h.Host;
      const req = mod.request(base + path, { method: "POST", headers: h, rejectUnauthorized }, resolve);
      req.on("error", reject);
      req.end(body);
    });
  }

  function readUpstreamText(upstream) {
    return new Promise((resolve) => {
      const c = [];
      upstream.on("data", (d) => c.push(d));
      upstream.on("end", () => resolve(Buffer.concat(c).toString("utf8")));
      upstream.on("error", () => resolve(""));
    });
  }

  function enqueueUpstream(task) {
    return new Promise((resolve, reject) => {
      if (queue.length >= QUEUE_LIMIT) { reject(new Error("gigachat proxy queue overflow")); return; }
      queue.push({ task, resolve, reject });
      pump();
    });
  }
  function pump() {
    while (active < maxConcurrency && queue.length > 0) {
      const { task, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve().then(task).then(
        (v) => { active -= 1; resolve(v); pump(); },
        (e) => { active -= 1; reject(e); pump(); },
      );
    }
  }

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const startedAt = Date.now();

    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: models.map((m) => ({ id: m.id, object: "model", owned_by: "sber", display_name: m.name ?? m.id })),
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ active, queueDepth: queue.length, ...stats }));
      return;
    }
    if (req.method !== "POST" || !(url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found. Use POST /v1/chat/completions");
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyBuf = Buffer.concat(chunks);
    let streamMode = false;
    let upstreamBody = bodyBuf;
    try {
      const parsed = JSON.parse(bodyBuf.toString("utf8"));
      streamMode = parsed.stream === true;
      upstreamBody = Buffer.from(JSON.stringify(translateRequest(parsed)));
      const up = JSON.parse(upstreamBody.toString("utf8"));
      logInfo(`REQ stream=${streamMode} tools=${parsed.tools?.length ?? 0} functions=${up.functions?.length ?? 0} roles=${(parsed.messages ?? []).map((m) => m.role).join(",")}`);
    } catch (err) { logInfo(`REQ parse fail: ${err.message}`); }

    try {
      const result = await enqueueUpstream(async () => {
        let attempts = 1 + DEGENERATE_MAX_RETRIES;
        while (attempts-- > 0) {
          const token = await getToken();
          const mkUpstream = () => upstreamRequest(upstreamBaseURL, "/chat/completions", {
            "Content-Type": "application/json",
            "Accept": req.headers.accept ?? "application/json",
          }, upstreamBody, token);
          let up = await mkUpstream();

          if (up.statusCode === 401) {
            const text = await readUpstreamText(up);
            logInfo(`401 (${text.slice(0, 120)}) — refresh token`);
            up.destroy();
            await getToken(true);
            up = await mkUpstream();
          }

          if (up.statusCode === 429) {
            stats.rateLimited += 1;
            const text = await readUpstreamText(up);
            logInfo(`429 upstream (${text.slice(0, 80)}) — retry in ${SLEEP_MS}ms`);
            up.destroy();
            await new Promise((r) => setTimeout(r, SLEEP_MS));
            continue;
          }

          if (up.statusCode === 500) {
            stats.serverErrors += 1;
            const text = await readUpstreamText(up);
            logInfo(`500 upstream (${text.slice(0, 120)}) — retry in ${SLEEP_MS}ms`);
            up.destroy();
            await new Promise((r) => setTimeout(r, SLEEP_MS));
            continue;
          }

          const status = up.statusCode ?? 502;
          if (status !== 200) {
            const text = await readUpstreamText(up);
            logInfo(`upstream ${status}: ${text.slice(0, 400)}`);
            return { kind: "raw", status, raw: Buffer.from(text), contentType: "text/plain" };
          }

          if (!streamMode) {
            const rawText = await readUpstreamText(up);
            let out = rawText;
            try {
              const j = JSON.parse(rawText);
              const hadFc = JSON.stringify(j.choices?.[0]?.message?.function_call ?? null) !== "null";
              const translated = translateNonStream(j);
              if (hadFc) stats.toolCallsTranslated += 1;
              out = JSON.stringify(translated);
            } catch { /* not JSON — pass through */ }
            let content = out;
            try { content = JSON.parse(out).choices?.[0]?.message?.content ?? out; } catch { /* ignore */ }
            if (typeof content === "string" && content.trim() === "<" && attempts > 0) {
              stats.degenerateRetries += 1;
              logInfo("non-stream '<' — retry");
              await new Promise((r) => setTimeout(r, SLEEP_MS));
              continue;
            }
            return { kind: "raw", status: 200, raw: Buffer.from(out), contentType: up.headers["content-type"] ?? "application/json" };
          }

          // stream
          const degenerate = await new Promise((resolve) => {
            const headers = {};
            for (const [k, v] of Object.entries(up.headers)) {
              if (!["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length"].includes(k.toLowerCase())) headers[k] = v;
            }
            res.writeHead(200, headers);
            pipeSse(up, res, resolve, () => { stats.toolCallsTranslated += 1; });
          });

          if (degenerate && attempts > 0) {
            stats.degenerateRetries += 1;
            logInfo("stream '<' — retry");
            await new Promise((r) => setTimeout(r, SLEEP_MS));
            continue;
          }
          return { kind: "streamed", sent: true };
        }
        return { kind: "raw", status: 502, raw: Buffer.from("degraded after retries"), contentType: "text/plain" };
      });

      stats.served += 1;
      if (result.kind === "streamed") return;

      const status = result.status ?? 502;
      res.writeHead(status, { "Content-Type": result.contentType ?? "application/json" });
      res.end(result.raw ?? Buffer.from(""));
      logInfo(`UPSTREAM-OK ${Date.now() - startedAt}ms stream=${streamMode} status=${status}`);
    } catch (err) {
      logError(`proxy error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "dsh-llm-gigachat: " + err.message } }));
      } else res.destroy();
    }
  });

  return {
    server,
    stats,
    /** Start listening; rejects on failure (e.g. EADDRINUSE). */
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => { server.off("listening", onListening); reject(err); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close() {
      return new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } });
    },
    address() {
      const a = server.address();
      return a && typeof a === "object" ? `http://${host}:${a.port}` : `http://${host}:${port}`;
    },
  };
}