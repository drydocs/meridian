import { describe, it, expect, vi, beforeEach } from "vitest";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Mock @meridian/stellar-sdk-helpers before importing the module under test.
// The entire network layer is behind prepareSorobanTx and simulateView, so
// mocking both is sufficient to isolate all tests from the Stellar network.
// ---------------------------------------------------------------------------
vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  return {
    ...actual,
    prepareSorobanTx: vi.fn(),
    simulateView: vi.fn(),
  };
});

import { prepareSorobanTx, simulateView } from "@meridian/stellar-sdk-helpers";
import {
  VaultBase,
  VIRTUAL_OFFSET,
  convertAssetsToShares,
  convertSharesToAssets,
} from "./vault-base.js";
import type { VaultConfig, Transaction } from "./types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TESTNET: VaultConfig["network"] = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const CONTRACT_ID =
  "CAIQBVLBIUWQGE6DQUHDMZ2QWI7QP6KTCN7GP2BIZ6JZC4ES47JO4SSM";

const WALLET =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const ADAPTER_ID =
  "CBNKERYAG7VZNBH2V3TF5JBXLD3MXLVQW5GG4AO445EUDCPKP4D2DDP2";

const STUB_TX: Transaction = { xdr: "UNSIGNED_XDR", fee: "150" };

// Stub RPC server — its identity is all that matters; simulateView is fully
// mocked so the stub never actually calls the network.
const STUB_RPC = {} as never;

// ---------------------------------------------------------------------------
// Concrete subclass for testing the abstract VaultBase.
// Overrides makeRpcServer to return the stub, avoiding any network setup.
// ---------------------------------------------------------------------------

class TestVault extends VaultBase {
  private _caller: string;

  constructor(config: VaultConfig, caller: string) {
    super(config);
    this._caller = caller;
  }

  protected get caller(): string {
    return this._caller;
  }

  // Inject stub server so no real SorobanRpc.Server is ever constructed.
  protected override makeRpcServer() {
    return STUB_RPC;
  }
}

function makeVault(caller = WALLET): TestVault {
  return new TestVault({ contractId: CONTRACT_ID, network: TESTNET }, caller);
}

// ---------------------------------------------------------------------------
// Helper to set up simulateView to return a map of {method -> returnValue}
// ---------------------------------------------------------------------------
function mockViewCalls(returns: Record<string, unknown>): void {
  vi.mocked(simulateView).mockImplementation(
    (_server, contractId, _passphrase, method) => {
      const key = method as string;
      if (key in returns) return Promise.resolve(returns[key]);
      // get_protocol is dispatched against the adapter's contractId
      if (contractId !== CONTRACT_ID && key === "get_protocol")
        return Promise.resolve(returns["get_protocol"] ?? "blend");
      throw new Error(
        `Unexpected simulateView call: ${method} on ${contractId}`
      );
    }
  );
}

// ---------------------------------------------------------------------------
// Pure math: convertAssetsToShares / convertSharesToAssets
// ---------------------------------------------------------------------------

describe("convertAssetsToShares", () => {
  it("empty vault: 1 asset → 1 share (offset cancels)", () => {
    // virtualAssets = 0 + 1 = 1, virtualSupply = 0 + 1 = 1
    // shares = assets * 1 / 1 = assets
    expect(convertAssetsToShares(1_000_000n, 0n, 0n)).toBe(1_000_000n);
  });

  it("established vault: proportional conversion", () => {
    // totalAssets = 10 USDC, totalSupply = 10 shares → 1:1
    // shares = 5_000_000 * 10_000_001 / 10_000_001 = 5_000_000
    expect(
      convertAssetsToShares(5_000_000n, 10_000_000n, 10_000_000n)
    ).toBe(5_000_000n);
  });

  it("inflated vault: attacker donated assets — formula stays defined", () => {
    // Attacker donated 10 USDC (100_000_000 stroops) directly; no real shares yet.
    // shares = 1_000_000 * 1 / (100_000_000 + 1) = 0 (floor)
    const ta = 100_000_000n;
    const ts = 0n;
    const shares = convertAssetsToShares(1_000_000n, ta, ts);
    expect(shares).toBe(0n); // value is lost — the virtual offset of 1 is intentionally minimal
    // Verify no division-by-zero or exception is thrown regardless of input size
    expect(convertAssetsToShares(100_000_000n, ta, ts)).toBeGreaterThanOrEqual(0n);
  });

  it("round-trips: convertAssetsToShares then convertSharesToAssets ≈ original", () => {
    const ta = 50_000_000n;
    const ts = 45_000_000n;
    const assets = 10_000_000n;
    const shares = convertAssetsToShares(assets, ta, ts);
    const backToAssets = convertSharesToAssets(shares, ta, ts);
    // Floor-division means backToAssets ≤ assets, within 1 stroop
    expect(backToAssets).toBeLessThanOrEqual(assets);
    expect(assets - backToAssets).toBeLessThanOrEqual(1n);
  });
});

