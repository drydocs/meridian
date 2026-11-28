import { useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { isNetworkError } from "../lib/api";

export function useConnectivity(queryClient: QueryClient): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [networkError, setNetworkError] = useState(false);

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
      setNetworkError(false);
      void queryClient.refetchQueries({ type: "active" });
    };
    const handleOffline = () => setOnline(false);
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (
        event.action.type === "error" &&
        isNetworkError(event.query.state.error)
      ) {
        setNetworkError(true);
      }
      if (event.action.type === "success") {
        setNetworkError(false);
      }
    });

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      unsubscribe();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [queryClient]);

  return online && !networkError;
}
