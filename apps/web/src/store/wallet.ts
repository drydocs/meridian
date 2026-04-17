import { create } from "zustand";
import type { WalletState } from "../types";

interface WalletStore extends WalletState {
  connect: (publicKey: string) => void;
  disconnect: () => void;
  setNetwork: (network: WalletState["network"]) => void;
}

export const useWalletStore = create<WalletStore>((set) => ({
  publicKey: null,
  network: "testnet",
  connected: false,

  connect: (publicKey) => set({ publicKey, connected: true }),
  disconnect: () => set({ publicKey: null, connected: false }),
  setNetwork: (network) => set({ network }),
}));