describe("convertSharesToAssets", () => {
  it("empty vault: 1 share → 1 asset (offset cancels)", () => {
    expect(convertSharesToAssets(1_000_000n, 0n, 0n)).toBe(1_000_000n);
  });

  it("2x appreciation: 1 share → ~2 assets", () => {
    // totalAssets = 20 USDC, totalSupply = 10 shares → 2:1
    // assets = 10_000_000 * (20_000_000+1) / (10_000_000+1) ≈ 19_999_999
    const result = convertSharesToAssets(
      10_000_000n,
      20_000_000n,
      10_000_000n
    );
    expect(result).toBe(19_999_999n);
  });
});

describe("VIRTUAL_OFFSET", () => {
  it("is 1n", () => {
    expect(VIRTUAL_OFFSET).toBe(1n);
  });
});

// ---------------------------------------------------------------------------
// VaultBase: deposit
// ---------------------------------------------------------------------------

describe("VaultBase.deposit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prepareSorobanTx).mockResolvedValue(STUB_TX);
  });

  it("builds a deposit call and returns transaction XDR", async () => {
    const vault = makeVault();
    const result = await vault.deposit(100_000_000n, WALLET);
    expect(result).toEqual(STUB_TX);
    expect(prepareSorobanTx).toHaveBeenCalledTimes(1);
  });

  it("passes receiver address and amount to the contract", async () => {
    const vault = makeVault();
    await vault.deposit(50_000_000n, WALLET);
    const [network, caller, op] = vi.mocked(prepareSorobanTx).mock.calls[0]!;
    expect(network).toEqual(TESTNET);
    expect(caller).toBe(WALLET);
    const args = op
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract()
      .args();
    // receiver, assets, min_shares_out
    expect(args).toHaveLength(3);
    expect(Address.fromScVal(args[0]!).toString()).toBe(WALLET);
    expect(args[1]).toEqual(nativeToScVal(50_000_000n, { type: "i128" }));
    expect(args[2]).toEqual(nativeToScVal(0n, { type: "i128" }));
  });

  it("throws for non-positive assets", async () => {
    const vault = makeVault();
    await expect(vault.deposit(0n, WALLET)).rejects.toThrow(
      "assets must be positive"
    );
    await expect(vault.deposit(-1n, WALLET)).rejects.toThrow(
      "assets must be positive"
    );
    expect(prepareSorobanTx).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// VaultBase: withdraw
// ---------------------------------------------------------------------------

describe("VaultBase.withdraw", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prepareSorobanTx).mockResolvedValue(STUB_TX);
    // totalAssets = 10 USDC, totalSupply = 10 shares → 1:1
    mockViewCalls({
      get_total_assets: 10_000_000n,
      get_total_shares: 10_000_000n,
    });
  });

  it("converts assets to shares and builds a withdraw call", async () => {
    const vault = makeVault();
    const result = await vault.withdraw(5_000_000n, WALLET, WALLET);
    expect(result).toEqual(STUB_TX);
    expect(prepareSorobanTx).toHaveBeenCalledTimes(1);
  });

  it("passes owner address and computed shares to the contract", async () => {
    const vault = makeVault();
    await vault.withdraw(5_000_000n, WALLET, WALLET);
    const [, , op] = vi.mocked(prepareSorobanTx).mock.calls[0]!;
    const args = op
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract()
      .args();
    // owner, shares, min_usdc_out
    expect(args).toHaveLength(3);
    expect(Address.fromScVal(args[0]!).toString()).toBe(WALLET);
    // At 1:1 rate: 5_000_000 * (10_000_001) / (10_000_001) = 5_000_000
    expect(args[1]).toEqual(nativeToScVal(5_000_000n, { type: "i128" }));
    expect(args[2]).toEqual(nativeToScVal(0n, { type: "i128" }));
  });

  it("throws for non-positive assets", async () => {
    const vault = makeVault();
    await expect(vault.withdraw(0n, WALLET, WALLET)).rejects.toThrow(
      "assets must be positive"
    );
  });
});

