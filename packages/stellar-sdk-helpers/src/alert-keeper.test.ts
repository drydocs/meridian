import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import {
  ALERTABLE_ACTIONS,
  formatAlertMessage,
  runAlertKeeper,
  alertCursorKey,
  createAlertWebhookSignature,
  verifyAlertWebhookSignature,
  isAlertWebhookSignatureValid,
  loadAlertKeeperConfig,
  ALERT_WEBHOOK_SIGNATURE_HEADER,
  ALERT_WEBHOOK_TIMESTAMP_HEADER,
  ALERT_WEBHOOK_DELIVERY_HEADER,
  type AlertKeeperConfig,
} from "./alert-keeper";
import { createInMemoryKeeperHeartbeatStore } from "./keeper-heartbeat";
import type { RpcAdminAction, RpcAdminActionType } from "./admin-history";
import type { StellarNetwork } from "./types";

const network: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const VAULT_CONTRACT_ID =
  "CBOE7JPROCMUKQ4NJWPKCLBBQGHLTGV4X3463DHK4D7KX6KWXGZETAJL";
const NEW_ADMIN = "GC7MCAT5QBXWXOUDN57SFAM3T353J7KMNVDRK4J5ZSILUJVRL7M3OUIN";
const NEW_ADAPTER = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
const OLD_ADAPTER = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const ALERT_KEEPER_RUNBOOK = readFileSync(
  new URL("../../../apps/docs/operations/alert-keeper.md", import.meta.url),
  "utf8"
);
const ALERT_EXAMPLES: Record<RpcAdminActionType, RpcAdminAction> = {
  paused: {
    action: "paused",
    ledgerSequence: 300,
    payload: { paused: true },
  },
  transfer: {
    action: "transfer",
    ledgerSequence: 300,
    payload: { newAdmin: NEW_ADMIN },
  },
  accept: {
    action: "accept",
    ledgerSequence: 300,
    payload: { newAdmin: NEW_ADMIN },
  },
  adapter: {
    action: "adapter",
    ledgerSequence: 300,
    payload: { newAdapter: NEW_ADAPTER },
  },
  migrate: {
    action: "migrate",
    ledgerSequence: 300,
    payload: { oldAdapter: OLD_ADAPTER, newAdapter: NEW_ADAPTER },
  },
  mig_begin: {
    action: "mig_begin",
    ledgerSequence: 300,
    payload: { newAdapter: NEW_ADAPTER, earliestLedger: 17380 },
  },
};

function adminEvent(
  action: string,
  value: xdr.ScVal,
  ledger = 100,
  eventIndex = 0
): rpc.Api.EventResponse {
  return {
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-09-01T00:00:00Z",
    id: `${ledger}-${eventIndex}`,
    pagingToken: `${ledger}-${eventIndex}`,
    topic: [xdr.ScVal.scvSymbol("admin"), xdr.ScVal.scvSymbol(action)],
    value,
    inSuccessfulContractCall: true,
    txHash: "HASH",
  } as unknown as rpc.Api.EventResponse;
}

function mockAdminEvents(
  events: rpc.Api.EventResponse[],
  latestLedger: number
) {
  return vi
    .spyOn(rpc.Server.prototype, "getEvents")
    .mockImplementation(async (request) => {
      const startLedger =
        "startLedger" in request ? (request.startLedger ?? 0) : 0;
      return {
        events: events.filter((event) => event.ledger >= startLedger),
        latestLedger,
      } as never;
    });
}

