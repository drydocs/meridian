import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./styles/globals.css";
import { initialiseI18n } from "./i18n";
import { createQueryClient } from "./lib/queryClient";

const queryClient: QueryClient = createQueryClient();

void initialiseI18n()
  .catch(() => {
    console.error("Failed to initialise i18n");
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
