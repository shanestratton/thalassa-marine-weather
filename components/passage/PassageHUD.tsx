/**
 * PassageHUD — Bioluminescent Heads-Up Display
 *
 * Dual sparkline telemetry showing Wind Speed and Wave Height across
 * the entire passage. Uses viewBox-based SVGs for perfect responsiveness.
 *
 * COLOUR SYSTEM (curated 3-accent):
 *   Primary:    sky-400  (#38bdf8) — all neutral data values & sparklines
 *   Warning:    amber    (#f59e0b) — moderate thresholds
 *   Danger:     rose-500 (#f43f5e) — dangerous thresholds
 *   Structural: slate-400/500 — labels, dividers, muted text
 */

import React, { useMemo } from 'react';
import type { TrackPoint, GhostShipState } from '../../types/spatiotemporal';
import '../../styles/bioluminescent.css';

// ── Colour Tokens (single source of truth) ──────────────────────────
const C = {
    primary: '#38bdf8',  // sky-400 — all neutral data
    primaryDim: 'rgba(56, 189, 248, 0.15)',
    primaryGlow: 'rgba(56, 189, 248, 0.5)',
    warning: '#f59e0b',  // amber-500 — moderate threshold
    danger: '#f43f5e',  // rose-500 — danger threshold
    label: '#64748b',  // slate-500 — all labels
    text: '#e2e8f0',  // slate-200 — body text
    textMuted: '#94a3b8',  // slate-400 — secondary text
    divider: 'rgba(56, 189, 248, 0.1)', // subtle divider
    dividerSubtle: 'rgba(255, 255, 255, 0.04)',
} as const;

/** Semantic colour for a value relative to its thresholds */
function semanticColor(value: number, warnAt: number, dangerAt: number): string {
    if (value > dangerAt) return C.danger;
    if (value > warnAt) return C.warning;
    return C.primary;
}

// ══════════════════════════════════════════════════════════════════
// SPARKLINE ENGINE — viewBox SVG with threshold lines
// ══════════════════════════════════════════════════════════════════

interface SparklinePathProps {
    track: TrackPoint[];
    dataKey: 'wind_spd_kts' | 'wave_ht_m';
    maxVal: number;
    height?: number;
    color: string;
    threshold?: number;
    cursorFraction?: number;
}

const SparklinePath: React.FC<SparklinePathProps> = ({
    track, dataKey, maxVal, height = 40, color,
    threshold, cursorFraction,
}) => {
    const pathD = useMemo(() => {
        if (!track.length || maxVal === 0) return '';
        const points = track.map((pt, i) => {
            const x = (i / (track.length - 1)) * 100;
            const val = pt.conditions[dataKey] ?? 0;
            const y = height - (val / maxVal) * height;
            return `${x},${y}`;
        });
        return `M ${points.join(' L ')}`;
    }, [track, dataKey, maxVal, height]);

    const areaD = useMemo(() => {
        if (!track.length || maxVal === 0) return '';
        const points = track.map((pt, i) => {
            const x = (i / (track.length - 1)) * 100;
            const val = pt.conditions[dataKey] ?? 0;
            const y = height - (val / maxVal) * height;
            return `${x},${y}`;
        });
        return `M 0,${height} L ${points.join(' L ')} L 100,${height} Z`;
    }, [track, dataKey, maxVal, height]);

    const thresholdY = threshold !== undefined
        ? height - (threshold / maxVal) * height
        : null;

    const cursorX = cursorFraction !== undefined
        ? cursorFraction * 100
        : null;

    return (
        <svg
            viewBox={`0 0 100 ${height}`}
            preserveAspectRatio="none"
            style={{
                width: '100%',
                height: 48,
                overflow: 'visible',
                display: 'block',
            }}
        >
            {/* Area fill */}
            <path
                d={areaD}
                fill={color}
                opacity={0.08}
            />

            {/* Main line */}
            <path
                d={pathD}
                fill="none"
                stroke={color}
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                style={{ filter: `drop-shadow(0px 0px 3px ${color})` }}
            />

            {/* Threshold line */}
            {thresholdY !== null && (
                <line
                    x1="0" y1={thresholdY}
                    x2="100" y2={thresholdY}
                    stroke={C.warning}
                    strokeDasharray="2 2"
                    vectorEffect="non-scaling-stroke"
                    opacity={0.5}
                />
            )}

            {/* Cursor line */}
            {cursorX !== null && (
                <>
                    <line
                        x1={cursorX} y1={0}
                        x2={cursorX} y2={height}
                        stroke="rgba(255, 255, 255, 0.35)"
                        strokeWidth="1"
                        vectorEffect="non-scaling-stroke"
                        strokeDasharray="3 3"
                    />
                    {track.length > 1 && (() => {
                        const idx = Math.min(
                            Math.floor(cursorFraction! * (track.length - 1)),
                            track.length - 1
                        );
                        const val = track[idx].conditions[dataKey] ?? 0;
                        const dotY = height - (val / maxVal) * height;
                        return (
                            <circle
                                cx={cursorX}
                                cy={dotY}
                                r="2.5"
                                fill={color}
                                stroke="white"
                                strokeWidth="0.8"
                                vectorEffect="non-scaling-stroke"
                                style={{ filter: `drop-shadow(0px 0px 4px ${color})` }}
                            />
                        );
                    })()}
                </>
            )}
        </svg>
    );
};

