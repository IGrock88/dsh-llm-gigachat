/**
 * dsh-llm-gigachat — DeepSeek Harness plugin that connects Sber GigaChat models.
 *
 * What it does (all through harness-native seams, no config-file surgery):
 *   1. Built-in OAuth proxy  — starts an in-process HTTP server
 *      (127.0.0.1:<port>, default 8787) that owns the GigaChat OAuth 2.0
 *      client-credentials exchange, upstream request serialization, the
 *      degenerate-"<" guard, and legacy tool-calling translation. Credentials
 *      resolve through the dsh credentials seam (`SBER_API_KEY`,
 *      base64(clientId:clientSecret)) — the same reference the Models page
 *      writes when you store the key through the standard UI.
 *   2. Route bootstrap — ensures the `llm-pi-ai.providers.<providerId>` route
 *      (default `sber`) exists, pointing at the local proxy with the GigaChat
 *      model catalog. It is written through `settings.mutate` PATH OPS only,
 *      so no other provider's config is ever touched. `llm-pi-ai` then
 *      registers the route + configurable-provider directory entry itself, so
 *      the "Sber GigaChat" row appears on the standard Settings > Models page
 *      with an API-key field and the model picker.
 *   3. Settings section  — `gigachat:` namespace, hot-reloaded from the user
 *      settings document; live apply when values change.
 *
 * SAFETY (why the mount patch only inserts): the dsh patch engine REPLACES a
 * targeted entry's config wholesale (it does not deep-merge), so this bundle's
 * cordis.patch.yml only `insert`s its own row. Never add `- id: llm-pi-ai
 * config:` overrides here — that would wipe every other provider route.
 */
import http from "node:http";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createGigaChatProxy, DEFAULT_MODELS } from "./proxy.mjs";

const name = "llm-gigachat";
const NS = "gigachat";
const LLM_PI_AI_NS = "llm-pi-ai";

const ModelSchema = z.object({
  id: z.string(),
  // Note: schemastery v3 has NO `.optional()` on validators; optionality is
  // expressed via `union` + `const(null)` + a null default (nullable input is
  // invalid unless a default supplies a fallback).
  name: z.union([z.string(), z.const(null)]).default(null)
});

/**
 * Weaker GigaChat models run WITHOUT tools by default: they reject complex
 * agent schemas with 422 (schema sanitization fixes that) or hallucinate tool
 * calls with invalid arguments (unfixable — model capability). Ultra/Pro are
 * the agentic models and keep tools. Remove entries to grant tools explicitly.
 */
const WEAK_TOOL_MODELS = [
  "GigaChat-3-Lightning",
  "GigaChat-2-Max",
  "GigaChat-2-Pro",
  "GigaChat-2"
];

const Config = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default("127.0.0.1"),
  port: z.number().default(8787),
  upstreamBaseURL: z.string().default("https://api.giga.chat/v1"),
  oauthURL: z.string().default("https://ngw.devices.sberbank.ru:9443/api/v2/oauth"),
  scope: z.string().default("GIGACHAT_API_PERS"),
  apiKeyEnv: z.string().default("SBER_API_KEY"),
  providerId: z.string().default("sber"),
  displayName: z.string().default("Sber GigaChat"),
  tls: z.object({ rejectUnauthorized: z.boolean().default(false) }).default({}),
  maxConcurrency: z.number().default(1),
  models: z.array(ModelSchema).default(DEFAULT_MODELS),
  ensureRoute: z.boolean().default(true),
  stripToolsFor: z.array(z.string()).default(WEAK_TOOL_MODELS)
});

const SettingsSchema = Config;

const inject = ["settings"];

const BOOTSTRAP_RETRY_MS = 2_000;
const BOOTSTRAP_MAX_ATTEMPTS = 10;
const PROBE_TIMEOUT_MS = 1_500;

