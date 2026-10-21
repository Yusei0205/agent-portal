import { Component } from 'react';

/**
 * Top-level error boundary. Catches render errors anywhere in the tree and
 * shows an accessible fallback instead of a blank page.
 *
 * Usage: wrap <App /> in main.jsx with <ErrorBoundary>.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="splash" role="alert" aria-live="assertive">
          <div className="pad" style={{ textAlign: 'center', maxWidth: '480px' }}>
            <h1>Something went wrong</h1>
            <p className="muted" style={{ marginBottom: '1rem', wordBreak: 'break-word' }}>
              {this.state.error.message || String(this.state.error)}
            </p>
            <button
              type="button"
              className="btn btn-default"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
