/**
 * ThalassaHelixControl — Unified map scrubber + legend control
 *
 * Placement: Bottom-right map corner.
 *
 * Features:
 *   1. Horizontal timeline scrubber with minimalist handle + haptic feedback
 *   2. Double-tap handle to snap back to "Live"
 *   3. Generic vertical color bar legend (↑ High/Red → ↓ Low/Blue)
 *   4. Layer icons stack for active fuzzy layers
 *   5. Semi-transparent glassmorphism background
 *   6. Play/pause toggle for animated layers
 *   7. RAF-throttled drag for butter-smooth scrubbing
 */
import React, { useRef, useCallback, useEffect, memo, useState } from 'react';
import { triggerHaptic } from '../../utils/system';

// ── Layer definitions for the generic legend ──
export type HelixLayer =
    | 'wind'
    | 'rain'
    | 'temperature'
    | 'clouds'
    | 'pressure'
    | 'velocity'
    | 'traffic'
    | 'currents'
    | null;

interface LayerConfig {
    icon: string;
    label: string;
    lowLabel: string;
    highLabel: string;
    gradient: string;
    accentColor: string;
}

const LAYER_CONFIGS: Record<string, LayerConfig> = {
    wind: {
        icon: '💨',
        label: 'Wind',
        lowLabel: 'Calm',
        highLabel: 'Storm',
        gradient: 'linear-gradient(to top, #8ca5c7, #a8b08c, #d9bf80, #d9a060, #cc6650, #e05a50)',
        accentColor: '#38bdf8',
    },
    velocity: {
        icon: '🌊',
        label: 'Current',
        lowLabel: 'Calm',
        highLabel: 'Storm',
        gradient: 'linear-gradient(to top, #8ca5c7, #a8b08c, #d9bf80, #d9a060, #cc6650, #e05a50)',
        accentColor: '#38bdf8',
    },
    currents: {
        icon: '🌊',
        label: 'Currents',
        lowLabel: 'Slack',
        highLabel: 'Rip',
        // Matches the raster-particle color ramp in useOceanCurrentParticleLayer.ts
        gradient: 'linear-gradient(to top, #cffafe, #22d3ee, #eab308, #f97316, #ef4444)',
        accentColor: '#06b6d4',
    },
    rain: {
        icon: '🌧️',
        label: 'Rain',
        lowLabel: 'Light',
        highLabel: 'Heavy',
        gradient:
            'linear-gradient(to top, rgba(0,72,120,0.9), rgba(0,150,210,0.9), rgba(56,190,230,0.9), rgba(250,235,0,0.9), rgba(250,180,0,0.9), rgba(200,0,0,0.95))',
        accentColor: '#34d399',
    },
    temperature: {
        icon: '🌡️',
        label: 'Temp',
        lowLabel: 'Cold',
        highLabel: 'Hot',
        gradient: 'linear-gradient(to top, #0000cd, #00bfff, #90ee90, #ffff00, #ff8c00, #ff0000)',
        accentColor: '#fbbf24',
    },
    clouds: {
        icon: '☁️',
        label: 'Clouds',
        lowLabel: 'Clear',
        highLabel: 'Thick',
        gradient: 'linear-gradient(to top, #1e3a5f, #4a7da8, #8bb8d0, #c0d8e8, #e8f0f4, #ffffff)',
        accentColor: '#94a3b8',
    },
    pressure: {
        icon: '📊',
        label: 'Baro',
        lowLabel: 'Low',
        highLabel: 'High',
        gradient: 'linear-gradient(to top, #6366f1, #38bdf8, #a7f3d0, #fbbf24, #ef4444)',
        accentColor: '#a78bfa',
    },
    traffic: {
        icon: '🚢',
        label: 'AIS',
        lowLabel: '↓',
        highLabel: '↑',
        gradient: 'linear-gradient(to top, #1e40af, #38bdf8, #fbbf24, #ef4444)',
        accentColor: '#f97316',
    },
};

