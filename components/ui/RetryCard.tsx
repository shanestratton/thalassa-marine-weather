/**
 * RetryCard — Unified error recovery component.
 *
 * Replaces ad-hoc "something went wrong" patterns with a consistent,
 * premium retry affordance that matches the glassmorphic design system.
 *
 * Usage:
 *   <RetryCard
 *     title="Weather Unavailable"
 *     description="Check your connection and try again"
 *     onRetry={() => refetch()}
 *     retrying={loading}
 *   />
 */
import React from 'react';

interface RetryCardProps {
    title?: string;
    description?: string;
    onRetry?: () => void;
    retrying?: boolean;
    icon?: string;
}

export const RetryCard: React.FC<RetryCardProps> = ({
    title = 'Something Went Wrong',
    description = 'Check your connection and try again',
    onRetry,
    retrying = false,
    icon = '⚠️',
}) => {
    return (
        <div className="flex flex-col items-center justify-center py-12 px-6 animate-in fade-in duration-300">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/15 flex items-center justify-center mb-4">
                <span className="text-2xl">{icon}</span>
            </div>
            <p className="text-sm font-bold text-white mb-1 text-center">{title}</p>
            <p className="text-xs text-white/50 text-center max-w-[240px] mb-5">{description}</p>
            {onRetry && (
                <button
                    aria-label="Retry loading content"
                    onClick={onRetry}
                    disabled={retrying}
                    className="px-6 py-2.5 bg-white/[0.06] border border-white/[0.08] rounded-xl text-sm font-bold text-white hover:bg-white/[0.1] transition-all active:scale-[0.97] disabled:opacity-50 flex items-center gap-2"
                >
                    {retrying ? (
                        <>
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Retrying…
                        </>
                    ) : (
                        <>
                            <svg
                                className="w-4 h-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
                                />
                            </svg>
                            Try Again
                        </>
                    )}
                </button>
            )}
        </div>
    );
};
