import { useTranslation } from "react-i18next";
import { useToastStore } from "../../store/toast";

const ICON: Record<string, string> = {
  success: "✓",
  error: "✕",
  info: "i",
};

const STYLES: Record<string, string> = {
  success: "border-emerald-700 bg-emerald-950/80 text-emerald-300",
  error: "border-red-800 bg-red-950/80 text-red-300",
  info: "border-gray-700 bg-gray-900/80 text-gray-300",
};

export function Toasts() {
  const { toasts, dismiss, pauseTimer, resumeTimer } = useToastStore();
  const { t } = useTranslation();

  return (
    <div
      className="fixed inset-x-safe top-safe z-50 flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:top-4 sm:w-80 sm:max-w-[calc(100vw-2rem)]"
      role="status"
      aria-live="polite"
      aria-relevant="additions"
      aria-label={t("toasts.notifications")}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === "error" ? "alert" : undefined}
          aria-live={toast.kind === "error" ? "assertive" : undefined}
          aria-atomic="true"
          // Pausing on hover and on focus (focus events bubble in React, so
          // this also covers a keyboard user reaching the dismiss button)
          // keeps a toast on screen for as long as it's being read.
          onMouseEnter={() => pauseTimer(toast.id)}
          onMouseLeave={() => resumeTimer(toast.id)}
          onFocus={() => pauseTimer(toast.id)}
          onBlur={() => resumeTimer(toast.id)}
          className={`flex items-start gap-2 sm:items-center sm:gap-3 rounded-xl border px-3 py-3 sm:px-4 text-sm shadow-lg sm:backdrop-blur-sm animate-in fade-in slide-in-from-right-4 duration-200 ${STYLES[toast.kind]}`}
        >
          <span
            className="pt-0.5 sm:pt-0 font-bold shrink-0"
            aria-hidden="true"
          >
            {ICON[toast.kind]}
          </span>
          <span className="min-w-0 flex-1 break-words leading-snug">
            {toast.message}
          </span>
          <button
            onClick={() => dismiss(toast.id)}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg opacity-70 hover:opacity-100 transition-opacity duration-100 text-xs focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:outline-none"
            aria-label={t("toasts.dismiss", { kind: toast.kind })}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      ))}
    </div>
  );
}
