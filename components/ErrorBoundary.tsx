'use client';

import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Custom fallback UI */
  fallback?: React.ReactNode;
  /** Section name for error context (e.g. "圖表", "掃描") */
  section?: string;
  /** Optional callback when error is caught */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  /** Changing this value clears a previously caught error (for example after switching stock). */
  resetKey?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(
      `[ErrorBoundary${this.props.section ? `:${this.props.section}` : ''}]`,
      error,
      info,
    );
    this.props.onError?.(error, info);
  }

  componentDidUpdate(prevProps: Props): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const section = this.props.section ?? '模組';
      return (
        <div className="flex items-center justify-center h-full min-h-[120px] bg-card ring-1 ring-foreground/10 rounded-xl text-muted-foreground p-4">
          <div className="text-center space-y-2">
            <p className="text-sm font-medium">{section}載入失敗</p>
            <p className="text-xs text-red-400/80 max-w-xs truncate">
              {this.state.error?.message}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="mt-2 min-h-11 rounded-md bg-muted px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              重試
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Convenience wrapper for feature sections.
 * Usage: <SectionBoundary section="掃描結果"><ScanResults /></SectionBoundary>
 */
export function SectionBoundary({
  section,
  children,
  resetKey,
}: {
  section: string;
  children: React.ReactNode;
  resetKey?: string;
}) {
  return (
    <ErrorBoundary section={section} resetKey={resetKey}>
      {children}
    </ErrorBoundary>
  );
}
