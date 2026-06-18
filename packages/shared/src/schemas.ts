import { z } from "zod";

export const DepositRequestSchema = z.object({
  walletAddress: z.string().length(56),
  vaultId: z.string(),
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
});

export const WithdrawRequestSchema = z.object({
  walletAddress: z.string().length(56),
  vaultId: z.string(),
  // Underlying asset amount (USDC/EURC) to withdraw from the pool.
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
});

export type DepositRequest = z.infer<typeof DepositRequestSchema>;
export type WithdrawRequest = z.infer<typeof WithdrawRequestSchema>;
