export interface QueryClientInterface {
  invalidateQueries(filters?: {
    queryKey: readonly unknown[];
  }): Promise<void> | void;
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
