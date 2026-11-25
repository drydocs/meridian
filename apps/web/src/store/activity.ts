import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type ActivityStatus = "pending" | "confirmed" | "failed";
export type ActivityAction = "deposit" | "withdraw";

export interface LocalActivity {
  id: string;
  action: ActivityAction;
  amount: string;
  asset: string;
  vaultId: string;
  publicKey: string;
  vaultName?: string;
  timestamp: string;
  transactionHash?: string;
  status: ActivityStatus;
  error?: string;
}

interface ActivityStore {
  activities: LocalActivity[];
  latestReceipt: LocalActivity | null;
  addPending: (
    activity: Omit<LocalActivity, "id" | "timestamp" | "status">
  ) => string;
  updateActivity: (id: string, patch: Partial<LocalActivity>) => void;
  dismissReceipt: () => void;
}

export const ACTIVITY_LIMIT = 20;

export const useActivityStore = create<ActivityStore>()(
  persist(
    (set) => ({
      activities: [],
      latestReceipt: null,
      addPending: (activity) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const entry: LocalActivity = {
          ...activity,
          id,
          timestamp: new Date().toISOString(),
          status: "pending",
        };
        set((state) => ({
          activities: [entry, ...state.activities].slice(0, ACTIVITY_LIMIT),
          latestReceipt: entry,
        }));
        return id;
      },
      updateActivity: (id, patch) =>
        set((state) => {
          const activities = state.activities.map((item) =>
            item.id === id ? { ...item, ...patch } : item
          );
          const updated = activities.find((item) => item.id === id);
          return {
            activities,
            latestReceipt:
              state.latestReceipt?.id === id
                ? (updated ?? state.latestReceipt)
                : state.latestReceipt,
          };
        }),
      dismissReceipt: () => set({ latestReceipt: null }),
    }),
    {
      name: "meridian-local-activity",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        activities: state.activities,
        latestReceipt: state.latestReceipt,
      }),
    }
  )
);
