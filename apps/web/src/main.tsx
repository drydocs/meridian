import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { initialiseI18n } from "./i18n";
import { initializeErrorReporter, reportError } from "./lib/errorReporter";

initializeErrorReporter();
void initialiseI18n()
  .catch((error: unknown) => {
    console.error("Failed to initialise i18n");
    reportError(error, { category: "initialization" });
  })
  .then(() => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  });
