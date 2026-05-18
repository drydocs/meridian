export interface VaultInfo {
  id: string;
  protocol: "blend" | "defindex";
  asset: string;
  apy: number;
  tvl: number;
  userBalance: number;
}

export interface YieldPosition {
  vaultId: string;
  deposited: number;
  earned: number;
  entryTime: number;
}

export interface StellarNetwork {
  network: "mainnet" | "testnet" | "futurenet";
  rpcUrl: string;
  passphrase: string;
}
