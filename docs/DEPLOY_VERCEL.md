# Deploying to Vercel

One Vercel project serves both halves from the same domain:

```
https://prompt-generator-di6c.vercel.app/          → React UI (static files from dist/)
https://prompt-generator-di6c.vercel.app/api/v1/*  → Express API (serverless function api/index.js)
```

Because they share a domain, the UI calls `/api/v1/...` directly. There is nothing to "connect" and no CORS setup. The routing lives in [`vercel.json`](../vercel.json).

## 1. Create a MongoDB database (required)

Serverless functions don't keep memory between requests, so without a database your runs disappear while you're polling them.

1. Create a free cluster at https://cloud.mongodb.com (M0 is enough to start).
2. **Database Access** → add a user with a password.
3. **Network Access** → add `0.0.0.0/0`. Vercel has no fixed outbound IPs.
4. **Connect → Drivers** → copy the connection string and add a database name:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/prompt-generator?retryWrites=true&w=majority`

## 2. Vercel project settings

In Vercel → your project → **Settings**:

| Setting | Value |
|---|---|
| General → Root Directory | *(empty: the repository root)* |
| General → Framework Preset | Other |
| Build & Output overrides | Off (`vercel.json` sets install, build and output) |
| General → Node.js Version | 22.x (20.x also works) |
| Functions → Fluid Compute | On (default for new projects; needed for the 300 s limit below) |

## 3. Environment variables

Settings → **Environment Variables**. Add each for *Production* (and *Preview* if you use previews):

| Variable | Required | Example / notes |
|---|---|---|
| `MONGODB_URI` | **yes** | The Atlas string from step 1 |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / … | at least one, for AI output | Without any key the app runs on English-only templates |
| `LLM_PROVIDER` | no | Default provider, e.g. `gemini`. Empty = first configured |
| `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL` | no | Override the default model |
| `AGENT_CONCURRENCY` | no | Parallel LLM calls per run (default 3). Raise carefully: provider rate limits |
| `STALE_RUN_MS` | no | Default 360000 (6 min). A run with no progress for this long is marked failed |

Don't set:

- `PORT` or `API_PORT`: Vercel manages ports.
- `VITE_API_BASE_URL`: only for a split deployment (see the end of this guide).
- `ENGINE_API_KEYS` while you use the web UI: the UI has no way to send a key safely. Protect the site with Vercel instead (step 6).

Provider keys stay on the server. The browser never sees them.

## 4. Deploy

Commit and push to the branch Vercel watches (usually `main`). Environment-variable changes take effect only after a redeploy (Deployments → ⋯ → Redeploy).

## 5. Check it works

```bash
curl https://prompt-generator-di6c.vercel.app/api/v1/health
```

```bash
curl https://prompt-generator-di6c.vercel.app/api/v1/meta
```

`meta` should show `"store": "mongodb"`, `"serverless": true`, and your provider with `"configured": true`. Then open https://prompt-generator-di6c.vercel.app/. If the database is missing, the UI shows a red warning at the top.

## 6. Who can reach it

- `prompt-generator-di6c-<team>.vercel.app` URLs are behind **Vercel Authentication** (you must be logged in to Vercel). That's why the long URL redirects to a Vercel login.
- The production domain `prompt-generator-di6c.vercel.app` is **public**. Anyone who finds it can generate prompts on your provider account. Until user accounts exist (stage 5 of [ARCHITECTURE_AUDIT.md](ARCHITECTURE_AUDIT.md)), either:
  - turn on Deployment Protection for production (Settings → Deployment Protection; depending on your plan this is Vercel Authentication or Password Protection), or
  - at least set a monthly spending limit with your AI provider.

## 7. Serverless limits

| Limit | Effect |
|---|---|
| Function duration 300 s (`maxDuration` in `vercel.json`, Fluid Compute) | A run must finish within 5 minutes or it's marked failed. How many keywords fit depends on the provider's speed; start with small runs and measure. If Vercel rejects the deploy over `maxDuration`, your plan has a lower cap: set it to `60` |
| Response size 4.5 MB | Very large Excel/CSV exports can exceed this |
| Instances don't share memory | Progress and cancellation go through MongoDB, so they work across instances. The rate limiter is per instance |

Large, reliable batch processing needs the queue and worker design in [ARCHITECTURE_AUDIT.md](ARCHITECTURE_AUDIT.md): Redis + BullMQ workers on a host that runs long-lived processes (Railway, Render, Fly.io, a VM). The UI and API can stay on Vercel.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `FUNCTION_INVOCATION_FAILED` | Vercel → Deployments → the deployment → **Logs**. Usually a missing env var or a wrong Root Directory |
| Red "no database" banner | `MONGODB_URI` is missing, or Atlas Network Access is blocking Vercel: add `0.0.0.0/0`, then redeploy |
| "Run not found" while polling | Same as above: runs are stored in memory |
| Run fails with "stopped responding" | It hit the function time limit. Use fewer keywords per run |
| 404 on `/api/...` | Root Directory isn't the repo root, so `vercel.json` isn't applied |

## Alternative: separate frontend and backend projects

Only needed if you really want two Vercel projects.

- **Backend project:** root = repo root; remove the second rewrite from `vercel.json`; set `CORS_ORIGINS=https://<frontend-domain>`.
- **Frontend project:** root = `client`, framework Vite, env `VITE_API_BASE_URL=https://<backend-domain>`.

This setup gives you more to maintain and CORS to get right. The single project above is recommended.
