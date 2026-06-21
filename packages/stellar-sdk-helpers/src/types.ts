export interface StellarNetwork {
  network: "mainnet" | "testnet" | "futurenet";
  rpcUrl: string;
  passphrase: string;
}
