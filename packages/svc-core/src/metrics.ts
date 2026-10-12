import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import client from 'prom-client';

export { client as prom };

/** A fresh registry with the default process metrics. One per service process. */
export function createRegistry(service: string): client.Registry {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });
  return registry;
}

/** Minimal HTTP server exposing /metrics and /healthz for services that have no HTTP API of their own. */
export function startMetricsServer(
  registry: client.Registry,
  port: number,
  host = '0.0.0.0',
  health: () => Promise<{ ok: boolean } & Record<string, unknown>> | { ok: boolean } = () => ({ ok: true }),
  /** when set, GET /metrics requires `Authorization: Bearer <token>` (/healthz stays open for orchestrator probes) */
  token?: string,
): Server {
  const authorized = (header: string | undefined): boolean => {
    if (!token) return true;
    const given = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(token);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/metrics') {
        if (!authorized(req.headers.authorization)) {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { 'content-type': registry.contentType });
        res.end(await registry.metrics());
      } else if (req.url === '/healthz') {
        const h = await health();
        res.writeHead(h.ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify(h));
      } else {
        res.writeHead(404).end();
      }
    } catch {
      res.writeHead(500).end();
    }
  });
  server.listen(port, host);
  return server;
}