function baseConfig(
  overrides: Partial<AlertKeeperConfig> = {}
): AlertKeeperConfig {
  return {
    network,
    webhookUrl: "https://hooks.example.com/webhook",
    webhookSecret: "test-webhook-secret",
    maxAttempts: 1,
    baseDelayMs: 0,
    ...overrides,
    rpcTimeoutMs: overrides.rpcTimeoutMs ?? 5_000,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatAlertMessage", () => {
  const at = (action: RpcAdminAction) =>
    formatAlertMessage("meridian-usdc", action);

  it("formats a paused event", () => {
    expect(
      at({ action: "paused", ledgerSequence: 5, payload: { paused: true } })
    ).toContain("PAUSED");
    expect(
      at({ action: "paused", ledgerSequence: 5, payload: { paused: false } })
    ).toContain("unpaused");
  });

  it("formats a transfer event", () => {
    const msg = at({
      action: "transfer",
      ledgerSequence: 5,
      payload: { newAdmin: NEW_ADMIN },
    });
    expect(msg).toContain("admin transfer nominated");
    expect(msg).toContain(NEW_ADMIN.slice(0, 8));
  });

  it("formats an adapter event", () => {
    const msg = at({
      action: "adapter",
      ledgerSequence: 5,
      payload: { newAdapter: NEW_ADAPTER },
    });
    expect(msg).toContain("adapter switched");
  });

  it("formats a migrate event", () => {
    const msg = at({
      action: "migrate",
      ledgerSequence: 5,
      payload: { oldAdapter: OLD_ADAPTER, newAdapter: NEW_ADAPTER },
    });
    expect(msg).toContain("migrated adapter");
  });

  it("formats a mig_begin event with target adapter and earliest ledger", () => {
    const msg = at({
      action: "mig_begin",
      ledgerSequence: 5,
      payload: { newAdapter: NEW_ADAPTER, earliestLedger: 17380 },
    });
    expect(msg).toContain("migration cooldown started");
    expect(msg).toContain(NEW_ADAPTER.slice(0, 8));
    expect(msg).toContain("17380");
  });
});

describe("alert keeper runbook", () => {
  it.each([...ALERTABLE_ACTIONS])(
    "documents the exact payload message for %s",
    (action) => {
      const message = formatAlertMessage(
        "meridian-usdc",
        ALERT_EXAMPLES[action]
      );
      expect(ALERT_KEEPER_RUNBOOK).toContain(message);
    }
  );
});

