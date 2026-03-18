/**
 * ChatErrorBoundary — Friendly error recovery for Crew Talk.
 * Catches rendering errors and offers a retry button
 * instead of a white screen of death.
 */
import React from 'react';

interface State {
    hasError: boolean;
    error?: Error;
}

export class ChatErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
    state: State = { hasError: false };

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    handleRetry = () => {
        this.setState({ hasError: false, error: undefined });
    };

    render() {
        if (this.state.hasError) {
            return (
                <div className="flex-1 flex flex-col items-center justify-center px-6 py-20">
                    <div className="relative mb-6">
                        <div className="w-20 h-20 rounded-full bg-red-500/[0.06] border border-red-500/10 flex items-center justify-center empty-ripple">
                            <span className="text-4xl empty-bob">⚓</span>
                        </div>
                    </div>
                    <h2 className="text-lg font-bold text-white/80 mb-2">Man overboard!</h2>
                    <p className="text-sm text-white/40 max-w-[260px] text-center leading-relaxed mb-6">
                        Something went wrong in Crew Talk. Don't worry — your messages are safe. Let's get back on
                        course.
                    </p>
                    <button
                        onClick={this.handleRetry}
                        aria-label="Try again"
                        className="px-6 py-3 rounded-xl bg-sky-500/15 border border-sky-500/25 text-sm font-bold text-sky-400 active:scale-95 transition-all min-h-[48px]"
                    >
                        🔄 Try Again
                    </button>
                    {this.state.error && (
                        <p className="text-[11px] text-white/40 mt-4 max-w-[300px] text-center font-mono truncate">
                            {this.state.error.message}
                        </p>
                    )}
                </div>
            );
        }

        return this.props.children;
    }
}
