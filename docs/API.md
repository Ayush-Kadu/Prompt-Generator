# Prompt Generation Engine — API v1

Base URL: `http://<host>:5000/api/v1`. All bodies are JSON.

**Auth:** when `ENGINE_API_KEYS` is set on the server, send `Authorization: Bearer <key>` (or `x-api-key: <key>`). `GET /health` is always open.
**Rate limit:** `RATE_LIMIT_PER_MINUTE` per key or IP. See the `X-RateLimit-*` headers; going over returns 429.
**Errors:** `{ "error": "...", "details": ["field: message"] }`. Status codes: 400 validation, 401 auth, 404 missing, 413 too big for sync, 429 rate limit, 502 the LLM provider failed.

## Choosing a provider

Every endpoint that calls a model accepts optional `"provider"` and `"model"`:

```json
{ "provider": "gemini", "model": "gemini-2.5-pro", ... }
```

`provider` is one of `openai`, `anthropic`, `gemini`, `groq`, `mistral`, `deepseek`, `openrouter`, `ollama`, `custom` or `offline`. If you leave it out, the server default is used. `GET /providers` shows which ones are configured.

## The generate request

| Field | Type | Default | Notes |
|---|---|---|---|
| `brand` | object | `{}` | `name`, `website`, `aliases[]`, `competitors[]`, `industry`, `description`, `location` |
| `keywords` | string[] | `[]` | Up to 2,000. Required unless `autoKeywords` is set |
| `autoKeywords` | int | 0 | When `keywords` is empty, extract this many from `brand.website` / `description` / `industry` |
| `analyzeWebsite` | bool | false | Analyse `brand.website` first, adding offerings, audience and competitors to the context |
| `brandMode` | `non-branded` \| `branded` \| `mixed` | `non-branded` | `branded`/`mixed` require `brand.name` |
| `brandedRatio` | 0–100 | 30 | Branded share in `mixed` mode |
| `intents` | string[] | all | `informational`, `commercial`, `transactional`, `comparison`, `local`, `review`, `navigational` |
| `sentiment` | `neutral` \| `positive` \| `negative` \| `mixed` | `neutral` | |
| `topic`, `location` | string | | |
| `language` | string | `English` | See `GET /meta` → `languages` |
| `languages` | string[] | `[]` | Several languages: the full set is generated once per language (each keyword's count × languages, counted against the limits). Overrides `language` when non-empty. `stats.byLanguage` gives the split |
| `context` | string ≤1500 | | Background about the business (sandboxed) |
| `instruction` | string ≤500 | | Steering, e.g. "focus on pricing" (sandboxed) |
| `promptsPerKeyword` | 1–25 | 5 | Default count for every keyword |
| `promptsByKeyword` | object | `{}` | Own count (1–25) for individual keywords, e.g. `{"custom cakes": 10, "cupcakes": 3}`. Keys match keywords case-insensitively; unknown keys are ignored; other keywords use `promptsPerKeyword`. The size limits count these numbers |
| `minQualityScore` | 0–100 | 0 | Prompts scoring lower are rejected and re-requested |

## Prompt object

```json
{
  "id": "uuid", "text": "which bakery in Pune does the best eggless custom cakes?",
  "keyword": "custom cakes", "category": "Non-branded",
  "intent": "commercial", "intentSource": "model", "sentiment": "neutral",
  "score": 90, "grade": "A", "flags": [],
  "topic": "", "location": "Pune", "language": "English",
  "source": "ai", "selected": true
}
```

`source` is `ai`, `template` (offline mode), `fallback` or `custom`.

## Endpoints

### Discovery

```bash
curl localhost:5000/api/v1/meta        # options, limits, languages, providers, score weights
curl localhost:5000/api/v1/providers   # { default, providers: [{ id, label, configured, defaultModel, models }] }
```

### Synchronous generation (≤ `MAX_SYNC_PROMPTS`, default 500)

```bash
curl -X POST localhost:5000/api/v1/prompts/generate \
  -H 'content-type: application/json' -H 'authorization: Bearer $KEY' \
  -d '{"provider":"anthropic","brand":{"name":"Sweet Crumbs","competitors":["Bakingo"]},
       "keywords":["custom cakes","eggless cakes"],"brandMode":"mixed","brandedRatio":30,
       "location":"Pune","language":"Marathi","promptsPerKeyword":10}'
```

The response has `prompts[]`, `keywords[]`, `profile`, `stats` (counts, duplicates, rejections, `averageScore`), `usage` (calls, tokens, latency), `warnings[]`, `provider` and `model`.

### Async runs (large jobs, persisted)

```bash
curl -X POST localhost:5000/api/v1/runs -H 'content-type: application/json' \
  -d '{"brand":{"name":"Acme","website":"acme.com"},"autoKeywords":50,"analyzeWebsite":true,"promptsPerKeyword":10}'
# → 202 { "runId": "...", "status": "queued", "statusUrl": "/api/v1/runs/<id>" }

curl localhost:5000/api/v1/runs/<id>            # status: queued | running | done | failed | cancelled (+ progress while running)
curl -X POST localhost:5000/api/v1/runs/<id>/cancel
curl localhost:5000/api/v1/runs                  # recent runs (summary)
curl -X PUT localhost:5000/api/v1/runs/<id>/prompts -d '{"prompts":[...]}'   # save edits / selection
curl -X DELETE localhost:5000/api/v1/runs/<id>
```

### Export

```bash
curl -o prompts.xlsx 'localhost:5000/api/v1/runs/<id>/export?format=xlsx'    # sheets: Prompts, Summary, Settings, Brand profile
curl -o prompts.csv  'localhost:5000/api/v1/runs/<id>/export?format=csv&all=1'
curl 'localhost:5000/api/v1/runs/<id>/export?format=json'
```

`POST /export` with `{ runId?, prompts, format, onlySelected }` exports an edited list without saving it first.

### Individual modules

```bash
# Brand & website analysis → { profile, warnings, usage }
curl -X POST localhost:5000/api/v1/brand/analyze -d '{"website":"sweetcrumbs.in","provider":"openai"}'

# Keyword extraction → { keywords: [{ keyword, type }], source, profile }
curl -X POST localhost:5000/api/v1/keywords/extract -d '{"brand":{"name":"Sweet Crumbs","website":"sweetcrumbs.in"},"seedKeywords":["custom cakes"],"limit":40}'

# Keyword import from Excel → { keywords: string[], counts: { keyword: n }, total, truncated, sheet }
# Send the .xlsx file itself as the body. Reads the first sheet with data: the column headed
# "Keyword" (or "Keywords", "Term", "Query"…) if row 1 has one, otherwise column A. Deduped, max 2,000. .xls is not supported.
# A "Prompts" (or "Count", "Number of prompts") column in row 1 fills `counts`, ready to send as promptsByKeyword.
curl -X POST localhost:5000/api/v1/keywords/import -H 'content-type: application/octet-stream' --data-binary @keywords.xlsx

# Categorize or score prompts generated anywhere (no LLM call)
curl -X POST localhost:5000/api/v1/prompts/categorize -d '{"brand":{"name":"Acme"},"prompts":[{"text":"Acme reviews"}]}'
curl -X POST localhost:5000/api/v1/prompts/score      -d '{"brand":{"name":"Acme"},"prompts":[{"text":"best crm for startups","keyword":"crm"}]}'
```

## Safety notes

- User text (`instruction`, `context`, website content) is sanitised and sent to the model only inside sandbox tags, never as system instructions.
- Website fetching refuses private, loopback and link-local addresses (re-checked on each redirect), caps responses at 1.5 MB and times out after 10 seconds.
- CSV export neutralises spreadsheet formula injection.
