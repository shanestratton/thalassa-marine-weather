
import React, { ErrorInfo, ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThalassaProvider } from './context/ThalassaContext';

// Service Worker Registration for PWA/Offline Support
const registerServiceWorker = async () => {
  if ('serviceWorker' in navigator) {
    // 1. Check for Secure Context (HTTPS or Localhost)
    // Service Workers throw errors if registered in an insecure context (e.g. LAN IP on HTTP)
    if (!window.isSecureContext) {
        // Silently skip - no need to warn user in console for development/LAN access
        return;
    }

    // 2. Check for Preview Environments (skip to prevent errors)
    const hostname = window.location.hostname;
    const isPreview = hostname.includes('usercontent.goog') || 
                      hostname.includes('webcontainer') || 
                      hostname.includes('ai.studio');

    if (isPreview) {
        return;
    }

    // 3. Attempt Registration with Error Handling
    try {
        const registration = await navigator.serviceWorker.register('./sw.js');
        console.log('Thalassa ServiceWorker registered:', registration.scope);
    } catch (err: any) {
        // Silently ignore known "origin" or "document" errors common in IFrames/Previews/WebViews
        const msg = err.message || "";
        if (msg.includes('origin') || msg.includes('document') || msg.includes('security') || msg.includes('environment')) {
            return;
        }
        console.error('Thalassa ServiceWorker registration failed:', err);
    }
  }
};

window.addEventListener('load', registerServiceWorker);

interface ErrorBoundaryProps {
  children?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState;
  public props: ErrorBoundaryProps;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.props = props;
    this.state = {
      hasError: false,
      error: null
    };
  }

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("CRITICAL APP ERROR:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px', backgroundColor: '#0f172a', color: 'white', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
          <h1 style={{ fontSize: '2rem', marginBottom: '1rem', color: '#ef4444' }}>Mayday! System Failure.</h1>
          <p style={{ maxWidth: '500px', marginBottom: '2rem', color: '#94a3b8' }}>
            The navigational computer encountered a critical error. We are working to restore systems.
          </p>
          <div style={{ padding: '1rem', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: '8px', marginBottom: '2rem', fontFamily: 'monospace', fontSize: '0.8rem', color: '#f87171' }}>
            {this.state.error?.message || "Unknown Error"}
          </div>
          <button 
            onClick={() => {
                localStorage.clear();
                window.location.reload();
            }}
            style={{ padding: '12px 24px', backgroundColor: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: '99px', fontWeight: 'bold', cursor: 'pointer' }}
          >
            Factory Reset & Reboot
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThalassaProvider>
        <App />
      </ThalassaProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