describe("runAlertKeeper", () => {
  const target = {
    vaultId: "meridian-usdc",
    vaultContractId: VAULT_CONTRACT_ID,
  };

  it("starts from the current ledger when no cursor is stored, without alerting on history", async () => {
    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValueOnce({
      id: "x",
      sequence: 500,
      protocolVersion: "22",
    });
    const getEventsSpy = vi
      .spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValueOnce({ events: [], latestLedger: 500 } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    const fetchImpl = vi.fn();

    const result = await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl,
    });

    const [request] = getEventsSpy.mock.calls[0]!;
    expect((request as { startLedger?: number }).startLedger).toBe(500);
    expect(result.alertsSent).toEqual([]);
    expect(
      await cursorStore.get(alertCursorKey(VAULT_CONTRACT_ID, "testnet"))
    ).toBe(500);
  });

  it("uses the stored cursor and never calls getLatestLedger when one exists", async () => {
    const getLatestLedgerSpy = vi.spyOn(
      rpc.Server.prototype,
      "getLatestLedger"
    );
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [],
      latestLedger: 500,
    } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(alertCursorKey(VAULT_CONTRACT_ID, "testnet"), 200);

    await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl: vi.fn(),
    });

    expect(getLatestLedgerSpy).not.toHaveBeenCalled();
  });

  it("sends an alert for a qualifying action and advances the cursor past it", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [adminEvent("paused", xdr.ScVal.scvBool(true), 300)],
      latestLedger: 300,
    } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(alertCursorKey(VAULT_CONTRACT_ID, "testnet"), 200);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    const result = await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://hooks.example.com/webhook");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.text).toContain("PAUSED");
    expect(body.content).toBe(body.text);

    expect(result.alertsSent).toEqual([
      { vaultId: "meridian-usdc", action: "paused", ledgerSequence: 300 },
    ]);
    expect(
      await cursorStore.get(alertCursorKey(VAULT_CONTRACT_ID, "testnet"))
    ).toBe(301);
  });

  it("sends an alert for a mig_begin action and advances the cursor past it", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [
        adminEvent(
          "mig_begin",
          xdr.ScVal.scvVec([
            Address.fromString(NEW_ADAPTER).toScVal(),
            xdr.ScVal.scvU32(17380),
          ]),
          300
        ),
      ],
      latestLedger: 300,
    } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(alertCursorKey(VAULT_CONTRACT_ID, "testnet"), 200);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    const result = await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://hooks.example.com/webhook");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.text).toContain("migration cooldown started");
    expect(body.text).toContain("17380");
    expect(body.content).toBe(body.text);

    expect(result.alertsSent).toEqual([
      { vaultId: "meridian-usdc", action: "mig_begin", ledgerSequence: 300 },
    ]);
    expect(
      await cursorStore.get(alertCursorKey(VAULT_CONTRACT_ID, "testnet"))
    ).toBe(301);
  });

  it("does not alert on an accept_admin event but still advances past it", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [
        adminEvent("accept", Address.fromString(NEW_ADMIN).toScVal(), 300),
      ],
      latestLedger: 300,
    } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(alertCursorKey(VAULT_CONTRACT_ID, "testnet"), 200);
    const fetchImpl = vi.fn();

    const result = await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.alertsSent).toEqual([]);
    expect(
      await cursorStore.get(alertCursorKey(VAULT_CONTRACT_ID, "testnet"))
    ).toBe(301);
  });

  it("stops the cursor at the last successful action when a send fails", async () => {
    const getEventsSpy = mockAdminEvents(
      [
        adminEvent("paused", xdr.ScVal.scvBool(true), 300),
        adminEvent("adapter", Address.fromString(NEW_ADAPTER).toScVal(), 310),
      ],
      310
    );

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(alertCursorKey(VAULT_CONTRACT_ID, "testnet"), 200);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl,
    });

    expect(result.alertsSent).toEqual([
      { vaultId: "meridian-usdc", action: "paused", ledgerSequence: 300 },
    ]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      vaultId: "meridian-usdc",
      stage: "send",
    });
    // Cursor stops at 301 (past the succeeded paused event), not 311, so the
    // failed adapter event is retried on the next run.
    expect(
      await cursorStore.get(alertCursorKey(VAULT_CONTRACT_ID, "testnet"))
    ).toBe(301);

    const retry = await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl,
    });

    expect(getEventsSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startLedger: 301 })
    );
    expect(retry.alertsSent).toEqual([
      { vaultId: target.vaultId, action: "adapter", ledgerSequence: 310 },
    ]);
    expect(retry.failures).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(
      await cursorStore.get(alertCursorKey(VAULT_CONTRACT_ID, "testnet"))
    ).toBe(311);
  });

  it.each(["paused", "accept"] as const)(
    "retries a failed same-ledger alert after %s on the next run",
    async (precedingAction) => {
      const getEventsSpy = mockAdminEvents(
        [
          adminEvent(
            precedingAction,
            precedingAction === "paused"
              ? xdr.ScVal.scvBool(true)
              : Address.fromString(NEW_ADMIN).toScVal(),
            300
          ),
          adminEvent(
            "adapter",
            Address.fromString(NEW_ADAPTER).toScVal(),
            300,
            1
          ),
          adminEvent(
            "transfer",
            Address.fromString(NEW_ADMIN).toScVal(),
            300,
            2
          ),
          adminEvent("paused", xdr.ScVal.scvBool(false), 310),
        ],
        310
      );
      const key = alertCursorKey(VAULT_CONTRACT_ID, "testnet");
      const cursorStore = createInMemoryKeeperHeartbeatStore();
      await cursorStore.set(key, 200);
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
      const earlierAlerts =
        precedingAction === "paused"
          ? [{ vaultId: target.vaultId, action: "paused", ledgerSequence: 300 }]
          : [];
      if (precedingAction === "paused") {
        fetchImpl.mockResolvedValueOnce({ ok: true });
      }
      fetchImpl.mockResolvedValueOnce({ ok: false, status: 500 });
      const deps = { targets: [target], cursorStore, fetchImpl };

      const firstRun = await runAlertKeeper(baseConfig(), deps);

      expect(firstRun.alertsSent).toEqual(earlierAlerts);
      expect(firstRun.failures).toEqual([
        expect.objectContaining({
          vaultId: target.vaultId,
          stage: "send",
          attempts: 1,
        }),
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(earlierAlerts.length + 1);
      expect(await cursorStore.get(key)).toBe(300);

      fetchImpl.mockClear();
      const secondRun = await runAlertKeeper(baseConfig(), deps);

      expect(getEventsSpy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ startLedger: 300 })
      );
      // Replaying the failed ledger can repeat its earlier successful alert.
      expect(secondRun.alertsSent).toEqual([
        ...earlierAlerts,
        { vaultId: target.vaultId, action: "adapter", ledgerSequence: 300 },
        { vaultId: target.vaultId, action: "transfer", ledgerSequence: 300 },
        { vaultId: target.vaultId, action: "paused", ledgerSequence: 310 },
      ]);
      expect(secondRun.failures).toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(earlierAlerts.length + 3);
      expect(await cursorStore.get(key)).toBe(311);
    }
  );

  it("advances past a successful same-ledger batch without replaying it", async () => {
    const getEventsSpy = mockAdminEvents(
      [
        adminEvent("paused", xdr.ScVal.scvBool(true), 300),
        adminEvent("accept", Address.fromString(NEW_ADMIN).toScVal(), 300, 1),
        adminEvent(
          "adapter",
          Address.fromString(NEW_ADAPTER).toScVal(),
          300,
          2
        ),
      ],
      310
    );
    const key = alertCursorKey(VAULT_CONTRACT_ID, "testnet");
    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(key, 200);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const deps = { targets: [target], cursorStore, fetchImpl };

    const firstRun = await runAlertKeeper(baseConfig(), deps);

    expect(firstRun.alertsSent).toEqual([
      { vaultId: target.vaultId, action: "paused", ledgerSequence: 300 },
      { vaultId: target.vaultId, action: "adapter", ledgerSequence: 300 },
    ]);
    expect(firstRun.failures).toEqual([]);
    expect(await cursorStore.get(key)).toBe(301);

    const secondRun = await runAlertKeeper(baseConfig(), deps);

    expect(getEventsSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startLedger: 301 })
    );
    expect(secondRun.alertsSent).toEqual([]);
    expect(secondRun.failures).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await cursorStore.get(key)).toBe(301);
  });

  it("keeps the starting cursor when the first alert exhausts its retries", async () => {
    mockAdminEvents([adminEvent("paused", xdr.ScVal.scvBool(true), 300)], 300);
    const key = alertCursorKey(VAULT_CONTRACT_ID, "testnet");
    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(key, 200);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("webhook down"));

    const result = await runAlertKeeper(baseConfig({ maxAttempts: 2 }), {
      targets: [target],
      cursorStore,
      fetchImpl,
    });

    expect(result.alertsSent).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        stage: "send",
        attempts: 2,
        error: "webhook down",
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await cursorStore.get(key)).toBe(200);
  });

  it("records a discover failure and leaves the cursor untouched", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockRejectedValueOnce(
      new Error("RPC down")
    );

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(alertCursorKey(VAULT_CONTRACT_ID, "testnet"), 200);

    const result = await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl: vi.fn(),
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      vaultId: "meridian-usdc",
      stage: "discover",
    });
    expect(
      await cursorStore.get(alertCursorKey(VAULT_CONTRACT_ID, "testnet"))
    ).toBe(200);
  });

  it("checks every vault independently", async () => {
    const secondTarget = {
      vaultId: "meridian-eurc",
      vaultContractId:
        "CDIFFERENTVAULTCONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    };
    vi.spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValueOnce({
        events: [adminEvent("paused", xdr.ScVal.scvBool(true), 300)],
        latestLedger: 300,
      } as never)
      .mockResolvedValueOnce({ events: [], latestLedger: 300 } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(
      alertCursorKey(target.vaultContractId, "testnet"),
      200
    );
    await cursorStore.set(
      alertCursorKey(secondTarget.vaultContractId, "testnet"),
      200
    );
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    const result = await runAlertKeeper(baseConfig(), {
      targets: [target, secondTarget],
      cursorStore,
      fetchImpl,
    });

    expect(result.vaultsChecked).toBe(2);
    expect(result.alertsSent).toHaveLength(1);
  });

  it("attaches valid signature, timestamp, and delivery headers to webhook POSTs", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [adminEvent("paused", xdr.ScVal.scvBool(true), 300)],
      latestLedger: 300,
    } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(alertCursorKey(VAULT_CONTRACT_ID, "testnet"), 200);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const secret = "super-secret-signing-key";

    await runAlertKeeper(baseConfig({ webhookSecret: secret }), {
      targets: [target],
      cursorStore,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    const body = (init as { body: string }).body;

    expect(headers[ALERT_WEBHOOK_SIGNATURE_HEADER]).toMatch(
      /^sha256=[a-f0-9]{64}$/
    );
    expect(headers[ALERT_WEBHOOK_TIMESTAMP_HEADER]).toBeDefined();
    expect(headers[ALERT_WEBHOOK_DELIVERY_HEADER]).toBeDefined();

    const verification = verifyAlertWebhookSignature(headers, body, secret);
    expect(verification.valid).toBe(true);
  });

  it("sends an unsigned alert when no secret is configured, as local development does", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [adminEvent("paused", xdr.ScVal.scvBool(true), 300)],
      latestLedger: 300,
    } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(alertCursorKey(VAULT_CONTRACT_ID, "testnet"), 200);
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 })
    );

    const result = await runAlertKeeper(
      baseConfig({ webhookSecret: undefined }),
      {
        targets: [target],
        cursorStore,
        fetchImpl,
      }
    );

    expect(result.failures).toEqual([]);
    expect(result.alertsSent).toHaveLength(1);
    const init = fetchImpl.mock.calls[0]?.[1] as {
      headers: Record<string, string>;
    };
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers[ALERT_WEBHOOK_SIGNATURE_HEADER]).toBeUndefined();
    expect(init.headers[ALERT_WEBHOOK_TIMESTAMP_HEADER]).toBeUndefined();
    expect(init.headers[ALERT_WEBHOOK_DELIVERY_HEADER]).toBeUndefined();
  });
});