function apply(ctx, config) {
  const log = ctx.logger ?? console;
  let source = () => config;
  let settingsApi = null;
  let proxy = null;
  let proxyFacts = null;
  let proxyServing = false;   // true: proxy running here, or an external one serves the port
  let bootstrapAttempts = 0;
  let bootstrapTimer = null;
  let disposed = false;

  const cleanupFns = [];
  const registerCleanup = (fn) => cleanupFns.push(fn);

  ctx.inject(["settings"], (settingsCtx) => {
    settingsApi = settingsCtx.settings;
    settingsCtx.settings.installSection(
      ctx,
      NS,
      SettingsSchema,
      {
        enabled: config.enabled ?? true,
        host: config.host ?? "127.0.0.1",
        port: config.port ?? 8787,
        upstreamBaseURL: config.upstreamBaseURL ?? "https://api.giga.chat/v1",
        oauthURL: config.oauthURL ?? "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
        scope: config.scope ?? "GIGACHAT_API_PERS",
        apiKeyEnv: config.apiKeyEnv ?? "SBER_API_KEY",
        providerId: config.providerId ?? "sber",
        displayName: config.displayName ?? "Sber GigaChat",
        tls: config.tls ?? {},
        maxConcurrency: config.maxConcurrency ?? 1,
        models: config.models ?? DEFAULT_MODELS,
        ensureRoute: config.ensureRoute ?? true,
        stripToolsFor: config.stripToolsFor ?? WEAK_TOOL_MODELS
      },
      {
        setSource: (read) => { source = read; },
        onChange: () => { void reconcile("settings change"); }
      }
    );
    void reconcile("boot");
  });

  function current() {
    const value = source() ?? {};
    return {
      enabled: value.enabled !== false,
      host: value.host ?? "127.0.0.1",
      port: typeof value.port === "number" ? value.port : 8787,
      upstreamBaseURL: value.upstreamBaseURL ?? "https://api.giga.chat/v1",
      oauthURL: value.oauthURL ?? "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
      scope: value.scope ?? "GIGACHAT_API_PERS",
      apiKeyEnv: value.apiKeyEnv ?? "SBER_API_KEY",
      providerId: value.providerId ?? "sber",
      displayName: value.displayName ?? "Sber GigaChat",
      rejectUnauthorized: value?.tls?.rejectUnauthorized === true,
      maxConcurrency: typeof value.maxConcurrency === "number"
        ? Math.min(8, Math.max(1, Math.floor(value.maxConcurrency)))
        : 1,
      models: Array.isArray(value.models) && value.models.length > 0 ? value.models : DEFAULT_MODELS,
      ensureRoute: value.ensureRoute !== false,
      stripToolsFor: Array.isArray(value.stripToolsFor) ? value.stripToolsFor.filter((x) => typeof x === "string") : []
    };
  }

  async function resolveCredentials(cfg) {
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      try {
        const hit = await credentials.resolve(credentialRef(cfg.apiKeyEnv));
        if (hit && typeof hit.value === "string" && hit.value.length > 0) return hit.value;
      } catch (err) {
        log.warn(`gigachat: credential resolve failed for "${cfg.apiKeyEnv}": ${err.message}`);
      }
    }
    const envValue = process.env[cfg.apiKeyEnv] ?? process.env.GIGACHAT_CREDENTIALS;
    return envValue && envValue.length > 0 ? envValue : void 0;
  }

  /** Probe: does the port already answer a JSON model list? (external proxy?) */
  function portServesModels(host, port) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      const req = http.get({ host, port, path: "/v1/models", timeout: PROBE_TIMEOUT_MS }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            done(Array.isArray(json?.data) && json.data.length > 0);
          } catch { done(false); }
        });
        res.on("error", () => done(false));
      });
      req.on("timeout", () => { try { req.destroy(); } catch { /* ignore */ } done(false); });
      req.on("error", () => done(false));
    });
  }

  function routeValue(cfg) {
    return {
      displayName: cfg.displayName,
      apiKeyEnv: cfg.apiKeyEnv,
      api: "openai-completions",
      baseURL: `http://${cfg.host}:${cfg.port}/v1`,
      models: cfg.models.map((m) => (m.name ? { id: m.id, name: m.name } : { id: m.id }))
    };
  }

  function networkFacts(cfg) {
    return {
      enabled: cfg.enabled,
      host: cfg.host,
      port: cfg.port,
      upstreamBaseURL: cfg.upstreamBaseURL,
      oauthURL: cfg.oauthURL,
      scope: cfg.scope,
      apiKeyEnv: cfg.apiKeyEnv,
      rejectUnauthorized: cfg.rejectUnauthorized,
      maxConcurrency: cfg.maxConcurrency,
      models: cfg.models.map((m) => m.id).join(","),
      stripToolsFor: (cfg.stripToolsFor ?? []).join(",")
    };
  }

  /**
   * Ensure the llm-pi-ai route exists. Only ever touches the
   * `providers.<providerId>` path via settings.mutate path ops.
   */
  async function bootstrapRoute(cfg) {
    if (disposed || !cfg.ensureRoute || !cfg.providerId || !settingsApi) return;
    let resolved;
    try {
      resolved = settingsApi.get(LLM_PI_AI_NS);
    } catch {
      resolved = void 0;
    }
    const existing = resolved?.providers?.[cfg.providerId];
    if (existing !== void 0) {
      const ours = `http://${cfg.host}:${cfg.port}/v1`;
      if (typeof existing.baseURL === "string" && existing.baseURL !== ours && existing.baseURL.includes("127.0.0.1")) {
        try {
          await settingsApi.mutate(LLM_PI_AI_NS, [
            { op: "set", path: ["providers", cfg.providerId, "baseURL"], value: ours }
          ]);
          log.info(`gigachat: redirected route "${cfg.providerId}" baseURL -> ${ours}`);
        } catch (err) {
          log.warn(`gigachat: could not redirect "${cfg.providerId}" baseURL: ${err.message}`);
        }
      }
      return;
    }
    if (!proxyServing) return; // never point a route at a port that serves nothing
    try {
      const value = routeValue(cfg);
      await settingsApi.mutate(LLM_PI_AI_NS, [
        { op: "set", path: ["providers", cfg.providerId], value }
      ]);
      log.info(`gigachat: bootstrap route "${cfg.providerId}" -> ${value.baseURL}`);
    } catch (err) {
      scheduleBootstrapRetry(cfg, err);
    }
  }

  function scheduleBootstrapRetry(cfg, err) {
    if (disposed || bootstrapAttempts >= BOOTSTRAP_MAX_ATTEMPTS) {
      log.error(`gigachat: could not bootstrap "${cfg.providerId}" route: ${err?.message ?? "unknown"}`);
      return;
    }
    bootstrapAttempts += 1;
    bootstrapTimer = setTimeout(() => {
      bootstrapTimer = null;
      void bootstrapRoute(cfg);
    }, BOOTSTRAP_RETRY_MS);
    registerCleanup(() => {
      if (bootstrapTimer !== null) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
    });
  }

  async function startProxy(cfg) {
    if (!cfg.enabled) {
      proxyServing = false;
      return;
    }
    if (proxy) return;
    if (await portServesModels(cfg.host, cfg.port)) {
      log.info(`gigachat: port ${cfg.port} already serves a model list — external proxy assumed, not starting another`);
      proxyServing = true;
      return;
    }
    const factory = createGigaChatProxy({
      host: cfg.host,
      port: cfg.port,
      upstreamBaseURL: cfg.upstreamBaseURL,
      oauthURL: cfg.oauthURL,
      scope: cfg.scope,
      apiKeyEnv: cfg.apiKeyEnv,
      maxConcurrency: cfg.maxConcurrency,
      rejectUnauthorized: cfg.rejectUnauthorized,
      models: cfg.models,
      stripToolsFor: cfg.stripToolsFor ?? [],
      resolveCredentials: () => resolveCredentials(cfg),
      logger: {
        info: (...a) => log.info(...a),
        warn: (...a) => log.warn(...a),
        error: (...a) => log.error(...a)
      }
    });
    try {
      await factory.listen();
    } catch (err) {
      if (err?.code === "EADDRINUSE") {
        log.error(`gigachat: port ${cfg.port} is busy and does not answer /v1/models — stop the other service or change "gigachat.port"`);
      } else {
        log.error(`gigachat: proxy failed to start: ${err.message}`);
      }
      proxyServing = false;
      return;
    }
    proxy = factory;
    proxyFacts = JSON.stringify(networkFacts(cfg));
    proxyServing = true;
    registerCleanup(() => {
      if (proxy) { try { proxy.close(); } catch { /* ignore */ } proxy = null; }
    });
    log.info(`gigachat: built-in OAuth proxy listening at ${factory.address()}/v1/chat/completions (scope=${cfg.scope}, upstream=${cfg.upstreamBaseURL})`);
  }

  async function stopProxy() {
    if (!proxy) return;
    const p = proxy;
    proxy = null;
    proxyFacts = null;
    proxyServing = false;
    try { await p.close(); } catch { /* ignore */ }
  }

  let reconcileChain = Promise.resolve();
  function reconcile(reason) {
    reconcileChain = reconcileChain
      .then(() => doReconcile(reason))
      .catch((err) => log.error(`gigachat: reconcile failed: ${err.message}`));
    return reconcileChain;
  }

  async function doReconcile(reason) {
    if (disposed) return;
    const cfg = current();
    const facts = JSON.stringify(networkFacts(cfg));
    if (proxy && facts !== proxyFacts) {
      await stopProxy();
      proxyServing = false;
    }
    await startProxy(cfg);
    if (cfg.ensureRoute && cfg.providerId) {
      await bootstrapRoute(cfg);
    }
    void reason;
  }

  ctx.effect(function* () {
    yield () => {
      disposed = true;
      for (const fn of cleanupFns.reverse()) { try { fn(); } catch { /* ignore */ } }
      cleanupFns.length = 0;
    };
  });
}

export { Config, SettingsSchema, apply, inject, name };