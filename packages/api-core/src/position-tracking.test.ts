import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  track: vi.fn(async () => undefined),
  warn: vi.fn(),
}));

vi.mock("@meridian/stellar-sdk-helpers", () => ({
  consoleLogger: { warn: mocks.warn },
  loadPositionSnapshotStore: vi.fn(() => ({ track: mocks.track })),
  trackedUsersKey: vi.fn((network: string) => `tracked:${network}`),
}));

import { APP_NETWORK } from "@meridian/shared";
import {
  loadPositionSnapshotStore,
  trackedUsersKey,
} from "@meridian/stellar-sdk-helpers";
import { trackPositionHistoryUser } from "./position-tracking";

const PUBKEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => vi.clearAllMocks());

describe("trackPositionHistoryUser", () => {
  it("registers the wallet in the scheduled snapshot set", async () => {
    await trackPositionHistoryUser(PUBKEY, 1_700_000_000_000);

    expect(trackedUsersKey).toHaveBeenCalledWith(APP_NETWORK.network);
    expect(mocks.track).toHaveBeenCalledWith(
      `tracked:${APP_NETWORK.network}`,
      PUBKEY,
      1_700_000_000_000
    );
  });

  it("swallows store write failures", async () => {
    mocks.track.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      trackPositionHistoryUser(PUBKEY, 1_700_000_000_000)
    ).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it("swallows store configuration failures", async () => {
    vi.mocked(loadPositionSnapshotStore).mockImplementationOnce(() => {
      throw new Error("bad config");
    });

    await expect(
      trackPositionHistoryUser(PUBKEY, 1_700_000_000_000)
    ).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });
});