describe("loadAlertKeeperConfig", () => {
  it("throws when MERIDIAN_ALERT_WEBHOOK_URL is missing", () => {
    expect(() => loadAlertKeeperConfig({})).toThrow(
      "MERIDIAN_ALERT_WEBHOOK_URL is required"
    );
  });

  it("loads config in local dev without secret", () => {
    const config = loadAlertKeeperConfig({
      MERIDIAN_ALERT_WEBHOOK_URL: "https://hooks.example.com",
    });
    expect(config.webhookUrl).toBe("https://hooks.example.com");
    expect(config.webhookSecret).toBeUndefined();
  });

  it.each(["production", "preview"])(
    "throws when VERCEL_ENV=%s and secret is missing",
    (vercelEnv) => {
      expect(() =>
        loadAlertKeeperConfig({
          MERIDIAN_ALERT_WEBHOOK_URL: "https://hooks.example.com",
          VERCEL_ENV: vercelEnv,
        })
      ).toThrow(
        "MERIDIAN_ALERT_WEBHOOK_SECRET is required on deployed environments"
      );
    }
  );

  it("throws when NODE_ENV=production and secret is missing", () => {
    expect(() =>
      loadAlertKeeperConfig({
        MERIDIAN_ALERT_WEBHOOK_URL: "https://hooks.example.com",
        NODE_ENV: "production",
      })
    ).toThrow(
      "MERIDIAN_ALERT_WEBHOOK_SECRET is required on deployed environments"
    );
  });

  it("loads successfully on deployed environment when secret is provided", () => {
    const config = loadAlertKeeperConfig({
      MERIDIAN_ALERT_WEBHOOK_URL: "https://hooks.example.com",
      MERIDIAN_ALERT_WEBHOOK_SECRET: "my-prod-secret",
      VERCEL_ENV: "production",
    });
    expect(config.webhookUrl).toBe("https://hooks.example.com");
    expect(config.webhookSecret).toBe("my-prod-secret");
  });
});