// ---------------------------------------------------------------------------
// VaultBase: pause / unpause
// ---------------------------------------------------------------------------

describe("VaultBase.pause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prepareSorobanTx).mockResolvedValue(STUB_TX);
  });

  it("builds a pause transaction", async () => {
    const vault = makeVault();
    const result = await vault.pause();
    expect(result).toEqual(STUB_TX);
    expect(prepareSorobanTx).toHaveBeenCalledTimes(1);
  });

  it("builds an unpause transaction", async () => {
    const vault = makeVault();
    const result = await vault.unpause();
    expect(result).toEqual(STUB_TX);
    expect(prepareSorobanTx).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// VaultBase: setAdapter
// ---------------------------------------------------------------------------

describe("VaultBase.setAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prepareSorobanTx).mockResolvedValue(STUB_TX);
  });

  it("builds a set_adapter transaction with the new adapter address", async () => {
    const vault = makeVault();
    const result = await vault.setAdapter(ADAPTER_ID);
    expect(result).toEqual(STUB_TX);
    expect(prepareSorobanTx).toHaveBeenCalledTimes(1);
    const [, , op] = vi.mocked(prepareSorobanTx).mock.calls[0]!;
    const args = op
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract()
      .args();
    expect(args).toHaveLength(1);
    expect(Address.fromScVal(args[0]!).toString()).toBe(ADAPTER_ID);
  });
});

// ---------------------------------------------------------------------------
// VaultBase: migrateAdapter
// ---------------------------------------------------------------------------

describe("VaultBase.migrateAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prepareSorobanTx).mockResolvedValue(STUB_TX);
  });

  it("builds a migrate_adapter transaction", async () => {
    const vault = makeVault();
    const deadline = Math.floor(Date.now() / 1000) + 86400;
    const result = await vault.migrateAdapter(ADAPTER_ID, deadline, 50);
    expect(result).toEqual(STUB_TX);
    expect(prepareSorobanTx).toHaveBeenCalledTimes(1);
  });

  it("passes newAdapter, deadline, and slippageBps to the contract", async () => {
    const vault = makeVault();
    const deadline = 1_800_000_000;
    await vault.migrateAdapter(ADAPTER_ID, deadline, 100);
    const [, , op] = vi.mocked(prepareSorobanTx).mock.calls[0]!;
    const args = op
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract()
      .args();
    expect(args).toHaveLength(3);
    expect(Address.fromScVal(args[0]!).toString()).toBe(ADAPTER_ID);
    expect(args[1]).toEqual(nativeToScVal(BigInt(deadline), { type: "u64" }));
    expect(args[2]).toEqual(nativeToScVal(100, { type: "u32" }));
  });

  it("throws for non-positive deadline", async () => {
    const vault = makeVault();
    await expect(vault.migrateAdapter(ADAPTER_ID, 0, 50)).rejects.toThrow(
      "deadline must be a positive timestamp"
    );
    await expect(vault.migrateAdapter(ADAPTER_ID, -1, 50)).rejects.toThrow(
      "deadline must be a positive timestamp"
    );
  });

  it("throws when slippageBps is out of range", async () => {
    const vault = makeVault();
    const deadline = 1_800_000_000;
    await expect(
      vault.migrateAdapter(ADAPTER_ID, deadline, -1)
    ).rejects.toThrow("slippageBps must be between 0 and 10000");
    await expect(
      vault.migrateAdapter(ADAPTER_ID, deadline, 10_001)
    ).rejects.toThrow("slippageBps must be between 0 and 10000");
  });

  it("accepts edge slippageBps values 0 and 10000", async () => {
    const vault = makeVault();
    const deadline = 1_800_000_000;
    await expect(
      vault.migrateAdapter(ADAPTER_ID, deadline, 0)
    ).resolves.toEqual(STUB_TX);
    vi.clearAllMocks();
    vi.mocked(prepareSorobanTx).mockResolvedValue(STUB_TX);
    await expect(
      vault.migrateAdapter(ADAPTER_ID, deadline, 10_000)
    ).resolves.toEqual(STUB_TX);
  });
});

