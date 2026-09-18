# dsh-llm-gigachat

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that connects **Sber GigaChat** models to the harness the "proper" way: a built-in OAuth2 proxy plus automatic provider setup, so the provider shows up on the standard **Settings → Models** page and is selectable from the regular model picker.

Without this plugin you cannot connect GigaChat by pure configuration: Sber uses **OAuth 2.0 Client Credentials** (a two-step exchange of a key for a token), which the built-in OpenAI-compatible gateways of the harness do not implement — code is required. This plugin contains that code (the same logic proven in `gigachat-proxy.mjs`): key→token exchange, 30-minute token caching, request serialization (personal plans allow ≈1 concurrent request, otherwise HTTP 429), transparent retry of degenerate `"<"` answers, and tool-calling translation into the legacy `functions`/`function_call` format GigaChat 3 understands.

> **⚠️ Models matter:** only **`GigaChat-3-Ultra` and `GigaChat-3-Pro`** reliably handle agentic chat with tools. The lighter models (`GigaChat-3-Lightning`, `GigaChat-2*`) reject complex agent schemas (`422: Field 'properties.args.properties' is missing` — the proxy fixes that with schema sanitization) or **hallucinate tool calls** with invalid arguments — that is an unfixable limit of the model itself. That is why the plugin runs the lighter models **without tools** by default (text mode via `stripToolsFor`), while Ultra/Pro get the full agentic mode. To hand tools to a weaker model, remove it from `stripToolsFor`.

> Русская версия: [README.ru.md](README.ru.md) (Russian)

---

## Table of contents

