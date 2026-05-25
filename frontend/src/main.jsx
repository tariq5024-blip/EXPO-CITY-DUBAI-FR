import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // Surface the error to console for diagnostics
    // eslint-disable-next-line no-console
    console.error("[ui] Render error:", error, info?.componentStack);
  }
  handleReload = () => {
    try { window.location.reload(); } catch { /* noop */ }
  };
  handleReset = () => {
    this.setState({ error: null });
  };
  render() {
    if (this.state.error) {
      const msg = this.state.error?.message || String(this.state.error);
      return (
        <div style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b1220",
          color: "#e5e7eb",
          fontFamily: "system-ui, -apple-system, sans-serif",
          padding: 24
        }}>
          <div style={{
            maxWidth: 560,
            background: "#111827",
            border: "1px solid #1f2937",
            borderRadius: 12,
            padding: 24,
            boxShadow: "0 10px 30px rgba(0,0,0,.4)"
          }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
              Something went wrong
            </div>
            <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 16 }}>
              The interface hit an unexpected error. You can try again or reload.
            </div>
            <pre style={{
              background: "#0b1220",
              border: "1px solid #1f2937",
              borderRadius: 8,
              padding: 12,
              fontSize: 12,
              color: "#fca5a5",
              overflow: "auto",
              maxHeight: 180,
              whiteSpace: "pre-wrap"
            }}>{msg}</pre>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={this.handleReset} style={{
                background: "#2563eb", color: "#fff", border: 0,
                padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontWeight: 600
              }}>Try again</button>
              <button onClick={this.handleReload} style={{
                background: "transparent", color: "#e5e7eb",
                border: "1px solid #374151",
                padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontWeight: 600
              }}>Reload page</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Surface unhandled promise rejections / errors instead of silently failing
window.addEventListener("unhandledrejection", (e) => {
  // eslint-disable-next-line no-console
  console.error("[ui] Unhandled promise rejection:", e?.reason);
});
window.addEventListener("error", (e) => {
  // eslint-disable-next-line no-console
  console.error("[ui] Window error:", e?.error || e?.message);
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
);
