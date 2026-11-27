import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  convertAssetsToShares,
  convertSharesToAssets,
  calculatePerformanceFee,
  VIRTUAL_OFFSET,
} from "./vault-base.js";

interface Vector {
  name: string;
  description: string;
  kind: string;
  inputs: {
    assets?: string;
    total_assets?: string;
    total_shares?: string;
    shares?: string;
    usdc_out?: string;
    principal_out?: string;
    fee_bps?: string;
    bps_denominator?: string;
  };
  expected: {
    shares_out?: string;
    share_price?: string;
    assets_out?: string;
    gain?: string;
    fee?: string;
  };
}

interface VectorSuite {
  version: number;
  virtual_offset: string;
  vectors: Vector[];
}

describe("Vault Math Conformance Vectors", () => {
  const vectorPath = path.resolve(
    __dirname,
    "../../shared/vectors/vault_math_v1.json"
  );
  const fileContent = fs.readFileSync(vectorPath, "utf8");
  const suite: VectorSuite = JSON.parse(fileContent);

  it("matches expected virtual offset", () => {
    expect(VIRTUAL_OFFSET).toBe(BigInt(suite.virtual_offset));
  });

  for (const vector of suite.vectors) {
    it(`vector: ${vector.name} (${vector.description})`, () => {
      if (vector.kind === "deposit" || vector.kind === "edge") {
        const assets = BigInt(vector.inputs.assets ?? "0");
        const totalAssets = BigInt(vector.inputs.total_assets ?? "0");
        const totalSupply = BigInt(vector.inputs.total_shares ?? "0");
        const sharesOut = convertAssetsToShares(
          assets,
          totalAssets,
          totalSupply
        );
        if (vector.expected.shares_out !== undefined) {
          expect(sharesOut).toBe(BigInt(vector.expected.shares_out));
        } else {
          throw new Error(
            `Missing expected shares_out for vector ${vector.name}`
          );
        }

        if (vector.expected.share_price !== undefined) {
          const sharePrice =
            totalSupply === 0n
              ? assets
              : (totalAssets * 10_000_000n) / totalSupply;
          expect(sharePrice).toBe(BigInt(vector.expected.share_price));
        } else {
          throw new Error(
            `Missing expected share_price for vector ${vector.name}`
          );
        }
      } else if (vector.kind === "withdrawal_payout") {
        const shares = BigInt(vector.inputs.shares ?? "0");
        const totalAssets = BigInt(vector.inputs.total_assets ?? "0");
        const totalSupply = BigInt(vector.inputs.total_shares ?? "0");
        const assetsOut = convertSharesToAssets(
          shares,
          totalAssets,
          totalSupply
        );
        if (vector.expected.assets_out !== undefined) {
          expect(assetsOut).toBe(BigInt(vector.expected.assets_out));
        } else {
          throw new Error(
            `Missing expected assets_out for vector ${vector.name}`
          );
        }
      } else if (vector.kind === "fee" || vector.kind === "loss_withdrawal") {
        const usdcOut = BigInt(vector.inputs.usdc_out ?? "0");
        const principalOut = BigInt(vector.inputs.principal_out ?? "0");
        const feeBps = BigInt(vector.inputs.fee_bps ?? "0");
        const bpsDenom = BigInt(vector.inputs.bps_denominator ?? "10000");

        const { gain, fee } = calculatePerformanceFee(
          usdcOut,
          principalOut,
          feeBps,
          bpsDenom
        );

        if (vector.expected.gain !== undefined) {
          expect(gain).toBe(BigInt(vector.expected.gain));
        } else {
          throw new Error(`Missing expected gain for vector ${vector.name}`);
        }
        if (vector.expected.fee !== undefined) {
          expect(fee).toBe(BigInt(vector.expected.fee));
        } else {
          throw new Error(`Missing expected fee for vector ${vector.name}`);
        }
      } else {
        throw new Error(
          `Unknown vector kind '${vector.kind}' for vector ${vector.name}`
        );
      }
    });
  }
});