1. [Install](#install)
2. [How to add the Sber provider and where to put the key](#how-to-connect-the-sber-gigachat-provider-step-by-step)
3. [OAuth2 under the hood](#oauth2-in-short)
4. [Configuration](#configuration)
5. [Rollback / uninstall](#rollback--uninstall)
6. [Troubleshooting](#troubleshooting)

---

## Install

### Option A. From npm (recommended)

```powershell
dsh plugin --profile web add dsh-llm-gigachat
```

This installs the npm package into the web profile. Then add the plugin to the profile's bundle list in `~/.dsh/profiles/web/package.json` → `dsh.profile.bundles`:

```jsonc
"dsh": {
  "profile": {
    "bundles": [
      // ... existing ...
      "dsh-llm-gigachat"
    ]
  }
}
```

Restart `dsh web`. Manual equivalent of the first step:

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add dsh-llm-gigachat
```

### Option B. From the GitHub repository (source, latest master)

```powershell
dsh plugin --profile web add git+https://github.com/igrock88/dsh-llm-gigachat.git
```

What happens under the hood: pnpm (invoked by the `dsh plugin` forwarder) clones the repository, builds the package from its sources, and installs it into the profile's `node_modules` — useful when you want the latest state of `master`.

Then add the plugin to the profile's bundle list in `~/.dsh/profiles/web/package.json` → `dsh.profile.bundles`:

```jsonc
"dsh": {
  "profile": {
    "bundles": [
      // ... existing ...
      "dsh-llm-gigachat"
    ]
  }
}
```

Restart `dsh web`.

### Option C. Local development (file:)

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\web"
# 1. copy the sources
Copy-Item -Recurse -Force ".\dsh-llm-gigachat" "$profile\plugins\dsh-llm-gigachat"

# 2. in the profile's package.json add the dependency:
#      "dsh-llm-gigachat": "file:./plugins/dsh-llm-gigachat"
#    and "dsh-llm-gigachat" to dsh.profile.bundles

# 3. install dependencies and restart
Push-Location $profile
pnpm install
Pop-Location
# restart dsh web
```

### Verify WITHOUT starting the server (mandatory, safe)

`--dump-config` does **not** start dsh — it only prints the composed configuration tree. The output must contain a row `id: llm-gigachat`, and the `llm-pi-ai` config must stay **untouched**:

```powershell
dsh --profile web --dump-config
```

> ⚠️ After installation dsh must boot right away. If it does not — see [Rollback](#rollback--uninstall).

---

## How to connect the Sber GigaChat provider (step by step)

### Step 1. Get the OAuth2 key from your Sber account

1. Open the developer dashboard: **developers.sber.ru → GigaChat API** (or Sber Studio → GigaChat section).
2. Create an app / enable the API. The dashboard gives you **two things**:
   - `client_id` and `client_secret`;
   - or a ready-made **Authorization Key** — that is exactly the string we need.
3. Know your access type, it defines `scope`:
   - individual → `GIGACHAT_API_PERS` (the plugin's default);
   - organization → `GIGACHAT_API_B2B` or `GIGACHAT_API_CORP`.

**The authorization key is not an API key** — it is `base64(client_id:client_secret)` (both fields joined with a colon and base64-encoded). If the dashboard gives you separate `client_id`/`client_secret`, build it yourself:

```powershell
# PowerShell: base64("client_id:client_secret")
$pair = "client_id:client_secret"
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
Write-Host "Paste this string as the API key"
```

```bash
# or bash:
printf 'client_id:client_secret' | base64
```

> Example of the resulting string: `MTIzNDU2Nzg5MDEyMzQ1Njc4OjE2OjE3OjE` (yours will differ).

### Step 2. Connect the provider and put the key in

Two scenarios — pick yours.

#### Option A. The plugin is installed (recommended)

The **Sber GigaChat** row already exists on the **Settings → Models** page — the plugin creates it with the endpoint `http://127.0.0.1:8787/v1`, the `openai-completions` protocol, and the model list pre-filled. Only the key is missing:

1. Run `dsh web`.
2. Open **Settings → Models**.
3. Click **Edit** on the **Sber GigaChat** row.
4. Paste the key from step 1 (the `base64(client_id:client_secret)` value) into the **API key** field.
5. Click **Apply**.

> ⚠️ Trying to create another provider with the id `sber` through "Add a custom provider" will be refused ("id already taken") — and that is correct: the provider is already connected by the plugin. Just use the existing row.

#### Option B. Without the plugin (external `gigachat-proxy.mjs` + standard UI)

If the plugin is not installed but the external proxy is running (port 8787), connect through the standard card:

1. **Settings → Models** → **+ Add a custom provider**.
2. **Provider ID**: `sber`
3. **Display name**: `Sber GigaChat` (or anything).
4. **Base URL**: `http://127.0.0.1:8787/v1` — the local proxy, **not** `https://api.giga.chat/v1/` (going direct is impossible: pi-ai does not perform the OAuth2 exchange for hand-declared routes — you would get `401`).
5. **API protocol**: `openai-completions`.
6. **API key**: the key from step 1.
7. **Models**: click **Fetch available models** — the proxy returns the list (`GigaChat-3-Ultra`, `GigaChat-3-Pro`); or **Add model** and enter an id manually (at least one model — the card will not save without it).
8. **Create provider**.

Keep `gigachat-proxy.mjs` running — without it the endpoint is dead.

In both options, what happens inside: the key is stored **only** in the managed store `~/.dsh/.credentials.yaml` (as `SBER_API_KEY`), and the provider profile gets a reference `apiKeyEnv: SBER_API_KEY` — the value itself never lands in `settings.yaml`.

Equivalent alternative without the GUI:

```yaml
# ~/.dsh/.credentials.yaml
refs:
  SBER_API_KEY: "<base64(client_id:client_secret)>"
```

or an environment variable before starting dsh:

```powershell
set SBER_API_KEY=<base64(client_id:client_secret)>
dsh web
```

### Step 3. Select the model and verify

1. In the model picker (chat header) or in **Settings → Models**, select provider **sber** and model `GigaChat-3-Ultra` (or `GigaChat-3-Pro`).
2. Send a message; the model should reply.

Proxy liveness and counters (the plugin serves it on `127.0.0.1:8787`):

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:8787/v1/models" -UseBasicParsing
Invoke-WebRequest -Uri "http://127.0.0.1:8787/stats" -UseBasicParsing
# stats: { served, rateLimited, serverErrors, degenerateRetries, toolCallsTranslated, queueDepth }
```

> If an external `gigachat-proxy.mjs` already runs on port 8787, the plugin detects it (`/v1/models` answers) and does **not** start a second server — it reuses the existing one. Stop the external script to keep the proxy inside the harness.

---

## OAuth2 in short

GigaChat does not accept a static key directly. Every request looks like this:

```
1) POST https://ngw.devices.sberbank.ru:9443/api/v2/oauth
   Authorization: Basic <base64(client_id:client_secret)>   ← your key from step 1
   RqUID: <uuid4>                                            ← fresh per request
   body: scope=GIGACHAT_API_PERS
   → { access_token, expires_in: 1800 }                      ← lives 30 minutes

2) POST https://api.giga.chat/v1/chat/completions
   Authorization: Bearer <access_token>
   body: standard OpenAI JSON (stream / tools / …)
```

The plugin does both steps automatically: it reads your key via `SBER_API_KEY`, obtains a token on the first request, caches it until expiry (minus a safety margin), and refreshes it on the fly on `401`. Additionally:

- **Request serialization** to api.giga.chat — personal plans allow ≈1 concurrent request, otherwise `429` (that is where the earlier "429 storm" during parallel requests came from). FIFO queue, `maxConcurrency` defaults to 1.
- **`"<"` guard** — a degenerate answer of exactly the character `<` is transparently retried up to 2 times.
- **Tool calling** — GigaChat 3 ignores modern `tools`/`tool_choice` but understands legacy `functions`/`function_call` (arguments as an OBJECT). The proxy translates the request and the response both ways and wraps a non-JSON function result into a JSON string (otherwise 422/500).
- **TLS** — the Russian NCC (НУЦ Минцифры) certificates are not in Node's default trust store on Windows, so verification is off (`tls.rejectUnauthorized: false`). For hardening, install the NCC root certificate and enable verification.

---

## Configuration

All settings live in the `gigachat:` section of `~/.dsh/settings.yaml` (hot-reload, no restart):

```yaml
gigachat:
  enabled: true
  host: 127.0.0.1
  port: 8787                # proxy port; the sber route points here
  upstreamBaseURL: https://api.giga.chat/v1
  oauthURL: https://ngw.devices.sberbank.ru:9443/api/v2/oauth
  scope: GIGACHAT_API_PERS  # GIGACHAT_API_B2B / GIGACHAT_API_CORP for organizations
  apiKeyEnv: SBER_API_KEY   # credential reference (the base64 key)
  providerId: sber
  displayName: Sber GigaChat
  maxConcurrency: 1
  tls:
    rejectUnauthorized: false
  models:
    - id: GigaChat-3-Ultra
      name: GigaChat 3 Ultra
    - id: GigaChat-3-Pro
      name: GigaChat 3 Pro
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | start the built-in proxy |
| `host` / `port` | `127.0.0.1` / `8787` | proxy listen address; the sber route points here |
| `upstreamBaseURL` | `https://api.giga.chat/v1` | GigaChat chat-completions base |
| `oauthURL` | `https://ngw.devices.sberbank.ru:9443/api/v2/oauth` | first token endpoint (legacy) |
| `scope` | `GIGACHAT_API_PERS` | access type (individual / organization) |
| `apiKeyEnv` | `SBER_API_KEY` | credential reference resolved through the dsh credentials seam |
| `providerId` | `sber` | the `llm-pi-ai.providers.*` route id and the Models page row |
| `displayName` | `Sber GigaChat` | label shown by selector surfaces |
| `maxConcurrency` | `1` | concurrent upstream requests (personal plan ~1) |
| `tls.rejectUnauthorized` | `false` | verify TLS (needs the Russian NCC root CA installed) |
| `stripToolsFor` | `GigaChat-3-Lightning`, `GigaChat-2-Max`, `GigaChat-2-Pro`, `GigaChat-2` | these models answer **without tools** by default (text mode): they reject complex agent schemas or hallucinate calls. Remove a model from the list to grant it tools; an empty list = tools for everyone |
| `models` | 6 GigaChat 2/3 chat models | default catalog; `GET /v1/models` returns the **live list from Sber** (chat models only, embedders filtered out) and falls back to this configured list when the API is unreachable |

Behaviour notes:

- **Tool-schema sanitization**: the proxy recursively injects `properties: {}` into every object node of function schemas — the lighter models (Lightning, GigaChat-2*) otherwise answer `422: Field 'properties.args.properties' is missing`. Ultra/Pro tolerated it anyway; after sanitization all models accept the schemas.
- **Model recommendations**: for agentic chats (with tools) use `GigaChat-3-Ultra` / `GigaChat-3-Pro` — the lighter models follow schemas poorly and may call tools at random; `stripToolsFor` is therefore enabled for them by default (text mode). If a listed model does need tools, remove it from `stripToolsFor` in the `gigachat:` section.

- If the `sber` route already exists in `llm-pi-ai.providers` (e.g. from the old standalone-proxy setup), the plugin does **not** overwrite it; the only exception is that `baseURL` is redirected to the local proxy when it currently points at `127.0.0.1` on another port.
- If the port is busy and answers with a model list, an external proxy is assumed and no second server is started.
- The route is created via `settings.mutate` **path operations** — the config of other providers (`openrouter`, `local`, …) is never touched.

---

## Rollback / uninstall

> **Golden rule:** after installing a plugin, dsh almost always fails to boot because of a broken profile `package.json` or third-party `config:` patches — not because of the harness. This plugin **never patches other entries**, so rollback is trivial.

### Normal uninstall (dsh runs fine)

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm remove dsh-llm-gigachat
```

or, when installed via the CLI forwarder:

```powershell
dsh plugin --profile web remove dsh-llm-gigachat
```

Then remove `"dsh-llm-gigachat"` from `dsh.profile.bundles` in the profile's `package.json` and restart `dsh web`.

### Emergency rollback (dsh does NOT start)

1. Open `~/.dsh/profiles/web/package.json` with any editor:
   - delete the `"dsh-llm-gigachat": ...` line from `dependencies`;
   - delete `"dsh-llm-gigachat"` from `dsh.profile.bundles`.
2. If you manually added an insert to `~/.dsh/profiles/web/cordis.patch.yml` — remove the `id: llm-gigachat` block.
3. Reinstall dependencies and verify the tree **without starting dsh**:

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm install
dsh --profile web --dump-config   # must NOT contain llm-gigachat anymore
```

4. Start dsh again. If the profile still refuses to boot even without the plugin, look for rows like `- id: <foreign> config:` in `cordis.patch.yml` (the patch engine **replaces** the target config wholesale, it does not merge — that is what breaks configs such as `llm-pi-ai`).

### Cleanup of plugin-owned data (optional)

```yaml
# ~/.dsh/settings.yaml — delete if the plugin is no longer needed
gigachat:               # delete
# llm-pi-ai.providers.sber delete ONLY if the route was created by this plugin
# (earlier setups may have added the sber route manually — keep it then)
```

The `SBER_API_KEY` record in `~/.dsh/.credentials.yaml` is harmless; delete it if nothing else uses it.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `502 {"error": "...no GigaChat credentials..."}` | Put the key into the Models page (or set `SBER_API_KEY` in `.credentials.yaml`/the environment) — see steps 1–2 above |
| Constant `401` on requests | Token expired between cache and request — the plugin refreshes and retries itself; if it persists, check that the key is really `base64(client_id:client_secret)` from the same app and uses the right `scope` |
| A barrage of `429` | Personal plans ≈1 concurrent request. Make sure serialization is on (`maxConcurrency: 1`) and no second external proxy competes with the plugin |
| The model "answers" with a single `<` | Degenerate GigaChat reply under concurrent load — the plugin retries transparently; watch `degenerateRetries` in `/stats` |
| Tool calling does not work / "no access to tools" | Expected for GigaChat 3: it only understands legacy `functions`. The proxy translates automatically; check `toolCallsTranslated` in `/stats` |
| `500`/`422` on function results | GigaChat validates function content as JSON; the plugin wraps non-JSON text itself — if it still happens, confirm the translation reached the API (`/stats`) |
| Chat error like `422 status code (no body)` | Usually the session history contains tool-calling turns GigaChat cannot re-validate in its legacy format → start a **new session** for this model. The proxy now returns an actionable error body (OpenAI-shaped `{"error":{...}}`) instead of an empty one |
| dsh does not start after install | [Emergency rollback](#emergency-rollback-dsh-does-not-start); check the profile manifest and foreign `config:` patches |

---

## License

MIT