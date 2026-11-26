import { Component, type ErrorInfo, type ReactNode } from "react";
import { withTranslation, type WithTranslation } from "react-i18next";
import { reportError } from "../../lib/errorReporter";

interface ErrorBoundaryProps extends WithTranslation {
  children: ReactNode;
  onReset?: () => void;
  showHome?: boolean;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

// Catches unexpected render panics, separate from the predictable async data
// failures TanStack Query already surfaces via isError/error (handled inline
// in VaultPanel). Supports an optional onReset action for subtree recovery
// and a home link to navigate back safely without losing all app state.
class ErrorBoundaryBase extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, {
      category: "render",
      componentStack: info.componentStack ?? "",
    });
    console.error(
      "[ErrorBoundary] caught render error:",
      error,
      info.componentStack
    );
  }

  handleReset = () => {
    this.setState({ hasError: false });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  handleHome = () => {
    const base = import.meta.env.BASE_URL || "/app/";
    window.location.href = base;
  };

  render() {
    if (this.state.hasError) {
      const { t, showHome } = this.props;
      return (
        <div className="rounded-2xl border border-red-900/50 bg-red-950/20 p-6 text-center">
          <p className="text-sm text-red-400">{t("errorBoundary.title")}</p>
          <div className="mt-3 flex items-center justify-center gap-2 flex-wrap">
            <button
              onClick={this.handleReset}
              className="rounded-lg border border-red-800/70 px-4 py-1.5 text-xs font-medium text-red-300 hover:border-red-700 hover:text-red-200 transition-colors duration-150"
            >
              {t("errorBoundary.retry")}
            </button>
            {showHome && (
              <button
                onClick={this.handleHome}
                className="rounded-lg border border-gray-700 px-4 py-1.5 text-xs font-medium text-gray-300 hover:border-gray-600 hover:text-paper transition-colors duration-150"
              >
                {t("errorBoundary.home")}
              </button>
            )}
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg border border-red-800/70 px-4 py-1.5 text-xs font-medium text-red-300 hover:border-red-700 hover:text-red-200 transition-colors duration-150"
            >
              {t("errorBoundary.reload")}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export const ErrorBoundary = withTranslation()(ErrorBoundaryBase);
