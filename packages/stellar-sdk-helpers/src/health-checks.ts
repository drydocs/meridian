import { withRaceTimeout } from "@meridian/shared";
import { getRpcServer } from "./internal";
import type { PositionSnapshotStore } from "./position-snapshots";
import { trackedUsersKey } from "./position-snapshots";

export const HEALTH_CHECK_TIMEOUT_MS = 1_500;

/**
 * Verifies that the configured Soroban RPC endpoint can return its
 * latest ledger within the readiness timeout.
 */
export async function checkSorobanRpcHealth(
  rpcUrl: string,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS
): Promise<{ latestLedger: number }> {
  const server = getRpcServer(rpcUrl, timeoutMs);

  const latest = await withRaceTimeout(
    () => server.getLatestLedger(),
    timeoutMs,
    "Soroban RPC readiness check"
  );

  if (
    !latest ||
    typeof latest.sequence !== "number" ||
    !Number.isFinite(latest.sequence)
  ) {
    throw new Error("Soroban RPC returned an invalid latest ledger");
  }

  return { latestLedger: latest.sequence };
}

/**
 * Verifies Upstash Redis connectivity using a read-only PING command.
 * No application data is written or modified.
 */
export async function checkUpstashRedisHealth(options: {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const url = options.url.trim().replace(/\/+$/, "");
  const token = options.token.trim();
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!url || !token) {
    throw new Error("Upstash Redis credentials are not configured");
  }

  await withRaceTimeout(
    async () => {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["PING"]),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Upstash Redis returned HTTP ${response.status}`);
      }

      const body = (await response.json()) as {
        result?: unknown;
        error?: string;
      };

      if (body.error) {
        throw new Error(`Upstash Redis error: ${body.error}`);
      }

      if (body.result !== "PONG") {
        throw new Error("Upstash Redis returned an invalid PING response");
      }
    },
    timeoutMs,
    "Upstash Redis readiness check"
  );
}

/**
 * Reads the tracked-user registry used by the position snapshot keeper.
 * A count of zero is a healthy empty registry; this check never writes data.
 */
export async function checkPositionSnapshotStoreHealth(
  store: Pick<PositionSnapshotStore, "countTracked">,
  network: string,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS
): Promise<{ trackedUsers: number }> {
  const trackedUsers = await withRaceTimeout(
    () => store.countTracked(trackedUsersKey(network)),
    timeoutMs,
    "Position snapshot store readiness check"
  );
  if (!Number.isSafeInteger(trackedUsers) || trackedUsers < 0) {
    throw new Error(
      "Position snapshot store returned an invalid registry count"
    );
  }
  return { trackedUsers };
}
