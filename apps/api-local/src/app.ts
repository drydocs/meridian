import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type Redis from "ioredis";
import { DEFAULT_ALLOWED_ORIGIN } from "@meridian/shared";
import {
  InMemoryRateLimitStore,
  RedisRateLimitStore,
  type RedisRateLimitClient,
} from "@meridian/api-core";
import { writeLog } from "@meridian/shared/logger";
import { registerRateLimit } from "./rate-limit.js";
import { vaultsRoute } from "./routes/vaults.js";
import { positionsRoute } from "./routes/positions.js";
import { txRoute } from "./routes/tx.js";
import { keepersRoute } from "./routes/keepers.js";
import { adminRoute } from "./routes/admin.js";
import { configRoute } from "./routes/config.js";

export interface BuildAppOptions {
  logger?: boolean | object | undefined;
  redisClient?: Redis | undefined;
  enableRateLimit?: boolean | undefined;
  allowedOrigin?: string | undefined;
}

// ioredis takes eval(script, numKeys, ...keysAndArgs); the store speaks the
// Upstash shape eval(script, keys, args), so both clients run the same script.
function rateLimitClient(redis: Redis): RedisRateLimitClient {
  return {
    eval: (script, keys, args) =>
      redis.eval(script, keys.length, ...keys, ...args),
  };
}

export async function buildApp(
  options: BuildAppOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 10 * 1024,
  });

  if (options.logger) {
    app.addHook("onRequest", async (request) => {
      writeLog("info", "http.request", {
        requestId: request.id,
        method: request.method,
        route: request.url,
      });
    });
  }

  await app.register(cors, {
    origin:
      options.allowedOrigin ??
      process.env.ALLOWED_ORIGIN ??
      DEFAULT_ALLOWED_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
  });

  if (options.enableRateLimit !== false) {
    registerRateLimit(
      app,
      options.redisClient
        ? new RedisRateLimitStore(rateLimitClient(options.redisClient))
        : new InMemoryRateLimitStore()
    );
  }

  app.addHook("onSend", (_req, reply, _payload, done) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload"
    );
    reply.header("Content-Security-Policy", "default-src 'none'");
    done();
  });

  app.register(vaultsRoute, { prefix: "/api/v1/vaults" });
  app.register(positionsRoute, { prefix: "/api/v1/positions" });
  app.register(txRoute, { prefix: "/api/v1/tx" });
  app.register(keepersRoute, { prefix: "/api/v1/keepers" });
  app.register(adminRoute, { prefix: "/api/v1/admin" });
  app.register(configRoute, { prefix: "/api/v1/config" });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