// ---------------------------------------------------------------------------
// VaultBase: getPosition
// ---------------------------------------------------------------------------

describe("VaultBase.getPosition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when account holds no shares", async () => {
    mockViewCalls({ get_position: 0n });
    const vault = makeVault();
    const pos = await vault.getPosition(WALLET);
    expect(pos).toBeNull();
  });

  it("computes position from on-chain data", async () => {
    mockViewCalls({
      get_position: 10_000_000n,   // 1 mUSDC share
      get_total_assets: 12_000_000n, // yield accrued: now worth 12 USDC
      get_total_shares: 10_000_000n,
      get_principal: 10_000_000n,  // deposited 10 USDC
      get_entry_time: 1_700_000_000n,
    });
    const vault = makeVault();
    const pos = await vault.getPosition(WALLET);
    expect(pos).not.toBeNull();
    expect(pos!.vaultId).toBe(CONTRACT_ID);
    expect(pos!.shares).toBe(10_000_000n);
    // deposited = shares * totalAssets / totalShares = 10e6 * 12e6 / 10e6 = 12e6
    expect(pos!.deposited).toBe(12_000_000n);
    // earned = deposited - principal = 12e6 - 10e6 = 2e6
    expect(pos!.earned).toBe(2_000_000n);
    expect(pos!.principal).toBe(10_000_000n);
    expect(pos!.entryTime).toBe(1_700_000_000);
  });

  it("sets earned to 0 when no principal is recorded (transfer-in position)", async () => {
    mockViewCalls({
      get_position: 5_000_000n,
      get_total_assets: 5_000_000n,
      get_total_shares: 5_000_000n,
      get_principal: 0n, // no basis
      get_entry_time: 0n,
    });
    const vault = makeVault();
    const pos = await vault.getPosition(WALLET);
    expect(pos).not.toBeNull();
    expect(pos!.earned).toBe(0n);
  });

  it("sets earned to 0 when position is below principal (unrealised loss)", async () => {
    mockViewCalls({
      get_position: 10_000_000n,
      get_total_assets: 8_000_000n, // vault lost value
      get_total_shares: 10_000_000n,
      get_principal: 10_000_000n,
      get_entry_time: 0n,
    });
    const vault = makeVault();
    const pos = await vault.getPosition(WALLET);
    expect(pos!.earned).toBe(0n);
    expect(pos!.deposited).toBe(8_000_000n);
  });
});

// ---------------------------------------------------------------------------
// VaultBase: getPrincipal
// ---------------------------------------------------------------------------

