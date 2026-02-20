/**
 * SlideToAction — Reusable iOS-style "slide to confirm" action button.
 *
 * Extracted from AnchorWatchPage's slide-to-drop-anchor pattern.
 * Used for destructive or important actions: Start Tracking, Calculate Route, Drop Anchor, etc.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';

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
    theme?: 'emerald' | 'orange' | 'teal' | 'sky';
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
    orange: {
        track: 'linear-gradient(135deg, rgba(234,88,12,0.25) 0%, rgba(194,65,12,0.2) 100%)',
        trackBorder: '1px solid rgba(251,146,60,0.25)',
        shimmer: 'rgba(251,146,60,0.08)',
        shimmerPeak: 'rgba(251,146,60,0.15)',
        labelColor: 'text-orange-300/70',
        thumbBg: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)',
        thumbShadow: '0 4px 16px rgba(249,115,22,0.4), 0 0 20px rgba(249,115,22,0.15)',
        loadingTrack: 'linear-gradient(135deg, rgba(245,158,11,0.15) 0%, rgba(217,119,6,0.1) 100%)',
        loadingBorder: '1px solid rgba(245,158,11,0.2)',
        spinnerBorder: 'border-amber-400',
        loadingTextColor: 'text-amber-300',
    },
    teal: {
        track: 'linear-gradient(135deg, rgba(13,148,136,0.25) 0%, rgba(15,118,110,0.2) 100%)',
        trackBorder: '1px solid rgba(45,212,191,0.25)',
        shimmer: 'rgba(45,212,191,0.08)',
        shimmerPeak: 'rgba(45,212,191,0.15)',
        labelColor: 'text-teal-300/70',
        thumbBg: 'linear-gradient(135deg, #14b8a6 0%, #0d9488 100%)',
        thumbShadow: '0 4px 16px rgba(20,184,166,0.4), 0 0 20px rgba(20,184,166,0.15)',
        loadingTrack: 'linear-gradient(135deg, rgba(13,148,136,0.15) 0%, rgba(15,118,110,0.1) 100%)',
        loadingBorder: '1px solid rgba(45,212,191,0.2)',
        spinnerBorder: 'border-teal-400',
        loadingTextColor: 'text-teal-300',
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

const THUMB_SIZE = 56; // px (w-14 h-14 = 3.5rem = 56px)
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
    const [slideX, setSlideX] = useState(0);
    const [isDragging, setIsDragging] = useState(false);

    const colors = THEMES[theme];

    const handleStart = useCallback((clientX: number) => {
        if (disabled || loading) return;
        setIsDragging(true);
    }, [disabled, loading]);

    const handleMove = useCallback((clientX: number) => {
        if (!isDragging || !trackRef.current) return;
        const rect = trackRef.current.getBoundingClientRect();
        const maxTravel = rect.width - THUMB_SIZE;
        const offset = clientX - rect.left - THUMB_SIZE / 2;
        setSlideX(Math.max(0, Math.min(offset, maxTravel)));
    }, [isDragging]);

    const handleEnd = useCallback(() => {
        if (!isDragging || !trackRef.current) return;
        setIsDragging(false);
        const rect = trackRef.current.getBoundingClientRect();
        const maxTravel = rect.width - THUMB_SIZE;
        const ratio = slideX / maxTravel;
        if (ratio >= SLIDE_THRESHOLD) {
            onConfirm();
        }
        setSlideX(0);
    }, [isDragging, slideX, onConfirm]);

    // Reset slide position when not dragging
    useEffect(() => {
        if (!isDragging) setSlideX(0);
    }, [isDragging]);

    if (loading) {
        return (
            <div
                className="w-full h-14 rounded-full flex items-center justify-center gap-3"
                style={{ background: colors.loadingTrack, border: colors.loadingBorder }}
            >
                <div className={`w-5 h-5 border-2 ${colors.spinnerBorder} border-t-transparent rounded-full animate-spin`} />
                <span className={`text-sm ${colors.loadingTextColor} font-bold`}>{loadingText}</span>
            </div>
        );
    }

    const trackWidth = trackRef.current?.getBoundingClientRect().width ?? 300;
    const maxTravel = trackWidth - THUMB_SIZE;
    const labelOpacity = 1 - (slideX / maxTravel);

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
            onMouseDown={e => handleStart(e.clientX)}
            onMouseMove={e => handleMove(e.clientX)}
            onMouseUp={handleEnd}
            onMouseLeave={handleEnd}
            onTouchStart={e => handleStart(e.touches[0].clientX)}
            onTouchMove={e => handleMove(e.touches[0].clientX)}
            onTouchEnd={handleEnd}
        >
            {/* Shimmer animation */}
            <div className="absolute inset-0 overflow-hidden rounded-full pointer-events-none">
                <div className="absolute inset-0" style={{
                    background: `linear-gradient(90deg, transparent 0%, ${colors.shimmer} 30%, ${colors.shimmerPeak} 50%, ${colors.shimmer} 70%, transparent 100%)`,
                    animation: 'slideToActionShimmer 2.5s ease-in-out infinite',
                }} />
            </div>

            {/* Label text */}
            <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
                style={{ opacity: labelOpacity }}
            >
                <span className={`text-sm font-bold ${colors.labelColor} tracking-wider uppercase`}>
                    {label}
                </span>
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

            {/* Shimmer keyframe (injected once) */}
            <style>{`
                @keyframes slideToActionShimmer {
                    0%, 100% { transform: translateX(-100%); }
                    50% { transform: translateX(100%); }
                }
            `}</style>
        </div>
    );
};
