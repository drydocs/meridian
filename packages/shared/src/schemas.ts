import { z } from "zod";

export const DepositRequestSchema = z.object({
  walletAddress: z.string().length(56),
  vaultId: z.string(),
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
});

export const WithdrawRequestSchema = z.object({
  walletAddress: z.string().length(56),
  vaultId: z.string(),
  // Protocol share count to burn: bToken collateral for Blend, dfToken count
  // for DeFindex. Both come from `position.shares` in the frontend.
  shares: z.string().regex(/^\d+(\.\d{1,7})?$/),
});

export type DepositRequest = z.infer<typeof DepositRequestSchema>;
export type WithdrawRequest = z.infer<typeof WithdrawRequestSchema>;
