import {
  planMigrationKeeper,
  redactedErrorMessage,
} from "@meridian/stellar-sdk-helpers";
import type { RouteResult } from "./types";

/**
 * Shared read-only keeper planning handler. The Vercel route calls the SDK
 * directly; the local Fastify server uses this so both surfaces return the
 * same body and status code.
 */
export async function handleGetKeeperPlan(
  env: Record<string, string | undefined> = process.env
): Promise<RouteResult> {
  try {
    const result = await planMigrationKeeper(env);
    return {
      status: result.failures.length > 0 ? 500 : 200,
      body: result,
    };
  } catch (err) {
    return {
      status: 500,
      body: { error: redactedErrorMessage(err) },
      error: err,
    };
  }
}
