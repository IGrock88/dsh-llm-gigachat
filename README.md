# dsh-llm-gigachat

English version: [README.en.md](README.en.md)

Плагин [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), который подключает **модели Сбера GigaChat** к harness «по-нормальному»: встроенный OAuth2-прокси + автоматическая настройка провайдера, который появляется на стандартной странице **Settings → Models** и выбирается обычным пикером моделей.

Без плагина GigaChat подключить «простой настройкой» нельзя: Sber использует **OAuth 2.0 Client Credentials** (двухшаговый обмен ключа на токен), а встроенные OpenAI-совместимые шлюзы harness такого не умеют — нужен код. Этот плагин содержит этот код (тот самый, что проверен в `gigachat-proxy.mjs`): обмен ключа на токен, кэш токена на 30 минут, сериализация запросов (личный тариф ≈ 1 одновременный запрос, иначе 429), прозрачный ретрай вырожденных ответов `"<"` и трансляция tool-calling в устаревший формат `functions`/`function_call`, который понимает GigaChat 3.

---

## Содержание

1. [Инструкция установки](#установка)
2. [Как добавить провайдера Sber и какой ключ куда вставлять](#как-подключить-провайдера-sber-gigachat-пошагово)
3. [OAuth2: что происходит под капотом](#oauth2-коротко)
4. [Конфигурация](#конфигурация)
5. [Откат / удаление плагина](#откат--удаление-плагина)
6. [Troubleshooting](#troubleshooting)

---

## Установка

### Вариант А. Из GitHub-репозитория

```powershell
dsh plugin --profile web add git+https://github.com/<ваш-аккаунт>/dsh-llm-gigachat.git
```

Затем добавьте плагин в список бандлов профиля `~/.dsh/profiles/web/package.json` → `dsh.profile.bundles`:

```jsonc
"dsh": {
  "profile": {
    "bundles": [
      // ... существующие ...
      "dsh-llm-gigachat"
    ]
  }
}
```

Перезапустите `dsh web`.

### Вариант Б. Локальная разработка (file:)

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\web"
# 1. скопировать исходники
Copy-Item -Recurse -Force ".\dsh-llm-gigachat" "$profile\plugins\dsh-llm-gigachat"

# 2. в package.json профиля добавить зависимость:
#      "dsh-llm-gigachat": "file:./plugins/dsh-llm-gigachat"
#    и "dsh-llm-gigachat" в dsh.profile.bundles

# 3. установить зависимости и перезапустить
Push-Location $profile
pnpm install
Pop-Location
# перезапустить dsh web
```

### Проверка БЕЗ запуска сервера (обязательно, безопасно)

Команда `--dump-config` **не стартует dsh** — только печатает собранное дерево конфигурации. В выводе должна появиться строка `id: llm-gigachat`, а конфиг `llm-pi-ai` должен остаться **нетронутым**:

```powershell
dsh --profile web --dump-config
```

> ⚠️ После установки dsh должен «взлететь» сразу. Если нет — см. раздел [Откат](#откат--удаление-плагина).

---

## Как подключить провайдера Sber GigaChat (пошагово)

### Шаг 1. Получите ключ OAuth2 в кабинете Sber

1. Зайдите в кабинет разработчика: **developers.sber.ru → GigaChat API** (или Sber Studio → раздел GigaChat).
2. Создайте приложение / подключите API. Кабинет выдаст **два значения**:
   - `client_id` и `client_secret`;
   - либо сразу готовый **«Ключ авторизации» / Authorization Key** — это и есть та строка, что нам нужна.
3. Уточните тип доступа, он задаёт `scope`:
   - физлицо → `GIGACHAT_API_PERS` (по умолчанию в плагине);
   - организация → `GIGACHAT_API_B2B` или `GIGACHAT_API_CORP`.

**Ключ авторизации** — это не сам ключ API, а строка `base64(client_id:client_secret)` (два поля, склеенные двоеточием и закодированные в base64). Если кабинет даёт только раздельные `client_id`/`client_secret`, соберите её сами:

```powershell
# PowerShell: base64("client_id:client_secret") — пример сборки
$pair = "client_id:client_secret"
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
Write-Host "Вставьте полученную строку как API key"
```

```bash
# или в bash:
printf 'client_id:client_secret' | base64
```

> Пример вида строки: `MTIzNDU2Nzg5MDEyMzQ1Njc4OjE2OjE3OjE` (у вас будет своя).

### Шаг 2. Вставьте ключ в harness

Самый простой и «штатный» способ — через стандартный интерфейс:

1. Запустите `dsh web`.
2. Откройте **Settings → Models**.
3. Найдите строку **Sber GigaChat** (её регистрирует плагин; у неё уже заполнены endpoint `http://127.0.0.1:8787/v1`, protocol и список моделей).
4. Нажмите на строку и в поле **API key** вставьте ключ из шага 1 (это значение `base64(client_id:client_secret)`).
5. Нажмите **Apply** (или «Сохранить»).

Что произойдёт внутри: ключ сохранится **только** в управляемом хранилище `~/.dsh/.credentials.yaml` (под именем `SBER_API_KEY`), а в настройки провайдера запишется ссылка `apiKeyEnv: SBER_API_KEY` — само значение в `settings.yaml` не попадёт.

Альтернатива без GUI (эквивалент):

```yaml
# ~/.dsh/.credentials.yaml
refs:
  SBER_API_KEY: "<base64(client_id:client_secret)>"
```

или переменная окружения перед запуском dsh:

```powershell
set SBER_API_KEY=<base64(client_id:client_secret)>
dsh web
```

### Шаг 3. Выберите модель и проверьте

1. В пикере модели (шапка чата) или в **Settings → Models** выберите: провайдер **sber**, модель `GigaChat-3-Ultra` (или `GigaChat-3-Pro`).
2. Отправьте сообщение. Должен прийти ответ модели.

Проверка «живости» прокси (плагин поднимает его на `127.0.0.1:8787`) и счётчики:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:8787/v1/models" -UseBasicParsing
Invoke-WebRequest -Uri "http://127.0.0.1:8787/stats" -UseBasicParsing
# stats: { served, rateLimited, serverErrors, degenerateRetries, toolCallsTranslated, queueDepth }
```

> Если на порту 8787 уже запущен внешний `gigachat-proxy.mjs` — плагин обнаружит его (`/v1/models` отвечает) и **не будет** поднимать второй сервер, а просто переиспользует существующий. Остановите внешний скрипт, чтобы прокси жил внутри harness.

---

## OAuth2: коротко

GigaChat не принимает статический ключ напрямую. Каждый запрос выглядит так:

```
1) POST https://ngw.devices.sberbank.ru:9443/api/v2/oauth
   Authorization: Basic <base64(client_id:client_secret)>   ← ваш ключ из шага 1
   RqUID: <uuid4>                                            ← свежий на каждый запрос
   body: scope=GIGACHAT_API_PERS
   → { access_token, expires_in: 1800 }                      ← живёт 30 минут

2) POST https://api.giga.chat/v1/chat/completions
   Authorization: Bearer <access_token>
   body: стандартный OpenAI JSON (stream / tools / …)
```

Плагин делает оба шага автоматически: достаёт ваш ключ из `SBER_API_KEY`, при первом запросе получает токен, кэширует его до истечения (минус запас), при `401` обновляет токен на лету. Плюс к этому:

- **Сериализация запросов** к api.giga.chat — личный тариф допускает ≈1 одновременный запрос, иначе `429` (отсюда был «шквал 429» при параллельных запросах раньше). Очередь FIFO, `maxConcurrency` по умолчанию 1.
- **Защита от `"<"`** — вырожденный ответ ровно в один символ `<` прозрачно повторяется до 2 раз.
- **Tool calling** — GigaChat 3 игнорирует современный `tools`/`tool_choice`, но понимает легаси `functions`/`function_call` (аргументы — объектом). Прокси транслирует запрос и ответ в обе стороны, а результат функции (не-JSON текст) оборачивает в JSON-строку (иначе 422/500).
- **TLS** — сертификаты НУЦ Минцифры не лежат в системном хранилище Node по умолчанию, поэтому проверка отключена (`tls.rejectUnauthorized: false`). Для усиления: установите корневой сертификат НУЦ и включите проверку.

---

## Конфигурация

Все настройки — секция `gigachat:` в `~/.dsh/settings.yaml` (хот-релоад, без перезапуска):

```yaml
gigachat:
  enabled: true
  host: 127.0.0.1
  port: 8787                # порт прокси; на него указывает роут sber
  upstreamBaseURL: https://api.giga.chat/v1
  oauthURL: https://ngw.devices.sberbank.ru:9443/api/v2/oauth
  scope: GIGACHAT_API_PERS  # GIGACHAT_API_B2B / GIGACHAT_API_CORP для организаций
  apiKeyEnv: SBER_API_KEY   # ссылка на креденшал (ключ base64)
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

| Поле | По умолчанию | Смысл |
|---|---|---|
| `enabled` | `true` | поднимать встроенный прокси |
| `host` / `port` | `127.0.0.1` / `8787` | адрес прокси; на него должен указывать роут |
| `upstreamBaseURL` | `https://api.giga.chat/v1` | базовый URL chat-completions |
| `oauthURL` | `https://ngw.devices.sberbank.ru:9443/api/v2/oauth` | первый эндпоинт токена (легаси) |
| `scope` | `GIGACHAT_API_PERS` | тип доступа (физлицо / организация) |
| `apiKeyEnv` | `SBER_API_KEY` | имя ссылки на креденшал |
| `providerId` | `sber` | id роута `llm-pi-ai.providers.*` и строки на странице Models |
| `displayName` | `Sber GigaChat` | подпись в селекторах |
| `maxConcurrency` | `1` | одновременных upstream-запросов (личный тариф ~1) |
| `tls.rejectUnauthorized` | `false` | проверять TLS (нужен корневой сертификат НУЦ) |
| `models` | Ultra + Pro | каталог для `/v1/models` и роута |

Особенности поведения:

- Если роут `sber` в `llm-pi-ai.providers` уже существует (например, от старого standalone-прокси), плагин его **не перезаписывает**; единственное исключение — база `baseURL` перенаправляется на локальный прокси, если сейчас она указывает на `127.0.0.1` с другого порта.
- Если порт занят и отвечает списком моделей — считаем, что работает внешний прокси, второй сервер не поднимаем.
- Роут создаётся через `settings.mutate` **path-операциями** — конфиг остальных провайдеров (`openrouter`, `local`, …) никогда не затрагивается.

---

## Откат / удаление плагина

> **Главное правило:** dsh перестаёт запускаться после установки плагина почти всегда из-за поломки манифеста `package.json` профиля или чужих `config:`-патчей, а не из-за harness. Наш плагин **никогда не патчит чужие строки**, поэтому откат тривиален.

### Штатное удаление (dsh работает)

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm remove dsh-llm-gigachat
```

или, если ставили через CLI:

```powershell
dsh plugin --profile web remove dsh-llm-gigachat
```

Затем удалите `"dsh-llm-gigachat"` из `dsh.profile.bundles` в `package.json` профиля и перезапустите `dsh web`.

### Аварийный откат (dsh НЕ запускается)

1. Любым редактором откройте `~/.dsh/profiles/web/package.json`:
   - удалите строку `"dsh-llm-gigachat": ...` из `dependencies`;
   - удалите `"dsh-llm-gigachat"` из `dsh.profile.bundles`.
2. Если вы вручную добавляли insert в `~/.dsh/profiles/web/cordis.patch.yml` — удалите блок `id: llm-gigachat`.
3. Переустановите зависимости и проверьте дерево **без запуска dsh**:

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm install
dsh --profile web --dump-config   # в выводе не должно быть llm-gigachat
```

4. Запустите dsh снова. Если профиль всё ещё не грузится даже без плагина — ищите в `cordis.patch.yml` строки вида `- id: <чужой> config:` (движок патчей **заменяет** конфиг целиком, не мержит — это и ломает конфиги вроде `llm-pi-ai`).

### Очистка данных плагина (опционально)

```yaml
# ~/.dsh/settings.yaml — удалить, если плагин больше не нужен
gigachat:               # удалить
# llm-pi-ai.providers.sber удалять ТОЛЬКО если роут создан этим плагином
# (у более ранних установок роут sber мог быть и вручную — тогда оставьте)
```

Запись `SBER_API_KEY` в `~/.dsh/.credentials.yaml` безвредна; удалите её, если ничто другое её не использует.

---

## Troubleshooting

| Симптом | Причина / решение |
|---|---|
| `502 {"error": "...no GigaChat credentials..."}` | Вставьте ключ на странице Models (или задайте `SBER_API_KEY` в `.credentials.yaml`/окружении) — см. шаг 1–2 выше |
| `401` при запросах | Токен протух между кэшем и запросом — плагин обновляет сам и повторяет; если повторяется постоянно — проверьте, что ключ действительно `base64(client_id:client_secret)` от того же приложения и с нужным `scope` |
| Шквал `429` | Личный тариф ≈1 одновременный запрос. Убедитесь, что включена сериализация (`maxConcurrency: 1`) и что нет второго внешнего прокси, конкурирующего с плагином |
| Модель «отвечает» одним символом `<` | Вырожденный ответ GigaChat под конкурентной нагрузкой — плагин повторяет прозрачно; счётчик `degenerateRetries` в `/stats` |
| Tool-calling не работает / «нет доступа к инструментам» | Ожидаемо для GigaChat 3: он понимает только легаси `functions`. Прокси транслирует сам; проверьте `toolCallsTranslated` в `/stats` |
| `500`/`422` на результатах функций | GigaChat валидирует содержимое функции как JSON; не-JSON текст плагин оборачивает сам — если приходит всё равно, проверьте, что до API дошла трансляция (`/stats`) |
| dsh не запускается после установки | [Аварийный откат](#аварийный-откат-dsh-не-запускается); проверьте манифест профиля и чужие `config:`-патчи |

---

## Лицензия

MIT