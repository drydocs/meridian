import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildDepositTx, buildWithdrawTx, type ProtocolAddresses } from "./orchestration";
import type { StellarNetwork } from "./types";

vi.mock("./blend", () => ({
  blendAssetForVault: vi.fn((vaultId: string) => (vaultId.includes("-eurc") ? "eurc" : "usdc")),
  buildBlendDepositTx: vi.fn(async () => ({ xdr: "BLEND_DEPOSIT_XDR", fee: "200" })),
  buildBlendWithdrawTx: vi.fn(async () => ({ xdr: "BLEND_WITHDRAW_XDR", fee: "200" })),
}));

vi.mock("./defindex", () => ({
  buildDefindexDepositTx: vi.fn(async () => ({ xdr: "DFX_DEPOSIT_XDR", fee: "300" })),
  buildDefindexWithdrawTx: vi.fn(async () => ({ xdr: "DFX_WITHDRAW_XDR", fee: "300" })),
}));

import {
  buildBlendDepositTx,
  buildBlendWithdrawTx,
} from "./blend";
import {
  buildDefindexDepositTx,
  buildDefindexWithdrawTx,
} from "./defindex";

const network: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const addresses: ProtocolAddresses = {
  blendPool: "CPOOL",
  usdc: "CUSDC",
  eurc: "CEURC",
  defindexVault: "CDFX",
};

const WALLET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => vi.clearAllMocks());

describe("buildDepositTx", () => {
  it("routes a blend-usdc vault to buildBlendDepositTx with the USDC asset", async () => {
    const result = await buildDepositTx("blend-usdc-fixed", WALLET, "10", addresses, network);
    expect(result).toEqual({ xdr: "BLEND_DEPOSIT_XDR", fee: "200" });
    expect(buildBlendDepositTx).toHaveBeenCalledWith(
      { poolId: "CPOOL", assetId: "CUSDC", network },
      WALLET,
      100_000_000n
    );
    expect(buildDefindexDepositTx).not.toHaveBeenCalled();
  });

  it("routes a blend-eurc vault to buildBlendDepositTx with the EURC asset", async () => {
    await buildDepositTx("blend-eurc-fixed", WALLET, "5", addresses, network);
    expect(buildBlendDepositTx).toHaveBeenCalledWith(
      { poolId: "CPOOL", assetId: "CEURC", network },
      WALLET,
      50_000_000n
    );
  });

  it("routes a defindex vault to buildDefindexDepositTx", async () => {
    const result = await buildDepositTx("defindex-usdc", WALLET, "10", addresses, network);
    expect(result).toEqual({ xdr: "DFX_DEPOSIT_XDR", fee: "300" });
    expect(buildDefindexDepositTx).toHaveBeenCalledWith(
      { vaultId: "CDFX", network },
      WALLET,
      100_000_000n
    );
    expect(buildBlendDepositTx).not.toHaveBeenCalled();
  });

  it("throws when defindexVault address is empty and vault is defindex", async () => {
    const noVault = { ...addresses, defindexVault: "" };
    await expect(buildDepositTx("defindex-usdc", WALLET, "10", noVault, network)).rejects.toThrow(
      /DeFindex vault not configured/
    );
  });

  it("throws for an unrecognised vault protocol", async () => {
    await expect(buildDepositTx("ondo-usdy", WALLET, "10", addresses, network)).rejects.toThrow(
      /No protocol mapping/
    );
  });
});

describe("buildWithdrawTx", () => {
  it("routes a blend vault to buildBlendWithdrawTx", async () => {
    const result = await buildWithdrawTx("blend-usdc-fixed", WALLET, "5", addresses, network);
    expect(result).toEqual({ xdr: "BLEND_WITHDRAW_XDR", fee: "200" });
    expect(buildBlendWithdrawTx).toHaveBeenCalledWith(
      { poolId: "CPOOL", assetId: "CUSDC", network },
      WALLET,
      50_000_000n
    );
  });

  it("routes a defindex vault to buildDefindexWithdrawTx", async () => {
    const result = await buildWithdrawTx("defindex-usdc", WALLET, "5", addresses, network);
    expect(result).toEqual({ xdr: "DFX_WITHDRAW_XDR", fee: "300" });
    expect(buildDefindexWithdrawTx).toHaveBeenCalledWith(
      { vaultId: "CDFX", network },
      WALLET,
      50_000_000n
    );
  });

  it("throws when defindexVault address is empty and vault is defindex", async () => {
    const noVault = { ...addresses, defindexVault: "" };
    await expect(buildWithdrawTx("defindex-usdc", WALLET, "5", noVault, network)).rejects.toThrow(
      /DeFindex vault not configured/
    );
  });

  it("throws for an unrecognised vault protocol", async () => {
    await expect(buildWithdrawTx("ondo-usdy", WALLET, "5", addresses, network)).rejects.toThrow(
      /No protocol mapping/
    );
  });
});
