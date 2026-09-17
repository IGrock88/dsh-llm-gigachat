# dsh-llm-gigachat

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that connects **Sber GigaChat** models to the harness **without any manual YAML surgery** — the provider appears on the standard **Settings → Models** page, and an in-process OAuth proxy makes the connection work.

It packages everything the stand-alone `gigachat-proxy.mjs` script did (OAuth 2.0 client-credentials exchange, upstream request serialization for the personal plan's concurrency limit, the degenerate `"<"` answer guard, and legacy `functions`/`function_call` tool-calling translation) as a proper Cordis bundle plugin.

## What you get

- **Built-in OAuth proxy** — no separate process to keep running. The plugin starts an HTTP server (default `127.0.0.1:8787`) that exchanges `SBER_API_KEY` (= `base64(clientId:clientSecret)`) for a 30-minute access token, caches it, and proxies OpenAI-compatible `/v1/chat/completions` to `https://api.giga.chat/v1`.
- **Standard UI integration** — the plugin ensures an `llm-pi-ai` provider route (`sber`, default) pointing at the local proxy with the GigaChat model catalog. The route is written through `settings.mutate` **path operations only**, so no other provider's configuration is ever touched. `llm-pi-ai` then registers the route and the "Sber GigaChat" row in the **Models settings page** — store your key there, exactly like any other provider.
- **Hot-reload settings** — the `gigachat:` namespace is re-read per operation; change port/scope/upstream and the next request uses it.
- **Safety by construction** — the mount patch (`cordis.patch.yml`) only `insert`s this plugin's own row. The dsh patch engine **replaces** a targeted entry's config wholesale (no deep merge), so this plugin never patches any other entry — which is also the root cause of the "dsh won't boot after a plugin install" incidents and the thing to check first when debugging.

## Install

### Locally (development)

Put (or clone) the package under `~/.dsh/profiles/web/plugins/dsh-llm-gigachat`, then add it to the profile manifest and install:

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\web"

# 1. copy plugin sources
Copy-Item -Recurse ".\dsh-llm-gigachat" "$profile\plugins\dsh-llm-gigachat"

# 2. edit $profile\package.json — add to "dependencies":
#      "dsh-llm-gigachat": "file:./plugins/dsh-llm-gigachat"
#    and append "dsh-llm-gigachat" to "dsh.profile.bundles"

# 3. install
Push-Location $profile
pnpm install
Pop-Location
```

### From GitHub

```powershell
dsh plugin --profile web add "<your-github-spec>"   # e.g. git+https://github.com/<user>/dsh-llm-gigachat.git
```

As with any bundle, after installing you must also add the package name to `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json`, or append an `insert` row to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: llm-gigachat
      name: dsh-llm-gigachat
```

Then restart `dsh web` (or `dsh --profile web`).

### Verify before booting the full server

The config dump does **not** start dsh and prints the composed tree — use it as a safe smoke test after any plugin change:

```powershell
dsh --profile web --dump-config
```

You should see a row `id: llm-gigachat / name: dsh-llm-gigachat` and **no** changes to `llm-pi-ai` config in the dump.

## First-run setup (standard UI)

1. Start dsh (`dsh web`). The plugin starts the proxy and bootstraps the `sber` route.
2. Open **Settings → Models**.
3. Find the **Sber GigaChat** row. Click it, paste your GigaChat key — the value `base64(clientId:clientSecret)` from Sber Studio — into the **API key** field, and **Apply**.
4. Select `sber / GigaChat-3-Ultra` (or `-Pro`) as the model and chat.

No `.credentials.yaml` or `settings.yaml` edits needed. (Older standalone-proxy setups already have `SBER_API_KEY` in `~/.dsh/.credentials.yaml` — the plugin reads it through the same credential seam.)

## Configuration

All settings live in the `gigachat:` section of `~/.dsh/settings.yaml` (or through the host-plane plugin configuration UI when available):

```yaml
gigachat:
  enabled: true
  host: 127.0.0.1
  port: 8787            # proxy listen port; must match the sber route baseURL
  upstreamBaseURL: https://api.giga.chat/v1
  oauthURL: https://ngw.devices.sberbank.ru:9443/api/v2/oauth
  scope: GIGACHAT_API_PERS   # GIGACHAT_API_B2B / GIGACHAT_API_CORP for organizations
  apiKeyEnv: SBER_API_KEY
  providerId: sber
  displayName: Sber GigaChat
  maxConcurrency: 1
  tls:
    rejectUnauthorized: false   # NCC (НУЦ Минцифры) certificates by default
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
| `scope` | `GIGACHAT_API_PERS` | personal vs B2B/CORP access |
| `apiKeyEnv` | `SBER_API_KEY` | credential reference resolved through the dsh credentials seam |
| `providerId` | `sber` | the `llm-pi-ai.providers.*` route id + Models page row |
| `displayName` | `Sber GigaChat` | label shown by selector surfaces |
| `maxConcurrency` | `1` | upstream in-flight cap (personal plan ~1; raise with care) |
| `tls.rejectUnauthorized` | `false` | verify TLS (needs the Russian NCC root CA installed) |
| `models` | Ultra + Pro | catalog served by `/v1/models` and the route |

Notes:

- If the route `sber` already exists (e.g. from the old standalone-proxy setup) the plugin **does not overwrite it**, except to re-point its `baseURL` to the local proxy when it currently points at `127.0.0.1` on another port.
- If the port is already busy and answers `/v1/models`, the plugin assumes an external proxy is serving and does not start a second server.
- GigaChat is reached with TLS verification off by default because the Russian NCC (НУЦ Минцифры) CA chain is not usually present in Node's trust store on Windows. For hardening, install the NCC root certificate and set `tls.rejectUnauthorized: true`, or export `NODE_EXTRA_CA_CERTS`.

## Rollback / uninstall (read this first — there were incidents)

If anything goes wrong and `dsh` no longer starts after installing this (or any) plugin, the failure is almost always the **profile `package.json` / `cordis.patch.yml`**, not the harness itself. dsh never boots if a bundle listed in `dsh.profile.bundles` cannot be loaded.

### Normal uninstall (dsh still running fine)

```powershell
# remove the package from the profile (pnpm removes it from node_modules + package.json)
cd $env:USERPROFILE\.dsh\profiles\web
pnpm remove dsh-llm-gigachat
```

If installed via the CLI forwarder:

```powershell
dsh plugin --profile web remove dsh-llm-gigachat
```

Then remove the bundle entry (and any manual `insert` row you added to `cordis.patch.yml`), and restart dsh.

### Emergency rollback — dsh will not start (the known incident pattern)

1. Edit `~/.dsh/profiles/web/package.json` with any text editor:
   - delete the `"dsh-llm-gigachat": ...` line from `"dependencies"`;
   - delete `"dsh-llm-gigachat"` from the `dsh.profile.bundles` array.
2. If you edited `~/.dsh/profiles/web/cordis.patch.yml` by hand, remove the `llm-gigachat` insert block.
3. Reinstall deps and verify the tree **without starting dsh**:

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm install
dsh --profile web --dump-config   # must NOT contain llm-gigachat anymore
```

4. Start dsh again. If the profile still refuses to boot even without the plugin, the corruption is elsewhere: check for leftover `- id: <anything> config:` overrides in `cordis.patch.yml` that replace whole configs (e.g. `llm-pi-ai`), and compare with the dump.

### Cleanup of plugin-owned data (optional)

```yaml
# ~/.dsh/settings.yaml — remove these sections if you no longer use the plugin:
gigachat:                      # delete
llm-pi-ai:
  providers:
    sber:                      # delete only if the route was created by this plugin
```

The credential `SBER_API_KEY` in `~/.dsh/.credentials.yaml` can stay (it is harmless), or remove it if nothing else uses it.

## How it works (short)

```
harness LLM request → llm-pi-ai route sber → 127.0.0.1:8787 (this plugin's proxy)
    → OAuth token (SBER_API_KEY, cached 30 min) → api.giga.chat/v1/chat/completions
```

- The proxy serializes upstream calls (FIFO) so the personal-plan concurrency limit is not hit (symptom: HTTP 429).
- Degenerate replies of exactly `"<"` are transparently retried (symptom: model "answers" one character).
- Tool calling is translated to GigaChat's legacy `functions`/`function_call` format in both directions; non-JSON function results are JSON-wrapped (GigaChat returns 422/500 otherwise).
- Proxy health: `GET http://127.0.0.1:8787/stats` (served / rateLimited / serverErrors / degenerateRetries / toolCallsTranslated, queue depth).

## License

MIT