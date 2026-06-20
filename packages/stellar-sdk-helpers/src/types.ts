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
