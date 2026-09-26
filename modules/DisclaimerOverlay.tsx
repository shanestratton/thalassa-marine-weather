/**
 * DisclaimerOverlay — "Not for Navigation" full-screen acceptance gate
 *
 * Rendered by App.tsx when LegalGuard.checkDisclaimerAccepted() returns false.
 * User must scroll to bottom and tap "I understand, continue" to proceed.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { acceptDisclaimer, getDisclaimerText, DISCLAIMER_VERSION } from './LegalGuard';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { AnchorIcon } from '../components/Icons';

interface DisclaimerOverlayProps {
    onAccepted: () => void;
}

export const DisclaimerOverlay: React.FC<DisclaimerOverlayProps> = ({ onAccepted }) => {
    const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
    const [progress, setProgress] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const titleRef = useRef<HTMLHeadingElement>(null);
    // Every other dialog in the app traps focus; this one did not, so a
    // keyboard or screen-reader user could tab straight out of a legal gate
    // into the app behind it. NO onEscape on purpose: this is a gate, and
    // Escape must not dismiss it. Focus starts on the title, not the text
    // box: a programmatic focus there drew the keyboard ring on load, so the
    // card looked like a selected input (UX scorecard run 7). Tab still
    // reaches the box, with its ring, for arrow-key scrolling.
    const dialogRef = useFocusTrap<HTMLDivElement>(true, { initialFocusRef: titleRef });

    // index.html's 'Skip to main content' link sits outside this gate and led
    // nowhere while it was up. Take it out of the tab order and the tree until
    // the gate closes.
    useEffect(() => {
        const skip = document.querySelector<HTMLAnchorElement>('a[href="#main-content"]');
        if (!skip || skip.closest('[role="dialog"]')) return;
        const hadInert = skip.hasAttribute('inert');
        const hadHidden = skip.getAttribute('aria-hidden');
        skip.setAttribute('inert', '');
        skip.setAttribute('aria-hidden', 'true');
        return () => {
            if (!hadInert) skip.removeAttribute('inert');
            if (hadHidden === null) skip.removeAttribute('aria-hidden');
            else skip.setAttribute('aria-hidden', hadHidden);
        };
    }, []);

    /**
     * "Has the skipper reached the end of the text?" — which is TRUE when the
     * text never overflowed in the first place.
     *
     * This used to be answered only from onScroll, and the Accept button
     * renders only in that branch. On any viewport where the disclaimer fits
     * inside max-h-[50vh] — an iPad in portrait, which TARGETED_DEVICE_FAMILY
     * "1,2" supports — no scroll event ever fired, so the button never
     * appeared and the app could not be entered at all. A hard lockout on a
     * shipping device.
     */
    const measure = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        // Within 40px of the end, OR never scrollable to begin with.
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        const range = el.scrollHeight - el.clientHeight;
        setProgress(atBottom || range <= 0 ? 1 : Math.min(1, Math.max(0, el.scrollTop / range)));
        if (atBottom) setHasScrolledToBottom(true);
    }, []);

    // Measure on mount (covers short content) and again whenever the box
    // resizes — rotation, split view, or the text loading late all change
    // whether it overflows.
    useEffect(() => {
        measure();
        const el = scrollRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [measure]);

    const handleScroll = measure;

    const handleAccept = useCallback(() => {
        acceptDisclaimer();
        onAccepted();
    }, [onAccepted]);

    return (
        <div
            id="main-content"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="navigation-disclaimer-title"
            // The version the acceptance is stored against. It is not shown:
            // 'Disclaimer v1.0' read as a developer string (UX scorecard run 7).
            data-disclaimer-version={DISCLAIMER_VERSION}
            tabIndex={-1}
            className="fixed inset-0 z-99999 flex items-center justify-center bg-slate-950"
        >
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
                    <div aria-hidden="true" className="mb-3 flex justify-center text-sky-300">
                        <AnchorIcon className="h-10 w-10" />
                    </div>
                    <h1
                        ref={titleRef}
                        id="navigation-disclaimer-title"
                        tabIndex={-1}
                        className="text-2xl font-black text-white tracking-wide uppercase outline-hidden"
                    >
                        Important notice
                    </h1>
                    <p className="text-sm text-amber-400 font-semibold mt-2 tracking-wider uppercase">
                        Not for navigation
                    </p>
                </div>

                {/* Scrollable disclaimer text. The fade is a sibling laid over
                    the box's full inner width and bottom edge: as a sticky child
                    it sat inside the p-5 padding, an inset rectangle with hard
                    side edges and text showing below it (UX scorecard run 7). */}
                <div className="relative mb-3 flex min-h-0 flex-1 flex-col">
                    <div
                        ref={scrollRef}
                        role="document"
                        tabIndex={0}
                        aria-label="Navigation disclaimer text"
                        onScroll={handleScroll}
                        className="min-h-0 flex-1 overflow-y-auto rounded-2xl bg-slate-900/80 border border-white/10 p-5 backdrop-blur-xs"
                        style={{
                            maxHeight: '50vh',
                            WebkitOverflowScrolling: 'touch',
                        }}
                    >
                        <div className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">
                            {getDisclaimerText()}
                        </div>
                    </div>
                    {!hasScrolledToBottom && (
                        <div
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-x-px bottom-px h-16 rounded-b-2xl bg-linear-to-t from-slate-900 to-transparent"
                        />
                    )}
                </div>

                {/* Reading progress: a thin bar, so the way to the button is
                    visible from the first screen. */}
                <div aria-hidden="true" className="mb-4 h-1 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                        className="h-full rounded-full bg-sky-400 transition-[width] duration-150"
                        style={{ width: `${Math.round(progress * 100)}%` }}
                    />
                </div>

                {/* The accept control is there from the start, disabled until the
                    text has been read to the end. It used to appear only at the
                    bottom, leaving no visible way forward (UX scorecard run 7). */}
                <button
                    type="button"
                    onClick={handleAccept}
                    disabled={!hasScrolledToBottom}
                    aria-describedby={hasScrolledToBottom ? undefined : 'navigation-disclaimer-hint'}
                    className="w-full min-h-14 py-4 rounded-2xl text-white text-lg font-bold transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
                    style={{
                        background: 'linear-gradient(135deg, #0369a1 0%, #075985 100%)',
                        boxShadow: hasScrolledToBottom
                            ? '0 8px 32px rgba(14, 165, 233, 0.3), 0 0 60px rgba(14, 165, 233, 0.1)'
                            : 'none',
                    }}
                >
                    I understand, continue
                </button>
                {/* Kept in the layout once read, so the button does not jump. */}
                <p
                    id="navigation-disclaimer-hint"
                    className="mt-3 min-h-5 text-center text-sm text-slate-300"
                    aria-live="polite"
                >
                    {hasScrolledToBottom ? '' : 'Scroll to the end to continue.'}
                </p>
            </div>
        </div>
    );
};
