import { z } from "zod";

export const DepositRequestSchema = z.object({
  walletAddress: z.string().length(56),
  vaultId: z.string(),
  amount: z.string().regex(/^\d+$/),
  slippageBps: z.number().int().min(0).max(1000).default(50),
});

export const WithdrawRequestSchema = z.object({
  walletAddress: z.string().length(56),
  vaultId: z.string(),
  shares: z.string().regex(/^\d+$/),
});

export type DepositRequest = z.infer<typeof DepositRequestSchema>;
export type WithdrawRequest = z.infer<typeof WithdrawRequestSchema>;
