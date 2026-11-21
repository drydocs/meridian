import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import { DEFAULT_ALLOWED_ORIGIN, parseAllowedOrigins } from "@meridian/shared";

export async function registerCors(
  app: FastifyInstance,
  configuredOrigins?: string[]
): Promise<void> {
  const allowedOrigins =
    configuredOrigins ??
    parseAllowedOrigins(process.env.ALLOWED_ORIGIN, DEFAULT_ALLOWED_ORIGIN);

  app.addHook("onRequest", (request, reply, done) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      reply.code(403).send({ error: "Origin not allowed" });
      return;
    }
    done();
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, origin ? allowedOrigins.includes(origin) : false);
    },
    methods: ["GET", "POST", "OPTIONS"],
  });

  app.addHook("onSend", (_request, reply, _payload, done) => {
    reply.header("Vary", "Origin");
    done();
  });
}
