import { createApp } from './app.js';
import { connectStore } from './store.js';

// API_PORT wins. In dev (--dev) PORT is ignored because tools that launch the
// whole stack often set PORT for the web dev server; hosts set PORT in production.
const isDev = process.argv.includes('--dev');
const port = Number(process.env.API_PORT) || (isDev ? 5000 : Number(process.env.PORT) || 5000);

await connectStore();
const { app, registry, config } = createApp();
app.listen(port, () => {
  const configured = registry.list().filter((p) => p.configured).map((p) => p.id);
  console.log(`[server] http://localhost:${port}/api/v1`);
  console.log(`[server] providers: ${configured.length ? configured.join(', ') : 'none (offline templates)'} · default: ${registry.defaultId()}`);
  console.log(`[server] API keys: ${config.apiKeys.length ? `${config.apiKeys.length} configured` : 'not required (set ENGINE_API_KEYS to require)'}`);
});
