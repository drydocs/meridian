/**
 * Result of a framework-agnostic route handler. Thin per-framework adapters
 * (Vercel serverless functions, Fastify routes) map this onto their own
 * request/response types, so the validation, SDK call, and status-code
 * shaping logic is written and tested exactly once.
 */
export interface RouteResult {
  status: number;
  body: unknown;
  etag?: string;
  /**
   * Present when the handler caught an error building the response. Adapters
   * use this to log through their own framework-native logger (console.error
   * for Vercel, the Fastify request logger) without the shared core needing
   * to know which logger is in play.
   */
  error?: unknown;
}
