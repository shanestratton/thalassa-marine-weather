/**
 * SlideToAction — Reusable iOS-style "slide to confirm" action button.
 *
 * Extracted from AnchorWatchPage's slide-to-drop-anchor pattern.
 * Used for destructive or important actions: Start Tracking, Calculate Route, Drop Anchor, etc.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { triggerHaptic } from '../../utils/system';

interface SlideToActionProps {
    /** Text shown on the track (fades as thumb slides) */
    label: string;
    /** Emoji or icon inside the draggable thumb */
    thumbIcon: React.ReactNode;
    /** Called when user slides past the threshold */
    onConfirm: () => void;
    /** If true, show a loading spinner instead of the slider */
    loading?: boolean;
    /** Loading text shown during the loading state */
    loadingText?: string;
    /** Disable the slider */
    disabled?: boolean;
    /** Color theme preset */
    theme?: 'emerald' | 'amber' | 'sky';
}

const THEMES = {
    emerald: {
        track: 'linear-gradient(135deg, rgba(16,185,129,0.25) 0%, rgba(5,150,105,0.2) 100%)',
        trackBorder: '1px solid rgba(52,211,153,0.25)',
        shimmer: 'rgba(52,211,153,0.08)',
        shimmerPeak: 'rgba(52,211,153,0.15)',
        labelColor: 'text-emerald-300/70',
        thumbBg: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
        thumbShadow: '0 4px 16px rgba(16,185,129,0.4), 0 0 20px rgba(16,185,129,0.15)',
        loadingTrack: 'linear-gradient(135deg, rgba(16,185,129,0.15) 0%, rgba(5,150,105,0.1) 100%)',
        loadingBorder: '1px solid rgba(52,211,153,0.2)',
        spinnerBorder: 'border-emerald-400',
        loadingTextColor: 'text-emerald-300',
    },
    amber: {
        track: 'linear-gradient(135deg, rgba(245,158,11,0.25) 0%, rgba(217,119,6,0.2) 100%)',
        trackBorder: '1px solid rgba(251,191,36,0.25)',
        shimmer: 'rgba(251,191,36,0.08)',
        shimmerPeak: 'rgba(251,191,36,0.15)',
        labelColor: 'text-amber-300/70',
        thumbBg: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
        thumbShadow: '0 4px 16px rgba(245,158,11,0.4), 0 0 20px rgba(245,158,11,0.15)',
        loadingTrack: 'linear-gradient(135deg, rgba(245,158,11,0.15) 0%, rgba(217,119,6,0.1) 100%)',
        loadingBorder: '1px solid rgba(245,158,11,0.2)',
        spinnerBorder: 'border-amber-400',
        loadingTextColor: 'text-amber-300',
    },
    sky: {
        track: 'linear-gradient(135deg, rgba(14,165,233,0.25) 0%, rgba(2,132,199,0.2) 100%)',
        trackBorder: '1px solid rgba(56,189,248,0.25)',
        shimmer: 'rgba(56,189,248,0.08)',
        shimmerPeak: 'rgba(56,189,248,0.15)',
        labelColor: 'text-sky-300/70',
        thumbBg: 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)',
        thumbShadow: '0 4px 16px rgba(14,165,233,0.4), 0 0 20px rgba(14,165,233,0.15)',
        loadingTrack: 'linear-gradient(135deg, rgba(14,165,233,0.15) 0%, rgba(2,132,199,0.1) 100%)',
        loadingBorder: '1px solid rgba(56,189,248,0.2)',
        spinnerBorder: 'border-sky-400',
        loadingTextColor: 'text-sky-300',
    },
};

const THUMB_SIZE = 56; // 48px thumb plus the track's 4px clearance at either end.
const SLIDE_THRESHOLD = 0.85;

