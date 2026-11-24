import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches render-time errors so a single bad row cannot blank the whole app.
 *
 * Without this, any throw inside a page's render unmounts the entire React
 * tree and the user sees a white screen with no explanation — which is
 * exactly what happens when the API returns a shape the page did not expect.
 * Showing the message and a retry keeps the rest of the app usable and makes
 * the fault reportable.
 */
interface Props {
  children: ReactNode;
  /** Changing this resets the boundary, e.g. when the route changes. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only place staff can retrieve this from, so the
    // component stack is logged alongside the message.
    console.error('[render] uncaught error:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{ padding: 28, maxWidth: 720 }}>
        <div className="alert alert-error" role="alert">
          <span>
            <strong>This screen could not be displayed.</strong>
            <div style={{ marginTop: 6, fontSize: 13 }}>{error.message}</div>
          </span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          The rest of the application still works. Reload to try again, and
          report this message if it keeps happening.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    );
  }
}
