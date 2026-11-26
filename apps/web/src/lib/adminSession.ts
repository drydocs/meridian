import type { WalletAdapter } from "./wallet";
import { api } from "./api";

let token: string | null = null;
let expiresAt = 0;
const listeners = new Set<() => void>();

export function getAdminToken(): string | null {
  if (token && expiresAt <= Math.floor(Date.now() / 1000)) clearAdminToken();
  return token;
}

export function setAdminToken(value: string, expiry: number): void {
  token = value;
  expiresAt = expiry;
  listeners.forEach((listener) => listener());
}

export function clearAdminToken(): void {
  if (token === null) return;
  token = null;
  expiresAt = 0;
  listeners.forEach((listener) => listener());
}

export function onAdminSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loginAsAdmin(
  address: string,
  adapter: WalletAdapter
): Promise<void> {
  if (!adapter.signMessage) {
    throw new Error("This wallet cannot sign an admin login message");
  }
  const { challenge } = await api.createAdminChallenge(address);
  const signature = await adapter.signMessage(challenge);
  const result = await api.verifyAdminChallenge({
    address,
    challenge,
    signature,
  });
  setAdminToken(result.token, result.expiresAt);
}
