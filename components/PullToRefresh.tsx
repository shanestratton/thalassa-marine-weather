import React, { useState } from 'react';
import { triggerHaptic } from '../utils/system';

interface PullToRefreshProps {
    onRefresh: () => void;
    children: React.ReactNode;
    disabled?: boolean;
}

export const PullToRefresh: React.FC<PullToRefreshProps> = ({ onRefresh, children, disabled }) => {
    const [startY, setStartY] = useState(0);
    const [pullDistance, setPullDistance] = useState(0);
    const threshold = 120;
    const scrollRef = React.useRef<HTMLDivElement>(null);
    // Fires the threshold haptic exactly once per gesture — reset on touch end.
    const hapticFiredRef = React.useRef(false);

    const handleTouchStart = (e: React.TouchEvent) => {
        if (disabled) return;
        if (scrollRef.current && scrollRef.current.scrollTop <= 1) {
            setStartY(e.touches[0].clientY);
        }
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (startY > 0 && scrollRef.current && scrollRef.current.scrollTop <= 1) {
            const currentY = e.touches[0].clientY;
            const diff = currentY - startY;

            if (diff > 0) {
                // Prevent default specifically when pulling down to avoid browser refresh/scroll
                if (diff < 200) e.stopPropagation();
                const next = Math.min(diff * 0.5, 150);
                setPullDistance(next);
                if (next > threshold && !hapticFiredRef.current) {
                    hapticFiredRef.current = true;
                    triggerHaptic('light');
                }
            }
        }
    };

    const handleTouchEnd = () => {
        if (pullDistance > threshold) {
            onRefresh();
        }
        setStartY(0);
        setPullDistance(0);
        hapticFiredRef.current = false;
    };

    const pullProgress = Math.min(pullDistance / threshold, 1);
    const armed = pullDistance > threshold;

    return (
        <div
            id="app-scroll-container"
            ref={scrollRef}
            className={`relative h-full overflow-y-auto`}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
        >
            {/* Spinner floats above the content (absolute) instead of sitting
                in-flow at the left edge — pulling no longer shoves the page
                sideways mid-gesture. Opacity/scale grow with the pull; the
                tint flips to sky once the release threshold is armed. */}
            {pullDistance > 20 && (
                <div
                    aria-hidden="true"
                    className={`absolute top-3 left-1/2 -translate-x-1/2 z-10 animate-spin rounded-full h-8 w-8 border-4 border-t-transparent transition-colors ${
                        armed
                            ? 'border-sky-400 shadow-lg filter drop-shadow-[0_0_8px_rgba(56,189,248,0.8)]'
                            : 'border-slate-500'
                    }`}
                    style={{
                        opacity: pullProgress,
                        transform: `translateX(-50%) scale(${0.6 + 0.4 * pullProgress})`,
                    }}
                ></div>
            )}
            <div
                style={{
                    transform: `translateY(${pullDistance}px)`,
                    transition: startY === 0 ? 'transform 0.3s ease-out' : 'none',
                }}
                className={`flex-grow flex flex-col ${disabled ? 'h-full' : 'min-h-[101%]'}`}
            >
                {children}
            </div>
        </div>
    );
};
