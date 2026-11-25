import { describe, it, expect, beforeEach } from "vitest";
import { ACTIVITY_LIMIT, useActivityStore } from "../../store/activity";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function pending(amount = "10") {
  return useActivityStore.getState().addPending({
    action: "deposit",
    amount,
    asset: "USDC",
    vaultId: "meridian-usdc",
    publicKey: KEY,
  });
}

beforeEach(() => {
  localStorage.clear();
  useActivityStore.setState({ activities: [], latestReceipt: null });
});

describe("useActivityStore", () => {
  it("records a new action as pending and makes it the latest receipt", () => {
    const id = pending();
    const { activities, latestReceipt } = useActivityStore.getState();

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id,
      status: "pending",
      amount: "10",
    });
    expect(latestReceipt?.id).toBe(id);
  });

  it("marks an action confirmed with its transaction hash", () => {
    const id = pending();
    useActivityStore
      .getState()
      .updateActivity(id, { status: "confirmed", transactionHash: "abc123" });

    const { activities, latestReceipt } = useActivityStore.getState();
    expect(activities[0]).toMatchObject({
      status: "confirmed",
      transactionHash: "abc123",
    });
    expect(latestReceipt).toMatchObject({
      status: "confirmed",
      transactionHash: "abc123",
    });
  });

  it("marks an action failed with its error", () => {
    const id = pending();
    useActivityStore
      .getState()
      .updateActivity(id, { status: "failed", error: "rejected" });

    expect(useActivityStore.getState().activities[0]).toMatchObject({
      status: "failed",
      error: "rejected",
    });
  });

  it("keeps only the newest actions, newest first", () => {
    for (let i = 0; i < ACTIVITY_LIMIT + 3; i++) pending(String(i));

    const { activities } = useActivityStore.getState();
    expect(activities).toHaveLength(ACTIVITY_LIMIT);
    expect(activities[0]?.amount).toBe(String(ACTIVITY_LIMIT + 2));
  });

  it("dismisses the receipt without removing the history", () => {
    pending();
    useActivityStore.getState().dismissReceipt();

    const { activities, latestReceipt } = useActivityStore.getState();
    expect(latestReceipt).toBeNull();
    expect(activities).toHaveLength(1);
  });

  it("restores the history after a reload", async () => {
    const id = pending("25");
    useActivityStore
      .getState()
      .updateActivity(id, { status: "confirmed", transactionHash: "abc123" });

    // Simulate a reload: keep what was written to storage, drop the in-memory
    // state (which also rewrites storage), restore the stored copy and rehydrate.
    const stored = localStorage.getItem("meridian-local-activity");
    expect(stored).not.toBeNull();
    useActivityStore.setState({ activities: [], latestReceipt: null });
    localStorage.setItem("meridian-local-activity", stored!);
    expect(useActivityStore.getState().activities).toHaveLength(0);
    await useActivityStore.persist.rehydrate();

    const { activities } = useActivityStore.getState();
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id,
      amount: "25",
      status: "confirmed",
      transactionHash: "abc123",
    });
  });
});