export const SlideToAction: React.FC<SlideToActionProps> = ({
    label,
    thumbIcon,
    onConfirm,
    loading = false,
    loadingText = 'Processing…',
    disabled = false,
    theme = 'emerald',
}) => {
    const trackRef = useRef<HTMLDivElement>(null);
    // Track geometry captured on pointerdown. The track is full-width with a
    // fixed height, so re-measuring on every pointermove — and again in the
    // render body — only forced synchronous layout for the same numbers.
    const trackRectRef = useRef({
        left: 0,
        width: 0,
        maxTravel: 0,
        startX: 0,
        scaleX: 1,
        viewportWidth: 0,
        viewportHeight: 0,
    });
    const activePointerRef = useRef<number | null>(null);
    const [slideX, setSlideX] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    // Live offset alongside state: the threshold check on release must
    // read the position of the LAST move, not the last render — a fast
    // decisive flick could end before React flushed the final
    // setSlideX, read a stale value just under the threshold, and snap
    // back even though the finger reached the end.
    const slideXRef = useRef(0);

    const colors = THEMES[theme];

    const setSlide = useCallback((v: number) => {
        slideXRef.current = v;
        setSlideX(v);
    }, []);

    const resetGesture = useCallback(() => {
        const pointerId = activePointerRef.current;
        activePointerRef.current = null;
        setIsDragging(false);
        setSlide(0);
        if (pointerId !== null) {
            try {
                trackRef.current?.releasePointerCapture?.(pointerId);
            } catch {
                /* Safari can release capture before delivering cancel. */
            }
        }
    }, [setSlide]);

    const handlePointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (disabled || loading || activePointerRef.current !== null || e.button !== 0 || e.isPrimary === false)
                return;
            const rect = e.currentTarget.getBoundingClientRect();
            const localWidth = e.currentTarget.offsetWidth || rect.width;
            const scaleX = localWidth > 0 ? rect.width / localWidth : 1;
            const maxTravel = Math.max(0, localWidth - THUMB_SIZE);
            // Sliding must start at the thumb, never at the destination. Use
            // the rendered track's coordinates, independent of viewport width.
            if (maxTravel === 0 || e.clientX < rect.left || e.clientX - rect.left > THUMB_SIZE * scaleX) return;
            activePointerRef.current = e.pointerId ?? -1;
            trackRectRef.current = {
                left: rect.left,
                width: rect.width,
                maxTravel,
                startX: e.clientX,
                scaleX,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
            };
            // Capture the pointer: every subsequent move/up/cancel routes
            // to this element no matter where the finger wanders. Without
            // capture, touch sequences that left the element (or were
            // cancelled by iOS for a system gesture/notification banner)
            // never delivered their end event — the thumb froze
            // mid-track (field bug 2026-06-13, Anchor Watch).
            try {
                e.currentTarget.setPointerCapture?.(e.pointerId);
            } catch {
                /* capture is best-effort — jsdom and odd inputs lack it */
            }
            setIsDragging(true);
        },
        [disabled, loading],
    );

    const handlePointerMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (activePointerRef.current !== (e.pointerId ?? -1) || !trackRef.current) return;
            const { maxTravel, startX, scaleX } = trackRectRef.current;
            const offset = (e.clientX - startX) / scaleX;
            setSlide(Math.max(0, Math.min(offset, maxTravel)));
        },
        [setSlide],
    );

    const handlePointerUp = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (activePointerRef.current !== (e.pointerId ?? -1) || !trackRef.current) return;
            // WebKit can deliver pointerup before its queued resize event or
            // ResizeObserver callback. Validate the current geometry at the
            // release boundary too, so that ordering cannot confirm a drag.
            const current = trackRef.current.getBoundingClientRect();
            const captured = trackRectRef.current;
            const geometryUnchanged =
                Math.abs(current.left - captured.left) < 0.5 &&
                Math.abs(current.width - captured.width) < 0.5 &&
                window.innerWidth === captured.viewportWidth &&
                window.innerHeight === captured.viewportHeight;
            const ratio = slideXRef.current / trackRectRef.current.maxTravel;
            resetGesture();
            if (!disabled && !loading && geometryUnchanged && ratio >= SLIDE_THRESHOLD) {
                triggerHaptic('medium');
                onConfirm();
            }
        },
        [disabled, loading, onConfirm, resetGesture],
    );

    const handlePointerCancel = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            // iOS cancels (not ends) the touch for system gestures, incoming
            // banners, palm rejection. Never confirm from a cancel — just
            // spring back.
            if (activePointerRef.current !== (e.pointerId ?? -1)) return;
            resetGesture();
        },
        [resetGesture],
    );

    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (disabled || loading || event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            triggerHaptic('medium');
            onConfirm();
        },
        [disabled, loading, onConfirm],
    );

    // Rotation, iPad multitasking, a lost pointer, or a loading-state change
    // invalidates the gesture. A stale full-width measurement must never drive
    // a thumb inside the newly narrowed pane or confirm on the subsequent up.
    useEffect(() => {
        if (disabled || loading) resetGesture();
    }, [disabled, loading, resetGesture]);

    useEffect(() => {
        if (!isDragging) return;
        // ResizeObserver delivers an initial size even when nothing changed.
        let initialWidth = trackRef.current?.getBoundingClientRect().width;
        const geometryObserver =
            typeof ResizeObserver === 'undefined'
                ? null
                : new ResizeObserver(() => {
                      const width = trackRef.current?.getBoundingClientRect().width;
                      if (width !== initialWidth) resetGesture();
                      initialWidth = width;
                  });
        if (trackRef.current) geometryObserver?.observe(trackRef.current);
        window.addEventListener('resize', resetGesture);
        window.addEventListener('orientationchange', resetGesture);
        window.addEventListener('blur', resetGesture);
        return () => {
            geometryObserver?.disconnect();
            window.removeEventListener('resize', resetGesture);
            window.removeEventListener('orientationchange', resetGesture);
            window.removeEventListener('blur', resetGesture);
        };
    }, [isDragging, resetGesture]);

    if (loading) {
        return (
            <div
                className="w-full h-14 rounded-full flex items-center justify-center gap-3"
                style={{ background: colors.loadingTrack, border: colors.loadingBorder }}
            >
                <div
                    className={`w-5 h-5 border-2 ${colors.spinnerBorder} border-t-transparent rounded-full animate-spin`}
                />
                <span className={`text-sm ${colors.loadingTextColor} font-bold`}>{loadingText}</span>
            </div>
        );
    }

    const labelOpacity = trackRectRef.current.maxTravel > 0 ? 1 - slideX / trackRectRef.current.maxTravel : 1;

    return (
        <div
            ref={trackRef}
            className="relative w-full h-14 rounded-full overflow-hidden select-none"
            style={{
                background: colors.track,
                border: colors.trackBorder,
                touchAction: 'none',
                opacity: disabled ? 0.4 : 1,
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onLostPointerCapture={handlePointerCancel}
            onKeyDown={handleKeyDown}
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-disabled={disabled}
            aria-label={label}
        >
            {/* Shimmer animation */}
            <div className="absolute inset-0 overflow-hidden rounded-full pointer-events-none">
                <div
                    className="absolute inset-0"
                    style={{
                        background: `linear-gradient(90deg, transparent 0%, ${colors.shimmer} 30%, ${colors.shimmerPeak} 50%, ${colors.shimmer} 70%, transparent 100%)`,
                        animation: 'slideToActionShimmer 2.5s ease-in-out infinite',
                    }}
                />
            </div>

            {/* Label text */}
            <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
                style={{ opacity: labelOpacity }}
            >
                <span className={`text-sm font-bold ${colors.labelColor} tracking-wider uppercase`}>{label}</span>
            </div>

            {/* Draggable thumb */}
            <div
                className="absolute top-1 left-1 w-12 h-12 rounded-full flex items-center justify-center cursor-grab active:cursor-grabbing transition-shadow"
                style={{
                    transform: `translateX(${slideX}px)`,
                    background: colors.thumbBg,
                    boxShadow: colors.thumbShadow,
                    transition: isDragging ? 'none' : 'transform 0.3s ease',
                }}
            >
                {thumbIcon}
            </div>
        </div>
    );
};
