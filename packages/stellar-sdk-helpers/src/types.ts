export interface VaultInfo {
  id: string;
  protocol: "blend" | "defindex";
  asset: string;
  apy: number;
  tvl: bigint;
  userBalance: bigint;
}

export interface YieldPosition {
  vaultId: string;
  deposited: bigint;
  earned: bigint;
  entryTime: number;
}

export interface StellarNetwork {
  network: "mainnet" | "testnet" | "futurenet";
  rpcUrl: string;
  passphrase: string;
}
