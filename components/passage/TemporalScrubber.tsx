/**
 * TemporalScrubber — The 4th Dimension Controller
 *
 * Butter-smooth custom timeline scrubber matching the SynopticScrubber style.
 * No native <input type="range"> — custom div-based track/thumb with
 * pointer events for cross-platform (mouse + touch) smoothness.
 */

import React, { useState, useEffect, useCallback, useRef, memo } from 'react';

interface TemporalScrubberProps {
    maxTimeHours: number;
    currentHour: number;
    onChange: (hour: number) => void;
    /** Playback speed multiplier (default: 1 = 100ms per hour) */
    playbackSpeed?: number;
    /** Whether the route is still computing */
    computing?: boolean;
}

const TemporalScrubber: React.FC<TemporalScrubberProps> = memo(({
    maxTimeHours,
    currentHour,
    onChange,
    playbackSpeed = 1,
    computing = false,
}) => {
    const [isPlaying, setIsPlaying] = useState(false);
    const intervalRef = useRef<ReturnType<typeof setInterval>>();
    const trackRef = useRef<HTMLDivElement>(null);
    const thumbRef = useRef<HTMLDivElement>(null);
    const fillRef = useRef<HTMLDivElement>(null);
    const labelRef = useRef<HTMLParagraphElement>(null);
    const isDraggingRef = useRef(false);
    const rafRef = useRef<number | null>(null);

    // ── Auto-playback ──
    useEffect(() => {
        if (isPlaying && maxTimeHours > 0) {
            const tickMs = Math.max(50, 100 / playbackSpeed);
            intervalRef.current = setInterval(() => {
                onChange(Math.min(currentHour + 0.5, maxTimeHours));
                if (currentHour >= maxTimeHours - 0.5) {
                    setIsPlaying(false);
                }
            }, tickMs);
        }
        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, [isPlaying, currentHour, maxTimeHours, playbackSpeed, onChange]);

    const togglePlay = useCallback(() => {
        if (currentHour >= maxTimeHours) {
            onChange(0);
        }
        setIsPlaying(p => !p);
    }, [currentHour, maxTimeHours, onChange]);

    // ── Time formatting ──
    const formatTime = (hours: number): string => {
        const days = Math.floor(hours / 24);
        const h = Math.floor(hours % 24);
        const m = Math.round((hours % 1) * 60);
        if (days > 0) {
            return `Day ${days + 1}, ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }
        return `+${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    const formatETA = (hours: number): string => {
        const days = Math.floor(hours / 24);
        const h = Math.round(hours % 24);
        if (days > 0) return `${days}d ${h}h`;
        return `${h}h`;
    };

    // ── Position helpers ──
    const positionToHour = useCallback((clientX: number) => {
        const track = trackRef.current;
        if (!track || maxTimeHours <= 0) return 0;
        const rect = track.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        // Snap to 0.5h increments
        return Math.round((ratio * maxTimeHours) * 2) / 2;
    }, [maxTimeHours]);

    // ── Direct DOM updates (zero React renders during drag) ──
    const updateVisuals = useCallback((hour: number) => {
        const pct = maxTimeHours > 0 ? (hour / maxTimeHours) * 100 : 0;
        if (thumbRef.current) {
            thumbRef.current.style.left = `${pct}%`;
        }
        if (fillRef.current) {
            fillRef.current.style.width = `${pct}%`;
        }
        if (labelRef.current) {
            labelRef.current.textContent = computing ? '— : —' : formatTime(hour);
        }
    }, [maxTimeHours, computing]);

    // ── Pointer event handlers (butter-smooth, no React renders during drag) ──
    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        isDraggingRef.current = true;
        setIsPlaying(false);

        (e.target as HTMLElement).setPointerCapture(e.pointerId);

        const hour = positionToHour(e.clientX);
        updateVisuals(hour);
        onChange(hour);

        if (thumbRef.current) {
            thumbRef.current.style.transform = 'translate(-50%, -50%) scale(1.4)';
        }
    }, [positionToHour, updateVisuals, onChange]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!isDraggingRef.current) return;
        e.preventDefault();

        const hour = positionToHour(e.clientX);
        updateVisuals(hour);

        // RAF-throttled onChange
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
            onChange(hour);
            rafRef.current = null;
        });
    }, [positionToHour, updateVisuals, onChange]);

    const handlePointerUp = useCallback((e: React.PointerEvent) => {
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;

        const hour = positionToHour(e.clientX);
        updateVisuals(hour);
        onChange(hour);

        if (thumbRef.current) {
            thumbRef.current.style.transform = 'translate(-50%, -50%) scale(1)';
        }
    }, [positionToHour, updateVisuals, onChange]);

    // ── Sync visuals when React state changes from outside (play, reset) ──
    useEffect(() => {
        if (!isDraggingRef.current) {
            updateVisuals(currentHour);
        }
    }, [currentHour, updateVisuals]);

    // ── Cleanup RAF on unmount ──
    useEffect(() => {
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, []);

    const fillPct = maxTimeHours > 0 ? (currentHour / maxTimeHours) * 100 : 0;

    return (
        <div
            style={{
                position: 'absolute',
                bottom: 0,
                left: 16,
                right: 16,
                zIndex: 50,
                paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
            }}
        >
            <div
                style={{
                    background: 'rgba(15, 23, 42, 0.9)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: 16,
                    padding: '10px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                }}
            >
                {/* Play / Pause */}
                <button
                    onClick={togglePlay}
                    disabled={computing || maxTimeHours === 0}
                    style={{
                        width: 32,
                        height: 32,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 10,
                        background: 'rgba(56, 189, 248, 0.2)',
                        border: '1px solid rgba(56, 189, 248, 0.3)',
                        color: '#38bdf8',
                        cursor: computing ? 'not-allowed' : 'pointer',
                        flexShrink: 0,
                        opacity: computing ? 0.3 : 1,
                        transition: 'transform 0.15s ease',
                    }}
                    aria-label={isPlaying ? 'Pause simulation' : 'Play simulation'}
                >
                    <span style={{ fontSize: 14 }}>{isPlaying ? '⏸' : '▶️'}</span>
                </button>

                {/* Custom track */}
                <div
                    ref={trackRef}
                    style={{
                        flex: 1,
                        position: 'relative',
                        height: 40,
                        display: 'flex',
                        alignItems: 'center',
                        cursor: 'pointer',
                        touchAction: 'none',
                    }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                >
                    {/* Track background */}
                    <div style={{
                        width: '100%',
                        height: 6,
                        background: 'rgba(255, 255, 255, 0.1)',
                        borderRadius: 3,
                        position: 'relative',
                        overflow: 'hidden',
                    }}>
                        {/* Active fill */}
                        <div
                            ref={fillRef}
                            style={{
                                position: 'absolute',
                                top: 0,
                                bottom: 0,
                                left: 0,
                                width: `${fillPct}%`,
                                background: 'rgba(56, 189, 248, 0.4)',
                                borderRadius: 3,
                                willChange: 'width',
                            }}
                        />
                    </div>

                    {/* Thumb */}
                    <div
                        ref={thumbRef}
                        style={{
                            position: 'absolute',
                            top: '50%',
                            left: `${fillPct}%`,
                            width: 20,
                            height: 20,
                            background: '#38bdf8',
                            borderRadius: '50%',
                            border: '2px solid rgba(255, 255, 255, 0.4)',
                            boxShadow: '0 2px 8px rgba(56, 189, 248, 0.3)',
                            transform: 'translate(-50%, -50%) scale(1)',
                            transition: isDraggingRef.current ? 'none' : 'transform 0.15s ease-out',
                            willChange: 'left, transform',
                            pointerEvents: 'none',
                        }}
                    />
                </div>

                {/* Time label */}
                <div style={{ flexShrink: 0, textAlign: 'right', minWidth: 64 }}>
                    <p
                        ref={labelRef}
                        style={{
                            margin: 0,
                            fontSize: 12,
                            fontWeight: 900,
                            color: '#fff',
                            lineHeight: 1.2,
                            fontFamily: 'system-ui, sans-serif',
                        }}
                    >
                        {computing ? '— : —' : formatTime(currentHour)}
                    </p>
                    <p style={{
                        margin: 0,
                        fontSize: 8,
                        color: '#64748b',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.1em',
                    }}>
                        {maxTimeHours > 0 ? `ETA +${formatETA(maxTimeHours)}` : 'Timeline'}
                    </p>
                </div>
            </div>
        </div>
    );
});

TemporalScrubber.displayName = 'TemporalScrubber';

export default TemporalScrubber;
