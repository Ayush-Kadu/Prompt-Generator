# Prompt Generation Engine

A reusable engine that turns a **brand profile, keywords and instructions** into the prompts real customers type into AI assistants, then categorizes, scores and exports them. It ships as:

- **`@promptgen/engine`**: the prompt intelligence. It has no provider code, no HTTP and no database.
- **`@promptgen/providers`**: adapters for OpenAI, Claude, Gemini, Groq, Mistral, DeepSeek, OpenRouter, Ollama and any OpenAI-compatible endpoint.
- **`server/`**: a versioned REST API (`/api/v1`) with API keys, async runs, MongoDB, and Excel/CSV/JSON export.
- **`client/`**: a React UI that uses the same public API as any other app.

```
                 ┌──────────────── @promptgen/engine ────────────────┐
 brand profile → │ brandAnalysis → keywordExtraction → recommendations│ → prompts
 keywords      → │      instructions (sandbox)   categorization        │   + category / intent / sentiment
 instructions  → │                               qualityScoring        │   + score / grade / flags
                 └───────────────────────┬────────────────────────────┘
                                         │ llm({ system, user, json }) → { text, usage }
                 ┌───────────────────────┴──── @promptgen/providers ───┐
                 │ openai · anthropic · gemini · groq · mistral · deepseek │
                 │ openrouter · ollama · custom (OpenAI-compatible)    │
                 └─────────────────────────────────────────────────────┘
       server (/api/v1, Mongo, jobs, export)  ←  React UI  ·  other apps
```

## Quick start

```bash
npm install
```

```bash
cp server/.env.example server/.env
```

```bash
npm run dev
```

Open http://localhost:5173 (UI). The API is at http://localhost:5000/api/v1.

- **No API key yet?** The engine runs in **offline mode** with deterministic templates (English only), so every feature works without a key. Add any provider key to `server/.env` to switch to AI generation. Users can pick any configured provider and model per run.
- **No MongoDB?** Runs are kept in memory until the server restarts. Set `MONGODB_URI` to persist them.
- **Tests:** `npm test` runs the engine, provider and API suites.
- **Production:** `npm run build`, then `npm start`. Express serves the built UI and uses `PORT`.

## Engine modules (`packages/engine/src/modules`)

| Module | What it does | Without an LLM |
|---|---|---|
| `brandAnalysis` | Fetches the website (SSRF-guarded, size and time limits), extracts title/meta/headings/text, builds a `BrandProfile`: industry, description, offerings, audience, location, competitors, keywords | Profile from page metadata |
| `keywordExtraction` | Non-branded keywords from the profile, site content and seed keywords. The brand name is always filtered out | Phrase-frequency extractor |
| `instructions` | Cleans user text (instruction, context, site content) and wraps it in sandbox tags, so it can steer topic, angle, audience or market but never the rules, counts or format | n/a |
| `recommendations` | Plan → batch (about 40 prompts per call) → generate → accept/reject → dedupe → top up shortfalls (2 rounds) → fallback, so no keyword is ever empty | Template generator |
| `categorization` | **Branded vs non-branded** from the text (name, aliases, domain), never the model's label. Intent and sentiment are kept from the model when valid, otherwise inferred by rules | Rules |
| `qualityScoring` | 0–100 score: keyword coverage 25, natural length 15, natural phrasing 15, specificity 15, uniqueness vs siblings 20, brand compliance 10. Gives a grade (A–D) and flags (`too-short`, `near-duplicate`, `brand-leak`, …). `minQualityScore` rejects and re-requests weak prompts | Same (deterministic) |

### Using the engine from another Node app

```js
import { createPromptEngine } from '@promptgen/engine';
import { createProviderRegistry } from '@promptgen/providers';

const llm = createProviderRegistry().get('gemini');          // or 'openai', 'anthropic', … or null = offline
const engine = createPromptEngine({ llm: llm?.complete });

const { prompts, stats } = await engine.generate({
  brand: { name: 'Sweet Crumbs', website: 'sweetcrumbs.in', competitors: ['Bakingo'] },
  keywords: ['custom cakes', 'eggless cakes'],
  brandMode: 'mixed', brandedRatio: 30,
  intents: ['commercial', 'comparison'], sentiment: 'mixed',
  location: 'Pune', language: 'Marathi', promptsPerKeyword: 10,
  instruction: 'Focus on same-day delivery', minQualityScore: 60,
});
```

Any function matching `llm({ system, user, json, maxTokens, signal }) → { text, usage }` works, so you can plug in your own gateway.

### Adding a provider

Add an adapter to `packages/providers/src/adapters/`: an object with `id`, `label`, `envKey`, `envModel`, `defaultModel`, `models` and `send({ apiKey, model, baseUrl, fetchImpl })`, where `send` returns `async (req) => ({ text, usage })`. Then register it in `ADAPTERS` in `packages/providers/src/index.js`. The engine does not change. Any OpenAI-compatible service also works with no code at all: set `CUSTOM_LLM_BASE_URL`.

## API

See [docs/API.md](docs/API.md) for every endpoint with curl examples. In short:

- `POST /api/v1/prompts/generate`: synchronous, up to 500 prompts.
- `POST /api/v1/runs`, then poll `GET /api/v1/runs/:id`: async, up to 10,000 prompts, persisted.
- `GET /api/v1/runs/:id/export?format=xlsx|csv|json`
- `POST /api/v1/brand/analyze`, `/keywords/extract`, `/prompts/categorize`, `/prompts/score`: each module on its own.
- Set `ENGINE_API_KEYS` to require `Authorization: Bearer <key>`.

## Languages

English, Hindi, Marathi, Bengali, Gujarati, Spanish, French, German, Portuguese, Italian, Dutch, Japanese, Arabic, Chinese (Simplified). The list lives in `packages/engine/src/constants.js`. Non-English output needs an AI provider; offline templates are English only.

## Notes

- On Windows with Application Control enabled, Rollup's native binary is blocked. The root `package.json` overrides it with `@rollup/wasm-node`, which does the same job.
