import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env.local first (developer overrides), then fall back to .env
config({ path: resolve(process.cwd(), "../../.env.local") });
config({ path: resolve(process.cwd(), "../../.env") });

import Fastify from "fastify";
import cors from "@fastify/cors";
import Redis from "ioredis";
import { DEFAULT_ALLOWED_ORIGIN } from "@meridian/shared";
import { vaultsRoute } from "./routes/vaults";
import { positionsRoute } from "./routes/positions";
import { txRoute } from "./routes/tx";
import { keepersRoute } from "./routes/keepers";
import { adminRoute } from "./routes/admin";
import { redisRateLimitStore, registerRateLimit } from "./rate-limit";

// Rate limits: the shared policy table from @meridian/api-core, so each route
// class (read / admin / tx build / tx submit / keeper) has its own budget
// instead of all routes competing for one bucket.
// Body limit: 10 KB on all routes to block oversized payload attacks.
// Security headers: X-Content-Type-Options and X-Frame-Options on every response.
const app = Fastify({ logger: true, bodyLimit: 10 * 1024 });

const redisClient = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : undefined;

await app.register(cors, {
  origin: process.env.ALLOWED_ORIGIN ?? DEFAULT_ALLOWED_ORIGIN,
  methods: ["GET", "POST", "OPTIONS"],
});
await registerRateLimit(app, {
  ...(redisClient ? { store: redisRateLimitStore(redisClient) } : {}),
  // A local server is a single process, so the in-memory fallback is a real
  // limiter here rather than the per-instance approximation it is on Vercel.
  requireDistributed: false,
});

app.addHook("onSend", (_req, reply, _payload, done) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  done();
});

app.register(vaultsRoute, { prefix: "/api/v1/vaults" });
app.register(positionsRoute, { prefix: "/api/v1/positions" });
app.register(txRoute, { prefix: "/api/v1/tx" });
app.register(keepersRoute, { prefix: "/api/v1/keepers" });
app.register(adminRoute, { prefix: "/api/v1/admin" });

app.get("/health", async () => ({ status: "ok" }));

try {
  await app.listen({ port: Number(process.env.PORT ?? 3001), host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
