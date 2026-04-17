export type { VaultInfo, YieldPosition, StellarNetwork } from "@meridian/stellar-sdk-helpers";
export type { SupportedStablecoin, ProtocolId } from "@meridian/shared";

export interface WalletState {
  publicKey: string | null;
  network: "testnet" | "mainnet";
  connected: boolean;
}
