import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./styles/globals.css";
import { initialiseI18n } from "./i18n";
import { createQueryClient } from "./lib/queryClient";
import { initializeErrorReporter, reportError } from "./lib/errorReporter";

const queryClient: QueryClient = createQueryClient();

initializeErrorReporter();
void initialiseI18n()
  .catch((error: unknown) => {
    console.error("Failed to initialise i18n");
    reportError(error, { category: "initialization" });
  })
  .then(() => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </React.StrictMode>
    );
  });