describe("createAlertWebhookSignature and verifyAlertWebhookSignature", () => {
  const secret = "test-secret-12345";
  const body = JSON.stringify({
    text: "vault paused",
    content: "vault paused",
  });
  const deliveryId = "123e4567-e89b-12d3-a456-426614174000";
  const now = 1700000000;

  it("generates a sha256= prefixed hex signature and verifies successfully", () => {
    const sig = createAlertWebhookSignature(now, deliveryId, body, secret);
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);

    const headers = {
      [ALERT_WEBHOOK_SIGNATURE_HEADER]: sig,
      [ALERT_WEBHOOK_TIMESTAMP_HEADER]: String(now),
      [ALERT_WEBHOOK_DELIVERY_HEADER]: deliveryId,
    };

    const result = verifyAlertWebhookSignature(headers, body, secret, { now });
    expect(result).toEqual({ valid: true });
    expect(isAlertWebhookSignatureValid(headers, body, secret, { now })).toBe(
      true
    );
  });

  it("handles case-insensitive header names and raw hex signatures", () => {
    const sig = createAlertWebhookSignature(now, deliveryId, body, secret);
    const rawHex = sig.replace("sha256=", "");

    const headers = {
      "x-meridian-signature": rawHex,
      "x-meridian-timestamp": String(now),
      "x-meridian-delivery": deliveryId,
    };

    const result = verifyAlertWebhookSignature(headers, body, secret, { now });
    expect(result).toEqual({ valid: true });
  });

  it("rejects invalid signature when body was modified", () => {
    const sig = createAlertWebhookSignature(now, deliveryId, body, secret);
    const headers = {
      [ALERT_WEBHOOK_SIGNATURE_HEADER]: sig,
      [ALERT_WEBHOOK_TIMESTAMP_HEADER]: String(now),
      [ALERT_WEBHOOK_DELIVERY_HEADER]: deliveryId,
    };

    const result = verifyAlertWebhookSignature(
      headers,
      JSON.stringify({ text: "tampered" }),
      secret,
      { now }
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Signature mismatch");
  });

  it("rejects verification when secret is wrong", () => {
    const sig = createAlertWebhookSignature(now, deliveryId, body, secret);
    const headers = {
      [ALERT_WEBHOOK_SIGNATURE_HEADER]: sig,
      [ALERT_WEBHOOK_TIMESTAMP_HEADER]: String(now),
      [ALERT_WEBHOOK_DELIVERY_HEADER]: deliveryId,
    };

    const result = verifyAlertWebhookSignature(headers, body, "wrong-secret", {
      now,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Signature mismatch");
  });

  it("rejects verification when secret is empty", () => {
    const headers = {
      [ALERT_WEBHOOK_SIGNATURE_HEADER]: "sig",
      [ALERT_WEBHOOK_TIMESTAMP_HEADER]: String(now),
      [ALERT_WEBHOOK_DELIVERY_HEADER]: deliveryId,
    };
    const result = verifyAlertWebhookSignature(headers, body, "");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Missing webhook secret");
  });

  it("rejects missing headers", () => {
    const sig = createAlertWebhookSignature(now, deliveryId, body, secret);

    expect(
      verifyAlertWebhookSignature(
        {
          [ALERT_WEBHOOK_TIMESTAMP_HEADER]: String(now),
          [ALERT_WEBHOOK_DELIVERY_HEADER]: deliveryId,
        },
        body,
        secret
      )
    ).toEqual({
      valid: false,
      error: `Missing ${ALERT_WEBHOOK_SIGNATURE_HEADER} header`,
    });

    expect(
      verifyAlertWebhookSignature(
        {
          [ALERT_WEBHOOK_SIGNATURE_HEADER]: sig,
          [ALERT_WEBHOOK_DELIVERY_HEADER]: deliveryId,
        },
        body,
        secret
      )
    ).toEqual({
      valid: false,
      error: `Missing ${ALERT_WEBHOOK_TIMESTAMP_HEADER} header`,
    });

    expect(
      verifyAlertWebhookSignature(
        {
          [ALERT_WEBHOOK_SIGNATURE_HEADER]: sig,
          [ALERT_WEBHOOK_TIMESTAMP_HEADER]: String(now),
        },
        body,
        secret
      )
    ).toEqual({
      valid: false,
      error: `Missing ${ALERT_WEBHOOK_DELIVERY_HEADER} header`,
    });
  });

  it("rejects non-numeric timestamp header", () => {
    const headers = {
      [ALERT_WEBHOOK_SIGNATURE_HEADER]: "sig",
      [ALERT_WEBHOOK_TIMESTAMP_HEADER]: "not-a-number",
      [ALERT_WEBHOOK_DELIVERY_HEADER]: deliveryId,
    };
    const result = verifyAlertWebhookSignature(headers, body, secret);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid X-Meridian-Timestamp");
  });

  it("rejects stale timestamps outside tolerance window (replay attack)", () => {
    const staleTime = now - 301; // 301s ago (> default 300s)
    const sig = createAlertWebhookSignature(
      staleTime,
      deliveryId,
      body,
      secret
    );
    const headers = {
      [ALERT_WEBHOOK_SIGNATURE_HEADER]: sig,
      [ALERT_WEBHOOK_TIMESTAMP_HEADER]: String(staleTime),
      [ALERT_WEBHOOK_DELIVERY_HEADER]: deliveryId,
    };

    const result = verifyAlertWebhookSignature(headers, body, secret, { now });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("replay tolerance window");
  });

  it("rejects future timestamps outside tolerance window", () => {
    const futureTime = now + 301;
    const sig = createAlertWebhookSignature(
      futureTime,
      deliveryId,
      body,
      secret
    );
    const headers = {
      [ALERT_WEBHOOK_SIGNATURE_HEADER]: sig,
      [ALERT_WEBHOOK_TIMESTAMP_HEADER]: String(futureTime),
      [ALERT_WEBHOOK_DELIVERY_HEADER]: deliveryId,
    };

    const result = verifyAlertWebhookSignature(headers, body, secret, { now });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("replay tolerance window");
  });

  it("accepts custom toleranceSeconds window", () => {
    const slightlyOld = now - 40;
    const sig = createAlertWebhookSignature(
      slightlyOld,
      deliveryId,
      body,
      secret
    );
    const headers = {
      [ALERT_WEBHOOK_SIGNATURE_HEADER]: sig,
      [ALERT_WEBHOOK_TIMESTAMP_HEADER]: String(slightlyOld),
      [ALERT_WEBHOOK_DELIVERY_HEADER]: deliveryId,
    };

    // Stricter 30-second window rejects 40-second-old payload
    expect(
      verifyAlertWebhookSignature(headers, body, secret, {
        now,
        toleranceSeconds: 30,
      }).valid
    ).toBe(false);

    // More relaxed 60-second window accepts it
    expect(
      verifyAlertWebhookSignature(headers, body, secret, {
        now,
        toleranceSeconds: 60,
      }).valid
    ).toBe(true);
  });
});

describe("alert webhook signature", () => {
  // Digests computed independently with Node's standard HMAC-SHA256 (`createHmac`)
  // over `${timestamp}.${deliveryId}.${body}`, so a receiver using
  // `createHmac` verifies what the keeper sends.
  const body = JSON.stringify({ text: "a", content: "a" });

  it("matches a known HMAC-SHA256 digest", () => {
    expect(
      createAlertWebhookSignature("1700000000", "delivery-1", body, "secret")
    ).toBe(
      "sha256=ead122a33a300cb6d90f7ce79992d8bf4bcf4f2c3b7c00a4c518e14cc3115fc2"
    );
  });

  it("matches a known digest for a key longer than the 64 byte block size", () => {
    expect(
      createAlertWebhookSignature(
        "1700000000",
        "delivery-1",
        body,
        "k".repeat(100)
      )
    ).toBe(
      "sha256=59d642fecda64aa0891c5ac52b7470bfc07f486117523ee7efb2940fdd52a5a7"
    );
  });
});
