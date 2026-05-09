import type { VaultInfo, YieldPosition } from "../types";

export const MOCK_VAULTS: VaultInfo[] = [
  {
    id: "blend-usdc-main",
    protocol: "blend",
    asset: "USDC",
    apy: 8.42,
    tvl: 42_500_000_000_0000n,
    userBalance: 0n,
  },
  {
    id: "defindex-usdc-stable",
    protocol: "defindex",
    asset: "USDC",
    apy: 11.75,
    tvl: 18_200_000_000_0000n,
    userBalance: 0n,
  },
  {
    id: "blend-eurc-main",
    protocol: "blend",
    asset: "EURC",
    apy: 6.90,
    tvl: 9_800_000_000_0000n,
    userBalance: 0n,
  },
  {
    id: "defindex-usdc-aggressive",
    protocol: "defindex",
    asset: "USDC",
    apy: 15.20,
    tvl: 5_400_000_000_0000n,
    userBalance: 0n,
  },
];

export const MOCK_POSITIONS: YieldPosition[] = [
  {
    vaultId: "blend-usdc-main",
    deposited: 500_000_0000n,
    earned: 3_512_0000n,
    entryTime: Date.now() - 1000 * 60 * 60 * 24 * 30,
  },
  {
    vaultId: "defindex-usdc-stable",
    deposited: 200_000_0000n,
    earned: 1_948_0000n,
    entryTime: Date.now() - 1000 * 60 * 60 * 24 * 12,
  },
];
