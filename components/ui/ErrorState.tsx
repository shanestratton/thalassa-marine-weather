import React from 'react';

interface ErrorStateProps {
    message: string;
    onRetry?: () => void;
    onSelectLocation?: () => void;
    isGpsError?: boolean;
}

/**
 * Friendly error recovery UI with actionable buttons
 */
export const ErrorState: React.FC<ErrorStateProps> = ({
    message,
    onRetry,
    onSelectLocation,
    isGpsError = false,
}) => {
    // Determine icon based on error type
    const getIcon = () => {
        if (isGpsError || message.toLowerCase().includes('gps') || message.toLowerCase().includes('location')) {
            return (
                <svg className="w-12 h-12 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                        d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                        d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
            );
        }
        if (message.toLowerCase().includes('offline') || message.toLowerCase().includes('network')) {
            return (
                <svg className="w-12 h-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                        d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3" />
                </svg>
            );
        }
        // Default: general error
        return (
            <svg className="w-12 h-12 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
        );
    };

    return (
        <div className="flex flex-col items-center justify-center p-8 text-center">
            {/* Icon */}
            <div className="mb-4 opacity-80">
                {getIcon()}
            </div>

            {/* Message */}
            <p className="text-white/80 text-lg font-medium mb-2 max-w-xs">
                {message}
            </p>

            {/* Helpful hint */}
            <p className="text-white/50 text-sm mb-6 max-w-xs">
                {isGpsError
                    ? "Check your location settings or select a location manually."
                    : "Check your connection and try again."}
            </p>

            {/* Action buttons */}
            <div className="flex gap-3">
                {onRetry && (
                    <button
                        onClick={onRetry}
                        className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-lg transition-colors flex items-center gap-2 min-h-[44px]"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Retry
                    </button>
                )}
                {onSelectLocation && (
                    <button
                        onClick={onSelectLocation}
                        className="px-5 py-2.5 bg-white/10 hover:bg-white/20 text-white font-semibold rounded-lg transition-colors flex items-center gap-2 min-h-[44px]"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        Select Location
                    </button>
                )}
            </div>
        </div>
    );
};
