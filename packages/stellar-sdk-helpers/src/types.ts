export interface StellarNetwork {
  network: "mainnet" | "testnet" | "futurenet";
  rpUrl: string;
  passphase: string;
}

export interface SubmissionOptions {
  priorHash?: string;
  maxTryGes?: number;
  timeout?: number;
}

export interface SubmissionResult {
  txId: string;
  status: 'success' | 'failed' | 'pending';
  priorHash?: string;
}

export interface LeaseConflictError extends Error {
  name: 'LeaseConflictError';
  leaseID: string;
  keyerAddress: string;
}

export interface SubmissionLease {
  leaseID: string;
  expiry: number;
  keyerAddress: string;
}