// ── Props ──

export interface ThalassaHelixControlProps {
    /** Currently active weather/data layer */
    activeLayer: HelixLayer;
    /** Current scrubber frame index */
    frameIndex: number;
    /** Total number of frames */
    totalFrames: number;
    /** Human-readable label for current position (e.g. "Now", "+3h", "15:30") */
    frameLabel: string;
    /** Secondary label (e.g. "Forecast", "Radar", "Live") */
    sublabel?: string;
    /** Whether timeline is playing */
    isPlaying: boolean;
    /** Whether data is still loading */
    isLoading?: boolean;
    /** Frames ready so far (for progress indicator) */
    framesReady?: number;
    /** Whether this is embedded mode */
    embedded?: boolean;
    /** Callback: user is scrubbing to a new frame */
    onScrub: (frameIndex: number) => void;
    /** Callback: scrub started (should pause playback) */
    onScrubStart?: () => void;
    /** Callback: play/pause toggle */
    onPlayToggle: () => void;
    /** Callback: direct frame application during drag (RAF-throttled internally) */
    applyFrame?: (frameIndex: number) => void;
    /** "Now" marker index (for rain: separates radar from forecast) */
    nowIndex?: number;
    /** Whether the "now" region uses a different color */
    dualColor?: boolean;
    /** Accent color for forecast portion (when dualColor) */
    forecastAccent?: string;
}

