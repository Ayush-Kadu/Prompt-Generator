# Architecture audit and implementation plan

Date: 2026-11-10 · Scope: the whole repository (`packages/engine`, `packages/providers`, `server`, `client`), measured against the 10 requirements in "Architecture and Scalability Requirements — Independent Prompt Generator".

**Verdict:** the prompt logic (engine modules) and provider adapters are a sound base and should be kept. The execution, persistence and security layers are prototype-grade. Today everything runs inside one API process, with an in-memory queue, one document per run and a shared static API key. No scalability claim is justified yet: nothing has been load-tested.

Legend: ✅ met · 🟡 partial · ❌ missing

---

## 1. Audit

### 1. Independence — 🟡

| Check | State | Evidence |
|---|---|---|
| Separate codebase, no runtime dependency on AI Search | ✅ | Nothing imports or calls AI Search. Logic was re-implemented from the description |
| Modular, reusable business logic | ✅ | `@promptgen/engine` has no HTTP, DB or provider code. Providers are a separate package |
| Separate database | 🟡 | Own MongoDB, but `server/src/store.js:12,21` **silently falls back to memory** when Mongo is missing or down. In production that loses data without warning |
| Deployment and environment config | ❌ | No Dockerfiles, no compose file, no environment validation, no deployment docs |

### 2. Asynchronous processing — ❌

| Check | State | Evidence |
|---|---|---|
| No thousands of keywords in one HTTP request | 🟡 | `/prompts/generate` is capped at 500 *prompts* (`server/src/api/v1.js:74`), but that could still be 500 keywords at 1 prompt each, processed inside the request |
| Redis + BullMQ | ❌ | `server/src/jobs.js:5-7` is an in-process array queue |
| Configurable batches | 🟡 | Batching exists, but `PROMPTS_PER_CALL = 20` (was 40) and `MAX_TOPUP_ROUNDS = 2` are hard-coded constants (`recommendations.js:15-16`) |
| Independently scalable workers | ❌ | Generation runs inside the API process |
| Persisted job and batch state | ❌ | Progress lives in an in-memory `Map`. Batches are never persisted; only the final run document is |

**Root cause:** `generateRecommendations()` (`packages/engine/src/modules/recommendations.js`) runs the whole job in one call: plan, all batches, top-up rounds, fallback. Its dedupe state is an in-memory `Set` (`:146`). A batch cannot be executed, retried or resumed on its own. **This is the central gap.**

### 3. Reliability — ❌

| Check | State | Evidence |
|---|---|---|
| Idempotent batches / no duplicates on retry | ❌ | Prompt IDs are `randomUUID()` (`:177,250`), so a re-run batch would create new rows. Dedupe is per process only |
| Exponential backoff | 🟡 | `withRetry` in `providers/src/base.js:48`: same policy for every provider, 2 retries, ignores the `Retry-After` header |
| Provider-specific retry policies | ❌ | |
| Failure isolation | 🟡 | A failed batch is logged and the run continues (good), but the run's other state lives in one process |
| Partial completion | ❌ | On failure or cancel, `jobs.js:56-60` marks the run failed and **discards every prompt already generated** |
| Cancellation | 🟡 | AbortController, but in-process only and it loses partial results |
| Crash recovery | ❌ | After a restart, runs stay `running` forever |
| Dead-letter handling | ❌ | |

### 4. AI provider architecture — 🟡

| Check | State | Evidence |
|---|---|---|
| Independent adapters | ✅ | 9 adapters behind one contract |
| Configurable model selection | 🟡 | Yes, but **any model string from the client is accepted**: no allowlist, so cost is unbounded |
| RPM / TPM / concurrency limits | ❌ | Concurrency is per run (`AGENT_CONCURRENCY`), so 2 runs × 3 = 6 parallel calls to the same provider. There is no global limiter |
| Token budgeting | ❌ | Fixed `maxTokens` per call, no per-job or per-tenant budget |
| Timeouts | ✅ | 120 s per call (`base.js:15`) |
| Cost tracking | 🟡 | Tokens are counted per run (`Usage` in `engine/src/llm.js`). There is no price table and no cost figure |
| No uncontrolled fallback | ✅ | No automatic fallback between providers |

### 5. Prompt intelligence — 🟡

| Check | State | Evidence |
|---|---|---|
| Keyword normalization | 🟡 | Case-insensitive, whitespace-trimmed dedupe only (`text.js` `uniqueStrings`). No unicode, plural or word-order handling |
| Semantic clustering | ❌ | |
| Intent detection and variations | ✅ | Model intent is validated, with a rule-based fallback (`categorization.js`). Variations are spread across intents and sentiment |
| Keyword → prompt traceability | 🟡 | A prompt stores the keyword *string*, with no `keywordId`, `batchId`, attempt or template version |
| Output validation and dedupe | ✅ | Lenient JSON parse, normalized-key dedupe, brand-leak rejection, quality scoring. Missing: a schema for model output and a language/script check |
| Versioned templates and config | ❌ | Only `ENGINE_VERSION = '1.0.0'` (`engine/src/index.js:32`). The system prompt and generation config are not versioned or stored with a run |