describe("VaultBase.getPrincipal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the principal for an account", async () => {
    mockViewCalls({ get_principal: 25_000_000n });
    const vault = makeVault();
    expect(await vault.getPrincipal(WALLET)).toBe(25_000_000n);
  });

  it("returns 0n when no principal stored", async () => {
    mockViewCalls({ get_principal: 0n });
    const vault = makeVault();
    expect(await vault.getPrincipal(WALLET)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// VaultBase: ERC-4626 view methods
// ---------------------------------------------------------------------------

describe("VaultBase ERC-4626 view methods", () => {
  beforeEach(() => vi.clearAllMocks());

  it("totalAssets returns on-chain get_total_assets", async () => {
    mockViewCalls({ get_total_assets: 100_000_000n });
    const vault = makeVault();
    expect(await vault.totalAssets()).toBe(100_000_000n);
  });

  it("totalSupply returns on-chain get_total_shares", async () => {
    mockViewCalls({ get_total_shares: 90_000_000n });
    const vault = makeVault();
    expect(await vault.totalSupply()).toBe(90_000_000n);
  });

  it("convertToShares uses current vault state", async () => {
    mockViewCalls({
      get_total_assets: 20_000_000n,
      get_total_shares: 10_000_000n,
    });
    const vault = makeVault();
    // 5_000_000 * (10_000_001) / (20_000_001) = 2_500_000 (floor)
    const shares = await vault.convertToShares(5_000_000n);
    expect(shares).toBe(2_500_000n);
  });

  it("convertToAssets uses current vault state", async () => {
    mockViewCalls({
      get_total_assets: 20_000_000n,
      get_total_shares: 10_000_000n,
    });
    const vault = makeVault();
    // 5_000_000 * (20_000_001) / (10_000_001) = 9_999_999 (floor)
    const assets = await vault.convertToAssets(5_000_000n);
    expect(assets).toBe(9_999_999n);
  });

  describe("pause-aware ERC-4626 limits", () => {
    it("maxDeposit returns large sentinel when unpaused", async () => {
      mockViewCalls({ is_paused: false });
      const vault = makeVault();
      expect(await vault.maxDeposit(WALLET)).toBeGreaterThan(0n);
    });

    it("maxDeposit returns 0n when paused", async () => {
      mockViewCalls({ is_paused: true });
      const vault = makeVault();
      expect(await vault.maxDeposit(WALLET)).toBe(0n);
    });

    it("maxMint returns 0n when paused", async () => {
      mockViewCalls({ is_paused: true });
      const vault = makeVault();
      expect(await vault.maxMint(WALLET)).toBe(0n);
    });

    it("maxMint returns shares equivalent of maxDeposit when unpaused", async () => {
      mockViewCalls({
        is_paused: false,
        get_total_assets: 10_000_000n,
        get_total_shares: 10_000_000n,
      });
      const vault = makeVault();
      expect(await vault.maxMint(WALLET)).toBeGreaterThan(0n);
    });

    it("maxWithdraw returns 0n when paused", async () => {
      mockViewCalls({ is_paused: true });
      const vault = makeVault();
      expect(await vault.maxWithdraw(WALLET)).toBe(0n);
    });

    it("maxWithdraw returns deposited value when unpaused and has position", async () => {
      vi.mocked(simulateView).mockImplementation(
        (_server, _contractId, _passphrase, method) => {
          switch (method) {
            case "is_paused":     return Promise.resolve(false);
            case "get_position":  return Promise.resolve(10_000_000n);
            case "get_total_assets": return Promise.resolve(10_000_000n);
            case "get_total_shares": return Promise.resolve(10_000_000n);
            case "get_principal": return Promise.resolve(10_000_000n);
            case "get_entry_time": return Promise.resolve(0n);
            default: throw new Error(`Unexpected method: ${method}`);
          }
        }
      );
      const vault = makeVault();
      expect(await vault.maxWithdraw(WALLET)).toBe(10_000_000n);
    });

    it("maxWithdraw returns 0n when account has no position", async () => {
      vi.mocked(simulateView).mockImplementation(
        (_server, _contractId, _passphrase, method) => {
          if (method === "is_paused") return Promise.resolve(false);
          if (method === "get_position") return Promise.resolve(0n);
          throw new Error(`Unexpected method: ${method}`);
        }
      );
      const vault = makeVault();
      expect(await vault.maxWithdraw(WALLET)).toBe(0n);
    });

    it("maxRedeem returns 0n when paused", async () => {
      mockViewCalls({ is_paused: true });
      const vault = makeVault();
      expect(await vault.maxRedeem(WALLET)).toBe(0n);
    });

    it("maxRedeem returns share balance when unpaused", async () => {
      vi.mocked(simulateView).mockImplementation(
        (_server, _contractId, _passphrase, method) => {
          switch (method) {
            case "is_paused":     return Promise.resolve(false);
            case "get_position":  return Promise.resolve(7_000_000n);
            case "get_total_assets": return Promise.resolve(7_000_000n);
            case "get_total_shares": return Promise.resolve(7_000_000n);
            case "get_principal": return Promise.resolve(7_000_000n);
            case "get_entry_time": return Promise.resolve(0n);
            default: throw new Error(`Unexpected method: ${method}`);
          }
        }
      );
      const vault = makeVault();
      expect(await vault.maxRedeem(WALLET)).toBe(7_000_000n);
    });
  });
});

// ---------------------------------------------------------------------------
// VaultBase: isPaused
// ---------------------------------------------------------------------------

describe("VaultBase.isPaused", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when vault is paused", async () => {
    mockViewCalls({ is_paused: true });
    expect(await makeVault().isPaused()).toBe(true);
  });

  it("returns false when vault is active", async () => {
    mockViewCalls({ is_paused: false });
    expect(await makeVault().isPaused()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VaultBase: getAdapterInfo
// ---------------------------------------------------------------------------

describe("VaultBase.getAdapterInfo", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns adapter id, protocol, and totalAssets", async () => {
    vi.mocked(simulateView).mockImplementation(
      (_server, contractId, _passphrase, method) => {
        if (contractId === CONTRACT_ID) {
          if (method === "get_adapter") return Promise.resolve(ADAPTER_ID);
          if (method === "get_total_assets") return Promise.resolve(55_000_000n);
        }
        if (contractId === ADAPTER_ID && method === "get_protocol")
          return Promise.resolve("blend");
        throw new Error(`Unexpected: ${method} on ${contractId}`);
      }
    );
    const vault = makeVault();
    const info = await vault.getAdapterInfo();
    expect(info.adapterId).toBe(ADAPTER_ID);
    expect(info.protocol).toBe("blend");
    expect(info.totalAssets).toBe(55_000_000n);
  });
});

// ---------------------------------------------------------------------------
// ERC-4626 inflation protection – deposit/withdraw math (pure math integration)
// ---------------------------------------------------------------------------

describe("ERC-4626 inflation protection – deposit/withdraw math", () => {
  it("first depositor into empty vault gets full shares (1:1)", () => {
    expect(convertAssetsToShares(100_000_000n, 0n, 0n)).toBe(100_000_000n);
  });

  it("second depositor gets proportional shares after first deposit", () => {
    // totalAssets=100_000_000, totalSupply=100_000_000 → 1:1
    const shares = convertAssetsToShares(
      50_000_000n,
      100_000_000n,
      100_000_000n
    );
    expect(shares).toBe(50_000_000n);
  });

  it("yield accrual: more assets per share → fewer new shares per deposit", () => {
    // After 2x yield: totalAssets=200_000_000, totalSupply=100_000_000
    const shares = convertAssetsToShares(
      100_000_000n,
      200_000_000n,
      100_000_000n
    );
    expect(shares).toBeLessThan(100_000_000n);
    expect(shares).toBeGreaterThan(49_000_000n);
  });

  it("withdrawal math: share burn gives proportional assets back", () => {
    // Vault with yield: totalAssets=150_000_000, totalSupply=100_000_000
    const assets = convertSharesToAssets(
      50_000_000n,
      150_000_000n,
      100_000_000n
    );
    // ≈ 74_999_999 (floor)
    expect(assets).toBeGreaterThan(70_000_000n);
    expect(assets).toBeLessThanOrEqual(75_000_000n);
  });
});
