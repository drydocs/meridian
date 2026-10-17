const STORAGE_KEY = "meridian-admin-session";

type AdminQueryClient = {
  removeQueries: (options: { queryKey: readonly unknown[] }) => void;
};

let adminQueryClient: AdminQueryClient | null = null;

export function configureAdminSessionQueryClient(client: AdminQueryClient): void {
  adminQueryClient = client;
}

export function getAdminSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(STORAGE_KEY);
}

export function setAdminSessionToken(token: string): void {
  window.sessionStorage.setItem(STORAGE_KEY, token);
}

export function clearAdminSession(): void {
  if (typeof window !== "undefined") window.sessionStorage.removeItem(STORAGE_KEY);
  adminQueryClient?.removeQueries({ queryKey: ["adminHistory"] });
  adminQueryClient?.removeQueries({ queryKey: ["vault-state", "admin"] });
}
