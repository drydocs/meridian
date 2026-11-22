import { describe, it, expect, vi, beforeEach } from "vitest";
import { CONTRACT_ADDRESSES } from "@meridian/shared";
import {
  getBalance,
  getAllowance,
  hasTrustline,
  InvalidAddressError,
  TokenRpcError,
} from "./musdc-token";
import { simulateView } from "./tx";
import type { StellarNetwork } from "./types";

vi.mock("./tx", () => ({
  simulateView: vi.fn(),
}));

vi.mock("./internal", () => ({
  getRpcServer: vi.fn(() => ({} as unknown as ReturnType<typeof import("./internal").getRpcServer>)),
}));

const TESTNET: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const MAINNET: StellarNetwork = {
  network: "mainnet",
  rpcUrl: "https://mainnet.sorobanrpc.com",
  passphrase: "Public Global Stellar Network ; September 2015",
};

const VALID_ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const VALID_CONTRACT = CONTRACT_ADDRESSES.testnet.vault;

describe("getBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the balance in stroops when the account holds mUSDC", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(100_0000000n);

    const balance = await getBalance(TESTNET, VALID_ADDRESS);

    expect(balance).toBe(100_0000000n);
    expect(simulateView).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_ADDRESSES.testnet.musdc,
      TESTNET.passphrase,
      "balance",
      expect.anything()
    );
  });

  it("returns 0 when the account has a zero balance", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(0n);

    const balance = await getBalance(TESTNET, VALID_ADDRESS);

    expect(balance).toBe(0n);
  });

  it("returns 0 when the balance is returned as a number", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(0);

    const balance = await getBalance(TESTNET, VALID_ADDRESS);

    expect(balance).toBe(0n);
  });

  it("returns 0 when simulateView returns null", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(null);

    const balance = await getBalance(TESTNET, VALID_ADDRESS);

    expect(balance).toBe(0n);
  });

  it("throws InvalidAddressError when the address is not a valid Stellar account", async () => {
    await expect(getBalance(TESTNET, "INVALID")).rejects.toThrow(
      InvalidAddressError
    );
    await expect(getBalance(TESTNET, "INVALID")).rejects.toThrow(
      "Invalid Stellar address: INVALID"
    );
  });

  it("throws TokenRpcError when simulateView fails", async () => {
    vi.mocked(simulateView).mockRejectedValueOnce(
      new Error("Soroban RPC timed out after 10000ms")
    );

    await expect(getBalance(TESTNET, VALID_ADDRESS)).rejects.toThrow(
      TokenRpcError
    );
    await expect(getBalance(TESTNET, VALID_ADDRESS)).rejects.toThrow(
      "Failed to read balance from token contract"
    );
  });

  it("uses the mainnet contract address when network is mainnet", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(50_0000000n);

    await getBalance(MAINNET, VALID_ADDRESS);

    expect(simulateView).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_ADDRESSES.mainnet.musdc,
      MAINNET.passphrase,
      "balance",
      expect.anything()
    );
  });

  it("throws TokenRpcError when no mUSDC contract is deployed on the network", async () => {
    // Create a network config with a network key that has no mUSDC contract.
    // Since testnet and mainnet have contracts in constants.ts, we simulate
    // this by temporarily testing the error path (this is a hypothetical case).
    const futurenet: StellarNetwork = {
      network: "futurenet" as "testnet",
      rpcUrl: "https://rpc.futurenet.stellar.org",
      passphrase: "Test SDF Future Network ; October 2022",
    };

    await expect(getBalance(futurenet, VALID_ADDRESS)).rejects.toThrow(
      TokenRpcError
    );
  });
});

