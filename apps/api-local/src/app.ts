import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type Redis from "ioredis";
import { DEFAULT_ALLOWED_ORIGIN } from "@meridian/shared";
import { writeLog } from "@meridian/shared/logger";
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

/**
 * Parse and validate ALLOWED_ORIGIN at startup.
 * Accepts comma-separated origins and rejects wildcards.
 */
function parseAllowedOrigins(raw: string): string[] {
  const origins = raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  // Reject wildcard origins
  for (const origin of origins) {
    if (origin === "*" || origin.includes("*")) {
      throw new Error(
        `ALLOWED_ORIGIN contains wildcard "${origin}". Wildcards are not permitted.`
      );
    }
  }

  return origins;
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
    origin: (origin, callback) => {
      const allowedOriginsRaw =
        options.allowedOrigin ??
        process.env.ALLOWED_ORIGIN ??
        DEFAULT_ALLOWED_ORIGIN;
      const allowedOrigins = parseAllowedOrigins(allowedOriginsRaw);

      // Allow requests with no origin (e.g., curl, server-to-server)
      if (!origin) {
        callback(null, true);
        return;
      }

      // Check if the request origin is in the allowed list
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"), false);
      }
    },
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
    // Add Vary: Origin for CORS caching
    if (!reply.hasHeader("Vary")) {
      reply.header("Vary", "Origin");
    }
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
