/**
 * In-app 404 page (issue #793).
 *
 * Rendered by `App` for any route the SPA does not recognise, so an unmatched
 * path shows a product-styled page instead of Vercel's default 404. Matches the
 * dashboard/status pages' design language (`bg-night`, blue accent, bordered
 * fallback action).
 */
export function NotFound() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-night px-6 text-white">
      <div className="relative z-10 w-full max-w-md text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-gray-500">
          404
        </p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-white">
          Page not found
        </h1>
        <p className="mt-3 text-sm text-gray-400">
          The page you are looking for doesn&apos;t exist or may have moved.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href="/app/"
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors duration-150 hover:bg-blue-500 sm:w-auto"
          >
            Back to dashboard
          </a>
          <a
            href="/"
            className="w-full rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-300 transition-colors duration-150 hover:border-gray-600 hover:text-white sm:w-auto"
          >
            Home
          </a>
        </div>
      </div>
    </div>
  );
}
