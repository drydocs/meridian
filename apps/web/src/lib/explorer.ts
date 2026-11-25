export type StellarNetwork = "testnet" | "mainnet";

const TX_EXPLORER_BASE: Record<StellarNetwork, string> = {
  testnet: "https://stellar.expert/explorer/testnet/tx",
  mainnet: "https://stellar.expert/explorer/public/tx",
};

export function getTransactionExplorerUrl(
  network: StellarNetwork,
  transactionHash: string
): string {
  return `${TX_EXPLORER_BASE[network]}/${transactionHash}`;
}