export const ThalassaHelixControl: React.FC<ThalassaHelixControlProps> = memo(
    ({
        activeLayer,
        frameIndex,
        totalFrames,
        frameLabel,
        sublabel = 'Live',
        isPlaying,
        isLoading,
        framesReady,
        embedded,
        onScrub,
        onScrubStart,
        onPlayToggle,
        applyFrame,
        nowIndex,
        dualColor,
        forecastAccent = '#fbbf24',
    }) => {
        // ── Refs for smooth DOM-direct drag ──
        const trackRef = useRef<HTMLDivElement>(null);
        const thumbRef = useRef<HTMLDivElement>(null);
        const fillRef = useRef<HTMLDivElement>(null);
        const isDraggingRef = useRef(false);
        const lastAppliedRef = useRef(-1);
        const rafRef = useRef<number | null>(null);
        const lastTapRef = useRef(0); // For double-tap detection
        const [showLegend, setShowLegend] = useState(true);

        const config = activeLayer ? LAYER_CONFIGS[activeLayer] : null;
        const maxFrame = Math.max(0, totalFrames - 1);
        const hasScrubber = totalFrames > 1;
        const accent = config?.accentColor ?? '#38bdf8';

        // ── Frame → position conversion ──
        const frameToPercent = useCallback((f: number) => (maxFrame > 0 ? (f / maxFrame) * 100 : 0), [maxFrame]);

        const posToFrame = useCallback(
            (clientX: number) => {
                const track = trackRef.current;
                if (!track || maxFrame === 0) return 0;
                const rect = track.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                return Math.round(ratio * maxFrame);
            },
            [maxFrame],
        );

        // ── Direct DOM updates (zero React re-renders during drag) ──
        const updateVisuals = useCallback(
            (frame: number) => {
                const pct = frameToPercent(frame);
                if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
                if (fillRef.current) fillRef.current.style.width = `${pct}%`;
            },
            [frameToPercent],
        );

        // ── RAF-throttled apply ──
        const scheduleApply = useCallback(
            (frame: number) => {
                if (lastAppliedRef.current === frame) return;
                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    lastAppliedRef.current = frame;
                    applyFrame?.(frame);
                    rafRef.current = null;
                });
            },
            [applyFrame],
        );

        // ── Double-tap to snap to Live ──
        const handleDoubleTap = useCallback(() => {
            triggerHaptic('heavy');
            onScrub(0); // Snap to first frame ("Live")
            applyFrame?.(0);
            updateVisuals(0);
        }, [onScrub, applyFrame, updateVisuals]);

        // ── Pointer handlers ──
        const handlePointerDown = useCallback(
            (e: React.PointerEvent) => {
                // Double-tap detection
                const now = Date.now();
                if (now - lastTapRef.current < 300) {
                    handleDoubleTap();
                    lastTapRef.current = 0;
                    return;
                }
                lastTapRef.current = now;

                e.preventDefault();
                e.stopPropagation();
                isDraggingRef.current = true;
                onScrubStart?.();
                (e.target as HTMLElement).setPointerCapture(e.pointerId);

                const frame = posToFrame(e.clientX);
                updateVisuals(frame);
                scheduleApply(frame);
                triggerHaptic('light');

                if (thumbRef.current) {
                    thumbRef.current.style.transform = 'translate(-50%, -50%) scale(1.5)';
                }
            },
            [posToFrame, updateVisuals, scheduleApply, onScrubStart, handleDoubleTap],
        );

        const handlePointerMove = useCallback(
            (e: React.PointerEvent) => {
                if (!isDraggingRef.current) return;
                e.preventDefault();
                const frame = posToFrame(e.clientX);
                updateVisuals(frame);
                scheduleApply(frame);
            },
            [posToFrame, updateVisuals, scheduleApply],
        );

        const handlePointerUp = useCallback(
            (e: React.PointerEvent) => {
                if (!isDraggingRef.current) return;
                isDraggingRef.current = false;
                const frame = posToFrame(e.clientX);
                updateVisuals(frame);
                applyFrame?.(frame);
                onScrub(frame);

                if (thumbRef.current) {
                    thumbRef.current.style.transform = 'translate(-50%, -50%) scale(1)';
                }
            },
            [posToFrame, updateVisuals, applyFrame, onScrub],
        );

        // ── Sync visuals from external state changes (play, reset) ──
        useEffect(() => {
            if (!isDraggingRef.current) updateVisuals(frameIndex);
        }, [frameIndex, updateVisuals]);

        // Cleanup RAF
        useEffect(() => {
            return () => {
                if (rafRef.current) cancelAnimationFrame(rafRef.current);
            };
        }, []);

        // Don't render if no active layer
        if (!activeLayer || !config) return null;

        return (
            <div
                className="absolute z-[500] flex items-end gap-2"
                style={{
                    left: 12,
                    bottom: embedded ? 12 : 'calc(80px + env(safe-area-inset-bottom))',
                    maxWidth: '90vw',
                }}
            >
                {/* ═══ VERTICAL LEGEND BAR ═══ */}
                {showLegend && (
                    <div
                        className="flex flex-col items-center gap-1 animate-in fade-in duration-200"
                        style={{
                            background: 'rgba(15, 23, 42, 0.75)',
                            backdropFilter: 'blur(16px)',
                            WebkitBackdropFilter: 'blur(16px)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: 14,
                            padding: '8px 6px',
                        }}
                    >
                        {/* High indicator */}
                        <span className="text-[11px] font-black text-red-400/70 uppercase tracking-wider">↑</span>
                        <span className="text-[7px] font-bold text-white/40 uppercase">{config.highLabel}</span>

                        {/* Color bar */}
                        <div
                            className="rounded-full"
                            style={{
                                width: 6,
                                height: 64,
                                background: config.gradient,
                            }}
                        />

                        {/* Low indicator */}
                        <span className="text-[7px] font-bold text-white/40 uppercase">{config.lowLabel}</span>
                        <span className="text-[11px] font-black text-blue-400/70 uppercase tracking-wider">↓</span>

                        {/* Layer icon */}
                        <button
                            onClick={() => setShowLegend(false)}
                            className="mt-1 w-7 h-7 flex items-center justify-center rounded-lg bg-white/[0.04] hover:bg-white/[0.08] transition-colors"
                            aria-label={`${config.label} layer`}
                        >
                            <span className="text-sm">{config.icon}</span>
                        </button>
                    </div>
                )}

                {/* ═══ MAIN CONTROL — SCRUBBER + TIME ═══ */}
                <div
                    style={{
                        background: 'rgba(15, 23, 42, 0.80)',
                        backdropFilter: 'blur(20px)',
                        WebkitBackdropFilter: 'blur(20px)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 16,
                        padding: hasScrubber ? '8px 12px' : '6px 12px',
                        minWidth: hasScrubber ? 200 : 120,
                        maxWidth: 280,
                    }}
                >
                    {/* Loading state */}
                    {isLoading && (
                        <div className="flex items-center justify-center gap-2 py-1">
                            <div
                                className="w-3 h-3 border-2 rounded-full animate-spin"
                                style={{
                                    borderColor: `${accent}40`,
                                    borderTopColor: accent,
                                }}
                            />
                            <span className="text-[11px] font-bold" style={{ color: `${accent}cc` }}>
                                Loading…
                            </span>
                        </div>
                    )}

                    {/* Scrubber row */}
                    {hasScrubber && !isLoading && (
                        <div className="flex items-center gap-2">
                            {/* Play/Pause */}
                            <button
                                aria-label="Toggle option"
                                onClick={() => {
                                    onPlayToggle();
                                    triggerHaptic('light');
                                }}
                                className="w-7 h-7 flex items-center justify-center rounded-lg shrink-0 active:scale-90 transition-transform"
                                style={{
                                    background: `${accent}20`,
                                    border: `1px solid ${accent}30`,
                                }}
                            >
                                <span className="text-xs">{isPlaying ? '⏸' : '▶️'}</span>
                            </button>

                            {/* Track */}
                            <div
                                ref={trackRef}
                                className="flex-1 relative h-9 flex items-center cursor-pointer"
                                style={{ touchAction: 'none' }}
                                onPointerDown={handlePointerDown}
                                onPointerMove={handlePointerMove}
                                onPointerUp={handlePointerUp}
                                onPointerCancel={handlePointerUp}
                            >
                                {/* Track background */}
                                <div className="w-full h-1 bg-white/10 rounded-full relative overflow-hidden">
                                    {/* Fill */}
                                    <div
                                        ref={fillRef}
                                        className="absolute inset-y-0 left-0 rounded-full"
                                        style={{
                                            width: `${frameToPercent(frameIndex)}%`,
                                            background:
                                                dualColor && nowIndex !== undefined && frameIndex > nowIndex
                                                    ? forecastAccent
                                                    : `${accent}60`,
                                            willChange: 'width',
                                        }}
                                    />
                                </div>

                                {/* NOW marker (diamond) */}
                                {nowIndex !== undefined && nowIndex > 0 && nowIndex < maxFrame && (
                                    <div
                                        className="absolute top-1/2 pointer-events-none"
                                        style={{
                                            left: `${frameToPercent(nowIndex)}%`,
                                            transform: 'translate(-50%, -50%)',
                                        }}
                                    >
                                        <div className="w-2 h-2 bg-white rounded-sm rotate-45 shadow-sm border border-white/60" />
                                    </div>
                                )}

                                {/* Thumb */}
                                <div
                                    ref={thumbRef}
                                    className="absolute top-1/2 w-4 h-4 rounded-full shadow-lg border-2 border-white/40 pointer-events-none"
                                    style={{
                                        left: `${frameToPercent(frameIndex)}%`,
                                        transform: 'translate(-50%, -50%) scale(1)',
                                        background: accent,
                                        boxShadow: `0 3px 10px ${accent}40`,
                                        transition: isDraggingRef.current ? 'none' : 'transform 0.15s ease-out',
                                        willChange: 'left, transform',
                                    }}
                                />

                                {/* Loading progress */}
                                {framesReady !== undefined && framesReady < totalFrames && (
                                    <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-white/5 rounded-full overflow-hidden">
                                        <div
                                            className="h-full rounded-full transition-all duration-200"
                                            style={{
                                                width: `${(framesReady / totalFrames) * 100}%`,
                                                background: `${accent}50`,
                                            }}
                                        />
                                    </div>
                                )}
                            </div>

                            {/* Time label */}
                            <div className="shrink-0 text-right min-w-[44px]">
                                <p className="text-[11px] font-black text-white leading-tight">{frameLabel}</p>
                                <p
                                    className="text-[11px] font-bold uppercase tracking-widest leading-tight"
                                    style={{
                                        color:
                                            frameLabel === 'Now' || frameLabel === 'Live'
                                                ? `${accent}90`
                                                : `${forecastAccent}`,
                                    }}
                                >
                                    {sublabel}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* No-scrubber mode: just show layer + live status */}
                    {!hasScrubber && !isLoading && (
                        <div className="flex items-center gap-2 py-0.5">
                            <span className="text-sm">{config.icon}</span>
                            <span className="text-[11px] font-black text-white">{config.label}</span>
                            <span
                                className="ml-auto text-[11px] font-bold uppercase tracking-widest"
                                style={{ color: `${accent}90` }}
                            >
                                ● Live
                            </span>
                        </div>
                    )}
                </div>

                {/* Collapsed legend toggle (when legend hidden) */}
                {!showLegend && (
                    <button
                        onClick={() => setShowLegend(true)}
                        className="w-8 h-8 flex items-center justify-center rounded-xl transition-colors"
                        style={{
                            background: 'rgba(15, 23, 42, 0.75)',
                            backdropFilter: 'blur(16px)',
                            WebkitBackdropFilter: 'blur(16px)',
                            border: '1px solid rgba(255,255,255,0.08)',
                        }}
                        aria-label="Show legend"
                    >
                        <span className="text-sm">{config.icon}</span>
                    </button>
                )}
            </div>
        );
    },
);

