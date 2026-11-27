import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import { DEFAULT_ALLOWED_ORIGIN } from "@meridian/shared";

export const REQUEST_ID_HEADER = "X-Request-ID";

export function allowedOrigins(value = process.env.ALLOWED_ORIGIN): string[] {
  return (value ?? DEFAULT_ALLOWED_ORIGIN)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export async function registerCors(
  app: FastifyInstance,
  origins: string[]
): Promise<void> {
  await app.register(cors, {
    origin: origins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", REQUEST_ID_HEADER],
  });
}
