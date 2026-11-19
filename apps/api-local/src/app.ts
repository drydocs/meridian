import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type Redis from "ioredis";
import { DEFAULT_ALLOWED_ORIGIN } from "@meridian/shared";
import { vaultsRoute } from "./routes/vaults.js";
import { positionsRoute } from "./routes/positions.js";
import { txRoute } from "./routes/tx.js";
import { keepersRoute } from "./routes/keepers.js";
import { adminRoute } from "./routes/admin.js";

export interface BuildAppOptions {
  logger?: boolean | object | undefined;
  redisClient?: Redis | undefined;
  enableRateLimit?: boolean | undefined;
  rateLimitMax?: number | undefined;
  rateLimitTimeWindow?: string | undefined;
  allowedOrigin?: string | undefined;
}

export async function buildApp(
  options: BuildAppOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 10 * 1024,
  });

  await app.register(cors, {
    origin:
      options.allowedOrigin ??
      process.env.ALLOWED_ORIGIN ??
      DEFAULT_ALLOWED_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
  });

  if (options.enableRateLimit !== false) {
    await app.register(rateLimit, {
      max: options.rateLimitMax ?? 100,
      timeWindow: options.rateLimitTimeWindow ?? "1 minute",
      ...(options.redisClient ? { redis: options.redisClient } : {}),
      errorResponseBuilder: () => ({
        statusCode: 429,
        error: "Too many requests. Try again in a minute.",
      }),
    });
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

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
