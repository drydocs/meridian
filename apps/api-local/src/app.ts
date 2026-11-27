import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type Redis from "ioredis";
import { writeLog } from "@meridian/shared/logger";
import { allowedOrigins, registerCors, REQUEST_ID_HEADER } from "./cors.js";
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

  if (options.logger) {
    app.addHook("onRequest", async (request) => {
      writeLog("info", "http.request", {
        requestId: request.id,
        method: request.method,
        route: request.url,
      });
    });
  }

  await registerCors(app, allowedOrigins(options.allowedOrigin));

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

  app.addHook("onSend", (request, reply, _payload, done) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload"
    );
    reply.header("Content-Security-Policy", "default-src 'none'");
    reply.header(REQUEST_ID_HEADER, request.id);
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