// ══════════════════════════════════════════════════════════════════
// MAIN HUD COMPONENT
// ══════════════════════════════════════════════════════════════════

interface PassageHUDProps {
    track: TrackPoint[] | null;
    ghostShip: GhostShipState | null;
    currentTimeHours: number;
    totalDistanceNM?: number;
    totalDurationHours?: number;
    costScore?: number;
}

const PassageHUD: React.FC<PassageHUDProps> = ({
    track,
    ghostShip,
    currentTimeHours,
    totalDistanceNM,
    totalDurationHours,
    costScore,
}) => {
    const peaks = useMemo(() => {
        if (!track || track.length < 2) return { wind: 0, wave: 0, depth: 0 };
        return {
            wind: Math.max(...track.map(t => t.conditions.wind_spd_kts)),
            wave: Math.max(...track.map(t => t.conditions.wave_ht_m)),
            depth: Math.max(...track.map(t => Math.abs(t.conditions.depth_m ?? 0))),
        };
    }, [track]);

    const cursorFraction = useMemo(() => {
        if (!track || track.length < 2) return 0;
        const total = track[track.length - 1].time_offset_hours;
        return total > 0 ? Math.min(currentTimeHours / total, 1) : 0;
    }, [track, currentTimeHours]);

    if (!track || track.length < 2) return null;

    const c = ghostShip?.conditions;

    // Semantic colours for live values — only amber/red when thresholds hit
    const windColor = semanticColor(c?.wind_spd_kts ?? 0, 15, 25);
    const waveColor = semanticColor(c?.wave_ht_m ?? 0, 2, 3);

    return (
        <div className="bio-animate-in" style={{
            background: 'rgba(15, 23, 42, 0.85)',
            backdropFilter: 'blur(20px) saturate(1.2)',
            WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 16,
            borderTopLeftRadius: 0,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
            width: 280,
            padding: '14px 16px',
            pointerEvents: 'auto',
            color: C.text,
        }}>
            {/* ── HEADER ── */}
            <h2 style={{
                fontFamily: "'Inter', sans-serif",
                fontWeight: 600,
                fontSize: 11,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: C.textMuted,
                marginBottom: 12,
                paddingBottom: 8,
                borderBottom: `1px solid ${C.divider}`,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
            }}>
                <span>Passage Telemetry</span>
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '2px 8px', fontSize: 8,
                    fontWeight: 700, letterSpacing: '0.12em',
                    color: C.primary,
                }}>
                    <div style={{
                        width: 5, height: 5, borderRadius: '50%',
                        background: C.primary,
                        boxShadow: `0 0 6px ${C.primary}`,
                    }} />
                    LIVE
                </div>
            </h2>

            {/* ── SUMMARY ROW ── */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <div>
                    <div style={{
                        fontFamily: "'Inter', sans-serif", fontWeight: 500,
                        fontSize: 10, letterSpacing: '0.12em',
                        textTransform: 'uppercase', color: C.label,
                    }}>DISTANCE</div>
                    <div style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 18, color: C.text,
                    }}>
                        {totalDistanceNM?.toFixed(1) ?? '—'}
                        <span style={{ fontSize: 10, opacity: 0.4, marginLeft: 2 }}>NM</span>
                    </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                    <div style={{
                        fontFamily: "'Inter', sans-serif", fontWeight: 500,
                        fontSize: 10, letterSpacing: '0.12em',
                        textTransform: 'uppercase', color: C.label,
                    }}>DURATION</div>
                    <div style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 18, color: C.text,
                    }}>
                        {totalDurationHours
                            ? `${(totalDurationHours / 24).toFixed(1)}`
                            : '—'}
                        <span style={{ fontSize: 10, opacity: 0.4, marginLeft: 2 }}>DAYS</span>
                    </div>
                </div>
            </div>

            {/* ── LIVE TELEMETRY ROW ── */}
            {ghostShip && c && (
                <div style={{
                    display: 'flex',
                    gap: 14,
                    marginBottom: 10,
                    paddingBottom: 8,
                    borderBottom: `1px solid ${C.dividerSubtle}`,
                }}>
                    <div>
                        <div style={{
                            fontFamily: "'Inter', sans-serif", fontWeight: 500,
                            fontSize: 10, letterSpacing: '0.12em',
                            textTransform: 'uppercase', color: C.label,
                        }}>BRG</div>
                        <div style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 15, color: C.primary,
                        }}>
                            {Math.round(ghostShip.bearing)}°
                        </div>
                    </div>
                    <div>
                        <div style={{
                            fontFamily: "'Inter', sans-serif", fontWeight: 500,
                            fontSize: 10, letterSpacing: '0.12em',
                            textTransform: 'uppercase', color: C.label,
                        }}>DIST</div>
                        <div style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 15, color: C.primary,
                        }}>
                            {Math.round(ghostShip.distanceNM)}
                            <span style={{ fontSize: 9, opacity: 0.4 }}>NM</span>
                        </div>
                    </div>
                    <div>
                        <div style={{
                            fontFamily: "'Inter', sans-serif", fontWeight: 500,
                            fontSize: 10, letterSpacing: '0.12em',
                            textTransform: 'uppercase', color: C.label,
                        }}>WIND</div>
                        <div style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 15, color: windColor,
                            textShadow: windColor !== C.primary ? `0 0 8px ${windColor}55` : 'none',
                        }}>
                            {c.wind_spd_kts.toFixed(1)}
                            <span style={{ fontSize: 9, opacity: 0.4 }}>kts</span>
                        </div>
                    </div>
                    <div>
                        <div style={{
                            fontFamily: "'Inter', sans-serif", fontWeight: 500,
                            fontSize: 10, letterSpacing: '0.12em',
                            textTransform: 'uppercase', color: C.label,
                        }}>WAVE</div>
                        <div style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 15, color: waveColor,
                            textShadow: waveColor !== C.primary ? `0 0 8px ${waveColor}55` : 'none',
                        }}>
                            {c.wave_ht_m.toFixed(1)}
                            <span style={{ fontSize: 9, opacity: 0.4 }}>m</span>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ WIND SPARKLINE ═══ */}
            <div style={{ marginBottom: 4 }}>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: C.label,
                    marginBottom: 2,
                }}>
                    <span>WIND (KTS)</span>
                    <span style={{ color: C.textMuted }}>
                        PEAK: {peaks.wind.toFixed(1)}
                    </span>
                </div>
                <SparklinePath
                    track={track}
                    dataKey="wind_spd_kts"
                    maxVal={Math.max(peaks.wind, 35)}
                    color={C.primary}
                    threshold={25}
                    cursorFraction={cursorFraction}
                />
            </div>

            {/* ═══ WAVE SPARKLINE ═══ */}
            <div style={{ marginBottom: 8 }}>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: C.label,
                    marginBottom: 2,
                }}>
                    <span>WAVES (M)</span>
                    <span style={{ color: C.textMuted }}>
                        PEAK: {peaks.wave.toFixed(1)}
                    </span>
                </div>
                <SparklinePath
                    track={track}
                    dataKey="wave_ht_m"
                    maxVal={Math.max(peaks.wave, 4)}
                    color={C.primary}
                    threshold={2.5}
                    cursorFraction={cursorFraction}
                />
            </div>

            {/* ═══ COST SCORE ═══ */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-end',
                paddingTop: 8,
                borderTop: `1px solid ${C.divider}`,
            }}>
                <span style={{
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 10,
                    fontWeight: 500,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    color: C.label,
                }}>
                    ROUTE COST
                </span>
                <span style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 22,
                    fontWeight: 700,
                    color: C.primary,
                    filter: `drop-shadow(0 0 8px ${C.primaryGlow})`,
                    letterSpacing: '0.03em',
                }}>
                    {costScore?.toFixed(2) ?? '—'}
                </span>
            </div>
        </div>
    );
};

export default PassageHUD;
