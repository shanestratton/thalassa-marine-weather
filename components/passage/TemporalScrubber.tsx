/**
 * TemporalScrubber — The 4th Dimension Controller
 *
 * A neon-glowing timeline slider that lets users scrub through
 * the future of their passage. Features play/pause auto-advance,
 * glowing fill bar, and formatted time readout.
 *
 * Design: Bioluminescent Dark Mode glassmorphism
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import '../../styles/bioluminescent.css';

interface TemporalScrubberProps {
    maxTimeHours: number;
    currentHour: number;
    onChange: (hour: number) => void;
    /** Playback speed multiplier (default: 1 = 100ms per hour) */
    playbackSpeed?: number;
    /** Whether the route is still computing */
    computing?: boolean;
}

const TemporalScrubber: React.FC<TemporalScrubberProps> = ({
    maxTimeHours,
    currentHour,
    onChange,
    playbackSpeed = 1,
    computing = false,
}) => {
    const [isPlaying, setIsPlaying] = useState(false);
    const intervalRef = useRef<ReturnType<typeof setInterval>>();

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
            // Reset to beginning if at the end
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

    const fillPct = maxTimeHours > 0 ? (currentHour / maxTimeHours) * 100 : 0;

    return (
        <div className="temporal-scrubber" style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 50,
            padding: '16px 24px',
            paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
        }}>
            {/* ── Top row: Controls + Readout ── */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-end',
                marginBottom: 12,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    {/* Play/Pause */}
                    <button
                        className="play-btn"
                        onClick={togglePlay}
                        aria-label={isPlaying ? 'Pause simulation' : 'Play simulation'}
                        disabled={computing}
                        style={{ opacity: computing ? 0.3 : 1 }}
                    >
                        {isPlaying ? (
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                                <rect x="3" y="2" width="4" height="12" rx="1" />
                                <rect x="9" y="2" width="4" height="12" rx="1" />
                            </svg>
                        ) : (
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M4 2.5v11l9-5.5z" />
                            </svg>
                        )}
                    </button>

                    {/* Time readout */}
                    <div>
                        <div className="bio-label" style={{ marginBottom: 2 }}>
                            Forecast Timeline
                        </div>
                        <div className="bio-data" style={{ fontSize: 20, letterSpacing: '0.08em' }}>
                            {computing ? '— : —' : formatTime(currentHour)}
                        </div>
                    </div>
                </div>

                {/* ETA */}
                <div style={{ textAlign: 'right' }}>
                    <div className="bio-label" style={{ marginBottom: 2 }}>
                        Arrival (ETA)
                    </div>
                    <div style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 16,
                        color: 'var(--text-primary)',
                        letterSpacing: '0.05em',
                    }}>
                        {computing ? '—' : `+${formatETA(maxTimeHours)}`}
                    </div>
                </div>
            </div>

            {/* ── Slider Track ── */}
            <div style={{ position: 'relative', width: '100%', height: 24, display: 'flex', alignItems: 'center' }}>
                {/* Glowing fill bar */}
                <div
                    style={{
                        position: 'absolute',
                        left: 0,
                        height: 4,
                        borderRadius: '2px 0 0 2px',
                        width: `${fillPct}%`,
                        background: 'linear-gradient(90deg, rgba(0,240,255,0.15) 0%, var(--neon-cyan) 100%)',
                        boxShadow: '0 0 12px rgba(0, 240, 255, 0.45)',
                        pointerEvents: 'none',
                        transition: isPlaying ? 'none' : 'width 0.08s linear',
                    }}
                />

                {/* Slider input */}
                <input
                    type="range"
                    min={0}
                    max={maxTimeHours || 100}
                    step={0.5}
                    value={currentHour}
                    onChange={(e) => {
                        setIsPlaying(false);
                        onChange(parseFloat(e.target.value));
                    }}
                    aria-label="Forecast timeline position"
                    aria-valuetext={computing ? 'Computing route' : formatTime(currentHour)}
                    className="neon-slider"
                    style={{ position: 'relative', zIndex: 10 }}
                    disabled={computing || maxTimeHours === 0}
                />
            </div>

            {/* ── Bottom markers ── */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: 4,
                fontSize: 9,
                fontFamily: "'JetBrains Mono', monospace",
                color: 'var(--text-dim)',
                letterSpacing: '0.05em',
            }}>
                <span>DEPARTURE</span>
                {maxTimeHours > 48 && <span>{formatETA(maxTimeHours / 2)}</span>}
                <span>ARRIVAL</span>
            </div>
        </div>
    );
};

export default TemporalScrubber;