ThalassaHelixControl.displayName = 'ThalassaHelixControl';

// ── Multi-Legend Dock (2+ weather layers active → side-by-side legends, no scrubber) ──

export interface LegendDockProps {
    layers: HelixLayer[];
    embedded?: boolean;
}

export const LegendDock: React.FC<LegendDockProps> = memo(({ layers, embedded }) => {
    const validLayers = layers.filter((l): l is NonNullable<HelixLayer> => !!l && !!LAYER_CONFIGS[l]);
    if (validLayers.length === 0) return null;

    return (
        <div
            className="absolute z-[500] flex items-end gap-2 animate-in fade-in duration-200"
            style={{
                left: 12,
                bottom: embedded ? 12 : 'calc(80px + env(safe-area-inset-bottom))',
            }}
        >
            {validLayers.map((layer) => {
                const config = LAYER_CONFIGS[layer];
                if (!config) return null;
                return (
                    <div
                        key={layer}
                        className="flex flex-col items-center gap-1"
                        style={{
                            background: 'rgba(15, 23, 42, 0.75)',
                            backdropFilter: 'blur(16px)',
                            WebkitBackdropFilter: 'blur(16px)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: 14,
                            padding: '8px 6px',
                        }}
                    >
                        <span className="text-[11px] font-black text-red-400/70 uppercase tracking-wider">↑</span>
                        <span className="text-[7px] font-bold text-white/40 uppercase">{config.highLabel}</span>
                        <div className="rounded-full" style={{ width: 6, height: 64, background: config.gradient }} />
                        <span className="text-[7px] font-bold text-white/40 uppercase">{config.lowLabel}</span>
                        <span className="text-[11px] font-black text-blue-400/70 uppercase tracking-wider">↓</span>
                        <div className="mt-1 w-7 h-7 flex items-center justify-center rounded-lg bg-white/[0.04]">
                            <span className="text-sm">{config.icon}</span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
});

LegendDock.displayName = 'LegendDock';
