import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ExtensionErrorBoundaryProps {
  readonly children: ReactNode;
  readonly development?: boolean;
  readonly logger?: (...args: unknown[]) => void;
  /** Runs in production too, unlike the dev-only log; receives nothing, so it cannot pass the error on. */
  readonly onError?: () => void;
}

interface ExtensionErrorBoundaryState {
  readonly failed: boolean;
}

export class ExtensionErrorBoundary extends Component<
  ExtensionErrorBoundaryProps,
  ExtensionErrorBoundaryState
> {
  state: ExtensionErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ExtensionErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: unknown, info: ErrorInfo): void {
    try {
      this.props.onError?.();
    } catch {
      // Reporting must never break the host page.
    }

    if (!(this.props.development ?? import.meta.env.DEV)) return;

    try {
      (this.props.logger ?? console.error)("Threads Private Directory UI error", {
        componentStack: info.componentStack ?? "",
      });
    } catch {
      // Diagnostics must never break the host page.
    }
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
