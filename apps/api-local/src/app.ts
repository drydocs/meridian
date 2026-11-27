import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type Redis from "ioredis";
import { DEFAULT_ALLOWED_ORIGIN, MAX_BODY_BYTES } from "@meridian/shared";
import {
  createRequestId,
  REQUEST_ID_HEADER,
  responseBody,
} from "@meridian/api-core";
import { writeLog } from "@meridian/shared/logger";
import { vaultsRoute } from "./routes/vaults.js";
import { positionsRoute } from "./routes/positions.js";
import { txRoute } from "./routes/tx.js";
import { keepersRoute } from "./routes/keepers.js";
import { adminRoute } from "./routes/admin.js";
import { configRoute } from "./routes/config.js";
import { healthRoute } from "./routes/health.js";

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
    bodyLimit: MAX_BODY_BYTES,
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId: (req) =>
      createRequestId(req.headers[REQUEST_ID_HEADER.toLowerCase()]),
  });

  // Match the deployed handlers: an oversized body is a 413 with a stable code.
  app.setErrorHandler((error, _req, reply) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "FST_ERR_CTP_BODY_TOO_LARGE"
    ) {
      return reply.status(413).send({
        error: "Payload too large",
        code: "PAYLOAD_TOO_LARGE",
      });
    }
    // Keep the status of errors raised by plugins, such as the rate limiter,
    // which hands a plain object with a statusCode to the error handler.
    const status = (error as { statusCode?: number } | null)?.statusCode;
    if (typeof status === "number" && status >= 400) reply.status(status);
    return reply.send(error);
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
    allowedHeaders: ["Content-Type", REQUEST_ID_HEADER],
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

  // Every response carries the request ID, and error bodies use the shared
  // `{ error: { code, message, requestId } }` envelope like the deployed handlers.
  app.addHook("onSend", (req, reply, payload, done) => {
    reply.header(REQUEST_ID_HEADER, req.id);
    if (reply.statusCode < 400 || typeof payload !== "string") {
      done(null, payload);
      return;
    }
    try {
      done(
        null,
        JSON.stringify(
          responseBody(reply.statusCode, JSON.parse(payload), req.id)
        )
      );
    } catch {
      done(null, payload);
    }
  });

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
  app.register(healthRoute, { prefix: "/api/v1/health" });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
