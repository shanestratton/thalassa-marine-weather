/**
 * DisclaimerOverlay — "Not for Navigation" full-screen acceptance gate
 *
 * Rendered by App.tsx when LegalGuard.checkDisclaimerAccepted() returns false.
 * User must scroll to bottom and tap "I Understand" to proceed.
 */

import React, { useState, useRef, useCallback } from 'react';
import { acceptDisclaimer, getDisclaimerText, DISCLAIMER_VERSION } from './LegalGuard';

interface DisclaimerOverlayProps {
    onAccepted: () => void;
}

export const DisclaimerOverlay: React.FC<DisclaimerOverlayProps> = ({ onAccepted }) => {
    const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    const handleScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        // Consider "scrolled to bottom" when within 40px of the end
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        if (atBottom && !hasScrolledToBottom) {
            setHasScrolledToBottom(true);
        }
    }, [hasScrolledToBottom]);

    const handleAccept = useCallback(() => {
        acceptDisclaimer();
        onAccepted();
    }, [onAccepted]);

    return (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-slate-950">
            {/* Subtle ocean gradient background */}
            <div
                className="absolute inset-0 opacity-30"
                style={{
                    background: 'radial-gradient(ellipse at 50% 120%, rgba(14,165,233,0.15) 0%, transparent 60%)',
                }}
            />

            <div className="relative w-full max-w-lg mx-4 flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="shrink-0 text-center mb-6">
                    <div className="text-4xl mb-3">⚓</div>
                    <h1 className="text-2xl font-black text-white tracking-wide uppercase">Important Notice</h1>
                    <p className="text-sm text-amber-400 font-semibold mt-2 tracking-wider uppercase">
                        Not for Navigation
                    </p>
                </div>

                {/* Scrollable disclaimer text */}
                <div
                    ref={scrollRef}
                    onScroll={handleScroll}
                    className="flex-1 min-h-0 overflow-y-auto rounded-2xl bg-slate-900/80 border border-white/10 p-5 mb-4 backdrop-blur-sm"
                    style={{
                        maxHeight: '50vh',
                        WebkitOverflowScrolling: 'touch',
                    }}
                >
                    <div className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">
                        {getDisclaimerText()}
                    </div>

                    {/* Scroll hint — fades when user reaches bottom */}
                    {!hasScrolledToBottom && (
                        <div className="sticky bottom-0 left-0 right-0 h-12 pointer-events-none bg-gradient-to-t from-slate-900 to-transparent" />
                    )}
                </div>

                {/* Scroll prompt or Accept button */}
                {!hasScrolledToBottom ? (
                    <div className="text-center text-sm text-slate-500 animate-pulse">
                        ↓ Scroll to read the full disclaimer
                    </div>
                ) : (
                    <button
                        onClick={handleAccept}
                        className="w-full py-4 rounded-2xl text-white text-lg font-bold transition-all active:scale-[0.98]"
                        style={{
                            background: 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)',
                            boxShadow: '0 8px 32px rgba(14, 165, 233, 0.3), 0 0 60px rgba(14, 165, 233, 0.1)',
                        }}
                    >
                        I Understand — Continue
                    </button>
                )}

                {/* Version footer */}
                <p className="text-center text-[11px] text-slate-600 mt-3">Disclaimer v{DISCLAIMER_VERSION}</p>
            </div>
        </div>
    );
};
