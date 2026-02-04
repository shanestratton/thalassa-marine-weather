/**
 * ErrorBoundary Component
 * 
 * React error boundary that catches JavaScript errors anywhere in the child
 * component tree, logs those errors, and displays a fallback UI instead of
 * the component tree that crashed.
 * 
 * @example
 * <ErrorBoundary fallback={<ErrorFallback />}>
 *   <MyComponent />
 * </ErrorBoundary>
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangleIcon } from './Icons';

interface ErrorBoundaryProps {
    /** Child components to wrap */
    children: ReactNode;
    /** Optional custom fallback UI */
    fallback?: ReactNode;
    /** Optional callback when error occurs */
    onError?: (error: Error, errorInfo: ErrorInfo) => void;
    /** Name of the boundary for logging */
    boundaryName?: string;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
    errorInfo: ErrorInfo | null;
}

/**
 * Default fallback UI shown when an error occurs
 */
const DefaultErrorFallback: React.FC<{
    error?: Error | null;
    onRetry?: () => void;
    boundaryName?: string;
}> = ({ error, onRetry, boundaryName }) => (
    <div className="flex flex-col items-center justify-center p-8 bg-slate-900/80 backdrop-blur-xl rounded-2xl border border-red-500/30 shadow-[0_0_30px_rgba(239,68,68,0.1)] text-center min-h-[200px]">
        <div className="p-4 bg-red-500/20 rounded-full mb-4">
            <AlertTriangleIcon className="w-8 h-8 text-red-400" />
        </div>
        <h3 className="text-lg font-bold text-white mb-2">
            Something went wrong
        </h3>
        <p className="text-sm text-gray-400 mb-4 max-w-md">
            {boundaryName ? `Error in ${boundaryName}` : 'An unexpected error occurred'}
            {error?.message && (
                <span className="block mt-2 text-xs text-red-400/70 font-mono">
                    {error.message.slice(0, 100)}
                </span>
            )}
        </p>
        {onRetry && (
            <button
                onClick={onRetry}
                className="px-4 py-2 bg-sky-500 hover:bg-sky-400 text-white text-sm font-bold rounded-lg transition-colors shadow-lg shadow-sky-500/30"
            >
                Try Again
            </button>
        )}
    </div>
);

/**
 * Compact fallback for widgets and small components
 */
export const CompactErrorFallback: React.FC<{ message?: string }> = ({ message }) => (
    <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-xs">
        <AlertTriangleIcon className="w-4 h-4 flex-shrink-0" />
        <span>{message || 'Error loading widget'}</span>
    </div>
);

/**
 * Error Boundary class component
 * 
 * Note: Error boundaries must be class components as of React 18.
 * There is no functional component equivalent for componentDidCatch.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = {
            hasError: false,
            error: null,
            errorInfo: null
        };
    }

    /**
     * Update state so the next render shows the fallback UI
     */
    static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
        return { hasError: true, error };
    }

    /**
     * Log the error and call optional callback
     */
    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        this.setState({ errorInfo });

        // Log to console with boundary name for easier debugging
        const boundaryName = this.props.boundaryName || 'Unknown';

        // Enhanced error logging for debugging non-Error objects
        console.error(`[ErrorBoundary:${boundaryName}] Caught error:`, error);
        console.error(`[ErrorBoundary:${boundaryName}] Error type:`, typeof error);
        console.error(`[ErrorBoundary:${boundaryName}] Error constructor:`, error?.constructor?.name);
        console.error(`[ErrorBoundary:${boundaryName}] Error message:`, error?.message);
        console.error(`[ErrorBoundary:${boundaryName}] Error stack:`, error?.stack);
        try {
            console.error(`[ErrorBoundary:${boundaryName}] Error JSON:`, JSON.stringify(error, null, 2));
        } catch (e) {
            console.error(`[ErrorBoundary:${boundaryName}] Could not stringify error`);
        }
        console.error(`[ErrorBoundary:${boundaryName}] Component stack:`, errorInfo.componentStack);

        // Call optional error callback
        if (this.props.onError) {
            this.props.onError(error, errorInfo);
        }
    }

    /**
     * Reset the error state to allow retry
     */
    handleRetry = (): void => {
        this.setState({
            hasError: false,
            error: null,
            errorInfo: null
        });
    };

    render(): ReactNode {
        if (this.state.hasError) {
            // Use custom fallback if provided, otherwise use default
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <DefaultErrorFallback
                    error={this.state.error}
                    onRetry={this.handleRetry}
                    boundaryName={this.props.boundaryName}
                />
            );
        }

        return this.props.children;
    }
}

/**
 * HOC to wrap a component with an error boundary
 * 
 * @example
 * const SafeWidget = withErrorBoundary(Widget, { boundaryName: 'Widget' });
 */
export function withErrorBoundary<P extends object>(
    WrappedComponent: React.ComponentType<P>,
    boundaryProps?: Omit<ErrorBoundaryProps, 'children'>
): React.FC<P> {
    const displayName = WrappedComponent.displayName || WrappedComponent.name || 'Component';

    const WithErrorBoundary: React.FC<P> = (props) => (
        <ErrorBoundary {...boundaryProps} boundaryName={boundaryProps?.boundaryName || displayName}>
            <WrappedComponent {...props} />
        </ErrorBoundary>
    );

    WithErrorBoundary.displayName = `withErrorBoundary(${displayName})`;

    return WithErrorBoundary;
}

export default ErrorBoundary;