### 6. Database architecture — ❌

| Check | State | Evidence |
|---|---|---|
| Separate jobs / batches / keywords / prompts collections | ❌ | One `Run` document embeds every prompt (`models/Run.js:32`). At 10,000 prompts that's several MB, approaching the 16 MB limit |
| Indexes and unique constraints | ❌ | `_id` only |
| Bulk writes | ❌ | Only full-document updates |
| Cursor pagination | ❌ | `limit` only (`v1.js:111`). Prompts are returned all at once |
| No rewriting of large records | ❌ | `PUT /runs/:id/prompts` rewrites the whole prompt array on every save |

### 7. Frontend — 🟡

| Check | State |
|---|---|
| Async progress | ✅ Polling with a progress bar and log |
| Partial results and exports | ❌ Results appear only after the whole run finishes |
| Retry failed batches | ❌ Batches aren't visible at all |
| Cancel | ✅ |
| Filters: keyword, category, intent | ✅ |
| Filter: status | ❌ |

### 8. Security and cost — ❌

| Check | State | Evidence |
|---|---|---|
| Authentication | ❌ | One shared static key list, optional (`app.js:13`). No users |
| Authorization and tenant isolation | ❌ | Every caller sees every run |
| Credentials only on the backend | 🟡 | Provider keys are backend-only ✅, **but** `client/src/api.js:4` puts `VITE_ENGINE_API_KEY` into the browser bundle, which exposes the API key. This must go |
| Per-user quotas and limits | ❌ | Only global limits (`LIMITS`) |
| Token and cost tracking | 🟡 | Tokens yes, cost no, and nothing per user |
| Input validation and sanitization | ✅ | zod on every input, sandboxed user text, SSRF guard. Gap: DNS-rebinding race between the check and the fetch (`brandAnalysis.js:39`) |
| Rate limiting | 🟡 | In-memory (`middleware.js:24`), so it doesn't hold across instances |

### 9. Testing — ❌ for this list

29 tests exist: engine units, adapter request shapes, API happy paths. Coverage against the required list:

| Required | State |
|---|---|
| Batch processing | 🟡 in-process only |
| Concurrent jobs | ❌ |
| Provider rate-limit handling | 🟡 one adapter-level 429 retry test |
| Retry and idempotency | ❌ |
| Worker crash recovery | ❌ |
| Duplicate prevention | 🟡 in-run dedupe unit test |
| Database failure | ❌ |
| Large-scale ingestion | ❌ |
| Load tests | ❌, so **no scalability claims** |

### 10. Documentation — 🟡

README and `docs/API.md` exist. There are no deployment, queue-configuration or operations (DLQ, stuck jobs) docs.

### Keep as-is (don't rewrite)

