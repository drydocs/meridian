export const SUPPORTED_STABLECOINS = ["USDC", "EURC"] as const;
export type SupportedStablecoin = (typeof SUPPORTED_STABLECOINS)[number];

export const PROTOCOL_IDS = ["blend", "defindex"] as const;
export type ProtocolId = (typeof PROTOCOL_IDS)[number];

// Testnet contract addresses — replace with mainnet before launch
export const CONTRACT_ADDRESSES = {
  testnet: {
    blend: {
      pool: "CBDIZZTC5VFJHMKDXP4ADLSXMF6NE5LOFQBZ7XPWLH7FRDVYQKTJF5",
    },
    defindex: {
      factory: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK75",
    },
    usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  },
} as const;

export const STELLAR_NETWORKS = {
  testnet: {
    network: "testnet" as const,
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
  },
  mainnet: {
    network: "mainnet" as const,
    rpcUrl: "https://soroban-mainnet.stellar.org",
    passphrase: "Public Global Stellar Network ; September 2015",
  },
};
