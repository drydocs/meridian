import * as Sentry from "@sentry/react";
import { APP_NETWORK } from "@meridian/shared";

export interface ApiErrorContext {
  method: string;
  path: string;
  status: number | null;
  category:
    | "http_client_error"
    | "http_server_error"
    | "http_error"
    | "network_error"
    | "timeout";
}

export interface ErrorReportContext {
  category: string;
  api?: ApiErrorContext;
  componentStack?: string;
  filename?: string;
  line?: number;
  column?: number;
}

type Reporter = {
  report: (error: unknown, context: ErrorReportContext) => void;
};

const noopReporter: Reporter = { report: () => undefined };
let reporter: Reporter = noopReporter;
let initialized = false;

const STELLAR_ADDRESS = /\b[GCMS][A-Z2-7]{55,68}\b/g;
const LONG_BASE64 = /\b[A-Za-z0-9+/]{64,}={0,2}\b/g;
const SECRET_ASSIGNMENT =
  /(\b[\w-]*(?:password|passphrase|secret(?:[_-]?key)?|token|api[_-]?key|authorization|cookie|private[_-]?key)\b\s*["']?\s*[:=]\s*["']?)[^&\s,;"'}]+/gi;
const SENSITIVE_KEY =
  /^(?:xdr|[\w-]*(?:secret(?:[_-]?key)?|private[_-]?key|password|passphrase|token|api[_-]?key|authorization|cookie))$/i;

function decodeForScrubbing(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function scrubText(value: string): string {
  return decodeForScrubbing(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(
      /-----BEGIN [^-]*(?:PRIVATE KEY|SECRET)[^-]*-----[\s\S]*?-----END [^-]*(?:PRIVATE KEY|SECRET)[^-]*-----/gi,
      "[REDACTED]"
    )
    .replace(STELLAR_ADDRESS, "[REDACTED]")
    .replace(LONG_BASE64, "[REDACTED]");
}

export function scrubSensitiveData<T>(value: T): T {
  const seen = new WeakSet<object>();

  function scrub(current: unknown): void {
    if (current === null || typeof current !== "object") {
      return;
    }
    if (seen.has(current)) {
      return;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        const item = current[index];
        if (typeof item === "string") {
          current[index] = scrubText(item);
        } else {
          scrub(item);
        }
      }
      return;
    }

    for (const [childKey, childValue] of Object.entries(current)) {
      if (SENSITIVE_KEY.test(childKey)) {
        Reflect.set(current, childKey, "[REDACTED]");
      } else if (typeof childValue === "string") {
        Reflect.set(current, childKey, scrubText(childValue));
      } else {
        scrub(childValue);
      }
    }
  }

  scrub(value);
  return value;
}

export function scrubSensitiveText(value: string): string {
  return scrubText(value);
}

function createSentryReporter(): Reporter {
  return {
    report(error, context) {
      const route = scrubText(
        typeof window === "undefined" ? "unknown" : window.location.pathname
      );
      const appVersion = import.meta.env.VITE_APP_VERSION;
      const appContext = {
        route,
        app_version: appVersion,
        network: APP_NETWORK.network,
      };

      Sentry.captureException(error, {
        tags: {
          category: context.category,
          route,
          app_version: appVersion,
          network: APP_NETWORK.network,
        },
        contexts: {
          app: appContext,
          ...(context.api ? { api: { ...context.api } } : {}),
          ...(context.componentStack
            ? { react: { component_stack: context.componentStack } }
            : {}),
          ...(context.filename
            ? {
                source: {
                  filename: context.filename,
                  line: context.line,
                  column: context.column,
                },
              }
            : {}),
        },
      });
    },
  };
}

export function reportError(error: unknown, context: ErrorReportContext): void {
  reporter.report(error, context);
}

export function initializeErrorReporter(): void {
  if (initialized) {
    return;
  }

  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (dsn) {
    Sentry.init({
      dsn,
      release: import.meta.env.VITE_APP_VERSION,
      environment: import.meta.env.MODE,
      defaultIntegrations: false,
      beforeSend(event) {
        return scrubSensitiveData(event);
      },
    });
    reporter = createSentryReporter();
  }

  window.addEventListener("error", (event) => {
    reportError(event.error ?? new Error(event.message || "Uncaught error"), {
      category: "uncaught_exception",
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason =
      event.reason instanceof Error
        ? event.reason
        : new Error(String(event.reason ?? "Unhandled promise rejection"));
    reportError(reason, { category: "unhandled_rejection" });
  });

  initialized = true;
}