describe("getAllowance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the allowance in stroops when a spender is approved", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(50_0000000n);

    const allowance = await getAllowance(TESTNET, VALID_ADDRESS, VALID_CONTRACT);

    expect(allowance).toBe(50_0000000n);
    expect(simulateView).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_ADDRESSES.testnet.musdc,
      TESTNET.passphrase,
      "allowance",
      expect.anything(),
      expect.anything()
    );
  });

  it("returns 0 when no allowance is set", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(0n);

    const allowance = await getAllowance(TESTNET, VALID_ADDRESS, VALID_CONTRACT);

    expect(allowance).toBe(0n);
  });

  it("returns 0 when allowance is returned as a number", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(25);

    const allowance = await getAllowance(TESTNET, VALID_ADDRESS, VALID_CONTRACT);

    expect(allowance).toBe(25n);
  });

  it("returns 0 when simulateView returns null", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(null);

    const allowance = await getAllowance(TESTNET, VALID_ADDRESS, VALID_CONTRACT);

    expect(allowance).toBe(0n);
  });

  it("throws InvalidAddressError when the owner address is invalid", async () => {
    await expect(
      getAllowance(TESTNET, "INVALID", VALID_CONTRACT)
    ).rejects.toThrow(InvalidAddressError);
  });

  it("throws InvalidAddressError when the spender address is invalid", async () => {
    await expect(
      getAllowance(TESTNET, VALID_ADDRESS, "INVALID")
    ).rejects.toThrow(InvalidAddressError);
  });

  it("accepts a contract address (C...) as spender", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(10_0000000n);

    const allowance = await getAllowance(
      TESTNET,
      VALID_ADDRESS,
      CONTRACT_ADDRESSES.testnet.vault
    );

    expect(allowance).toBe(10_0000000n);
  });

  it("accepts an account address (G...) as spender", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(10_0000000n);

    const spender = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const allowance = await getAllowance(TESTNET, VALID_ADDRESS, spender);

    expect(allowance).toBe(10_0000000n);
  });

  it("throws TokenRpcError when simulateView fails", async () => {
    vi.mocked(simulateView).mockRejectedValueOnce(new Error("Network error"));

    await expect(
      getAllowance(TESTNET, VALID_ADDRESS, VALID_CONTRACT)
    ).rejects.toThrow(TokenRpcError);
    await expect(
      getAllowance(TESTNET, VALID_ADDRESS, VALID_CONTRACT)
    ).rejects.toThrow("Failed to read allowance from token contract");
  });

  it("uses the mainnet contract address when network is mainnet", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(30_0000000n);

    await getAllowance(MAINNET, VALID_ADDRESS, VALID_CONTRACT);

    expect(simulateView).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_ADDRESSES.mainnet.musdc,
      MAINNET.passphrase,
      "allowance",
      expect.anything(),
      expect.anything()
    );
  });
});

describe("hasTrustline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when the account has a trustline with a balance", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(100_0000000n);

    const result = await hasTrustline(TESTNET, VALID_ADDRESS);

    expect(result).toBe(true);
  });

  it("returns true when the account has a trustline with a zero balance", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(0n);

    const result = await hasTrustline(TESTNET, VALID_ADDRESS);

    expect(result).toBe(true);
  });

  it("returns false when the contract error indicates the account does not exist", async () => {
    vi.mocked(simulateView).mockRejectedValueOnce(
      new Error("Error(Contract, #7) - account does not exist")
    );

    const result = await hasTrustline(TESTNET, VALID_ADDRESS);

    expect(result).toBe(false);
  });

  it("returns false when the contract error indicates trustline not found", async () => {
    vi.mocked(simulateView).mockRejectedValueOnce(
      new Error("trustline not found")
    );

    const result = await hasTrustline(TESTNET, VALID_ADDRESS);

    expect(result).toBe(false);
  });

  it("throws InvalidAddressError when the address is invalid", async () => {
    await expect(hasTrustline(TESTNET, "INVALID")).rejects.toThrow(
      InvalidAddressError
    );
  });

  it("throws TokenRpcError when the RPC call fails with a timeout", async () => {
    vi.mocked(simulateView).mockRejectedValueOnce(
      new Error("Soroban RPC timed out after 10000ms")
    );

    await expect(hasTrustline(TESTNET, VALID_ADDRESS)).rejects.toThrow(
      TokenRpcError
    );
  });

  it("throws TokenRpcError when the RPC call fails with a network error", async () => {
    vi.mocked(simulateView).mockRejectedValueOnce(new Error("network failure"));

    await expect(hasTrustline(TESTNET, VALID_ADDRESS)).rejects.toThrow(
      TokenRpcError
    );
  });

  it("returns false for unrecognized contract errors", async () => {
    vi.mocked(simulateView).mockRejectedValueOnce(
      new Error("Error(Contract, #99)")
    );

    const result = await hasTrustline(TESTNET, VALID_ADDRESS);

    expect(result).toBe(false);
  });

  it("uses the mainnet contract address when network is mainnet", async () => {
    vi.mocked(simulateView).mockResolvedValueOnce(50_0000000n);

    await hasTrustline(MAINNET, VALID_ADDRESS);

    expect(simulateView).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_ADDRESSES.mainnet.musdc,
      MAINNET.passphrase,
      "balance",
      expect.anything()
    );
  });
});