- `packages/engine/src/modules/`: `categorization`, `qualityScoring`, `instructions`, `brandAnalysis`, `keywordExtraction`, `offlineTemplates`
- `packages/providers/src/adapters/*`, and `ProviderError` in `base.js`
- `server/src/exporters.js` (move to the streaming writer, keep the layout)
- Client components (extend, don't replace)

---

## 2. Target architecture

```
 Browser ──(session cookie)──▶ API (Express, stateless, N replicas)
                                 │  validate · authz · quota reserve · write job + keywords (bulk)
                                 ▼
                          MongoDB ◀──────────────┐     Redis (BullMQ queues + limiters + rate limits)
       jobs · batches · keywords · prompts ·     │       queues: plan → batch → finalize, dead-letter
       usage_events · users · tenants · api_keys │                 │
                                                 │                 ▼
                                        Workers (separate process, M replicas)
                                          plan: normalize + cluster keywords → batches
                                          batch: limiter → provider adapter → validate → bulk upsert prompts
                                          finalize: shortfalls → top-up batches | complete
```

Key decisions:

- **Idempotency through the database, not the code.** Prompt `_id` = hash(jobId, keywordId, normalizedText), plus a unique index on `{jobId, normKey}`. Bulk `insertMany({ordered:false})` ignores duplicate-key errors, so a batch that runs twice cannot create duplicates. BullMQ job id = batch id, so the same batch can't be queued twice.
- **The job document holds only counters**, updated with `$inc`. Prompts, keywords and batches live in their own collections and are paginated by cursor.
- **Batch-level engine API.** The engine gains `planJob()` and `executeBatch()`, both pure and deterministic given their inputs. The current `generate()` becomes a thin wrapper over them, so library users and the small sync endpoint keep working.
- **No automatic provider fallback.** A job is pinned to one provider and model from an allowlist.

## 3. Implementation plan

Each stage ends with passing tests and a working app.

| # | Stage | Changes | Tests that prove it | Size |
|---|---|---|---|---|
| 0 | **Foundations** | `docker-compose.yml` (Mongo replica set, Redis 7), env validation with zod and fail-fast (no silent memory fallback outside `NODE_ENV=test`), central config, test harness (`mongodb-memory-server`, Redis from compose or `REDIS_URL`) | Boots against compose; refuses to start without Mongo/Redis in production | S |
| 1 | **Data model** | Collections: `jobs`, `batches`, `keywords`, `prompts`, `usage_events`; indexes and unique constraints; repository layer replacing `store.js`; bulk writes; cursor pagination; job counters via `$inc` | Unique-index duplicate prevention, cursor pagination, bulk insert with partial duplicates, DB-unavailable error mapping | M |
| 2 | **Engine batch API** | Keyword normalizer (unicode, plurals, word order), lexical clustering, `planJob()` → batches (size configurable), `executeBatch()` with deterministic IDs and output schema validation, versioned template/config registry stamped on every job and prompt; `generate()` kept as a wrapper | Determinism (same input → same IDs), clustering, traceability fields, all existing engine tests still pass | M |
| 3 | **Queue and workers** | BullMQ queues `plan` / `batch` / `finalize` / `dead-letter`; `server/src/worker.js` entrypoint (`npm run worker`); batch state machine `pending → running → succeeded / failed / dead / cancelled`; leases plus BullMQ stalled-job detection; startup reconciler; cancellation; partial completion; top-up as new batches; sync endpoint capped by keyword count (≤ 25) | Concurrent jobs, kill a worker mid-batch → batch re-runs with no duplicates, cancel keeps partial results, a batch failing N times → DLQ, retry from DLQ | L |
| 4 | **Provider governance** | Per-provider retry policies (honour `Retry-After`; no retry for 400/401/403; capped exponential backoff with jitter for 5xx and timeouts); Redis-backed RPM, TPM and concurrency limiters per provider+model; token estimation before each call; per-job token budget; configurable price table → cost per call in `usage_events`; model allowlist | A fake provider returning 429 + Retry-After paces calls correctly; TPM limiter blocks over-budget calls; cost totals are correct; unknown model rejected | M |
| 5 | **Auth, tenancy, quotas** | Users (bcryptjs, pure JS; httpOnly session cookie for the UI), tenants, roles, hashed per-tenant API keys with scopes for other apps; every query scoped by `tenantId`; per-tenant quotas (prompts, tokens, cost / month, max keywords per job) reserved at job creation; Redis rate limiting; remove `VITE_ENGINE_API_KEY` | Tenant A can't read B's jobs; quota exceeded → 402/429; revoked key rejected | M |
| 6 | **API v2 + frontend** | Job, batch and prompt endpoints with cursor pagination and filters (keyword, category, intent, status); retry failed batches; streaming Excel/CSV export of partial results (ExcelJS streaming writer + Mongo cursor); UI job page: batch status table, live partial results, retry and cancel, status filter; login page | API contract tests; export of a partial job; UI checked in the browser | M |
| 7 | **Scale evidence** | Large-ingestion path (streamed CSV/XLSX upload → chunked `insertMany`); load-test harness (k6 or autocannon) against a fake LLM with configurable latency, error rate and 429s; report: keywords/min per worker, p95 batch latency, Mongo/Redis load, memory per worker, at 1, 2 and 4 workers | 50k-keyword ingestion within bounded memory; published report in `docs/LOAD_TEST.md`. **Scalability is claimed only from these numbers** | M |
| 8 | **Deployment docs** | Dockerfiles (api, worker, web), production compose example, env reference, queue tuning guide, scaling guide, runbook (DLQ triage, stuck jobs, provider outage, rotating keys) | A clean machine runs the documented commands successfully | S |

Recommended order: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Stages 4 and 5 can swap. Stage 7 must come after 3 and 4, because the numbers are meaningless without the real limiters.

## 4. Open decisions

| Decision | Recommendation | Why it matters |
|---|---|---|
| **Local infrastructure:** this machine has no Docker, Redis or MongoDB | Install Docker Desktop (with WSL 2) | BullMQ needs a real Redis (its Lua scripts don't run on mocks). Crash-recovery and DB-failure tests need real services. The alternative is cloud Redis and MongoDB Atlas dev instances via `REDIS_URL` / `MONGODB_URI` |
| Authentication | Built-in email/password plus per-tenant API keys now; SSO (Google / Microsoft) later | Must not depend on AI Search's identity system (Requirement 1) |
| Clustering method | Lexical (token overlap + normalized head terms) first; embeddings later behind a flag | Embeddings add a provider dependency and cost per keyword |
| Price table | Config file with your negotiated rates; no hard-coded public prices | Prices change; cost numbers must be ones you trust |
| Sync endpoint | Keep it for ≤ 25 keywords (quick API use); everything larger goes through jobs | Meets "never thousands in a single request" without breaking small integrations |

## 5. Risks

- **Windows Application Control** blocked a native Node module earlier (Rollup). Native-heavy dependencies (`argon2`, `bcrypt`) may be blocked too, so plan pure-JS alternatives (`bcryptjs`). `mongodb-memory-server` downloads `mongod.exe`, which may also be blocked; Docker sidesteps this.
- **Test duration:** crash-recovery and load tests are slow. Keep them in a separate `npm run test:integration` that needs Docker, and keep unit tests fast.
- **Migration:** existing runs in the single `runs` collection need a one-off migration script, or can be dropped since there is no production data yet.
