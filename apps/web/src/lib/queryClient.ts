import { QueryClient } from "@tanstack/react-query";
import { isClientError } from "./api";

export interface QueryClientInterface {
  invalidateQueries(filters?: {
    queryKey: readonly unknown[];
  }): Promise<void> | void;
}

export function shouldRetryQuery(
  failureCount: number,
  error: unknown
): boolean {
  return !isClientError(error) && failureCount < 3;
}

export function queryRetryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 30_000);
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
        refetchOnReconnect: true,
      },
    },
  });
}

let activeClient: QueryClientInterface | null = null;

export function setQueryClient(client: QueryClientInterface | null) {
  activeClient = client;
}

export const queryClient: QueryClientInterface = {
  invalidateQueries: (filters) => {
    return activeClient?.invalidateQueries(filters);
  },
};
