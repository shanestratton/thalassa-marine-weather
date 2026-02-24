/**
 * PassageHUD — Bioluminescent Heads-Up Display
 *
 * Dual sparkline telemetry showing Wind Speed (neon cyan) and
 * Wave Height (deep ocean blue) across the entire passage.
 * Uses viewBox-based SVGs for perfect responsiveness.
 *
 * Features:
 *   - Peak value annotations
 *   - Danger threshold lines (25kt wind, 2.5m wave)
 *   - Cursor sync with temporal scrubber
 *   - Glowing drop-shadow on graph lines
 *   - Cost score with purple glow
 */

import React, { useMemo } from 'react';
import type { TrackPoint, GhostShipState } from '../../types/spatiotemporal';
import '../../styles/bioluminescent.css';

// ══════════════════════════════════════════════════════════════════
// SPARKLINE ENGINE — viewBox SVG with threshold lines
// ══════════════════════════════════════════════════════════════════

interface SparklinePathProps {
    track: TrackPoint[];
    dataKey: 'wind_spd_kts' | 'wave_ht_m';
    maxVal: number;
    height?: number;
    color: string;
    glowColor: string;
    threshold?: number;
    thresholdLabel?: string;
    cursorFraction?: number;  // 0-1, synced with scrubber
}

const SparklinePath: React.FC<SparklinePathProps> = ({
    track, dataKey, maxVal, height = 40, color, glowColor,
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

    // Area fill path (closed to bottom)
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
            {/* Area fill (very subtle) */}
            <path
                d={areaD}
                fill={glowColor}
                opacity={0.12}
            />

            {/* Main line with glow */}
            <path
                d={pathD}
                fill="none"
                stroke={color}
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                style={{ filter: `drop-shadow(0px 0px 4px ${glowColor})` }}
            />

            {/* Threshold line */}
            {thresholdY !== null && (
                <line
                    x1="0" y1={thresholdY}
                    x2="100" y2={thresholdY}
                    stroke="rgba(176, 38, 255, 0.5)"
                    strokeDasharray="2 2"
                    vectorEffect="non-scaling-stroke"
                />
            )}

            {/* Cursor line (synced with scrubber) */}
            {cursorX !== null && (
                <>
                    <line
                        x1={cursorX} y1={0}
                        x2={cursorX} y2={height}
                        stroke="rgba(255, 255, 255, 0.5)"
                        strokeWidth="1"
                        vectorEffect="non-scaling-stroke"
                        strokeDasharray="3 3"
                    />
                    {/* Dot on the line at cursor position */}
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
                                style={{ filter: `drop-shadow(0px 0px 6px ${color})` }}
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
    // ── Extract peaks ──
    const peaks = useMemo(() => {
        if (!track || track.length < 2) return { wind: 0, wave: 0, depth: 0 };
        return {
            wind: Math.max(...track.map(t => t.conditions.wind_spd_kts)),
            wave: Math.max(...track.map(t => t.conditions.wave_ht_m)),
            depth: Math.max(...track.map(t => Math.abs(t.conditions.depth_m ?? 0))),
        };
    }, [track]);

    // ── Cursor position (0-1) ──
    const cursorFraction = useMemo(() => {
        if (!track || track.length < 2) return 0;
        const total = track[track.length - 1].time_offset_hours;
        return total > 0 ? Math.min(currentTimeHours / total, 1) : 0;
    }, [track, currentTimeHours]);

    if (!track || track.length < 2) return null;

    const c = ghostShip?.conditions;

    // ── Color coding for live values ──
    const windColor = (c?.wind_spd_kts ?? 0) > 25 ? '#ff3b5c'
        : (c?.wind_spd_kts ?? 0) > 15 ? '#ffb800' : '#00f0ff';
    const waveColor = (c?.wave_ht_m ?? 0) > 3 ? '#ff3b5c'
        : (c?.wave_ht_m ?? 0) > 2 ? '#ffb800' : '#0088ff';

    return (
        <div className="glass-panel bio-animate-in" style={{
            width: 280,
            padding: '14px 16px',
            pointerEvents: 'auto',
        }}>
            {/* ── HEADER ── */}
            <h2 style={{
                fontFamily: "'Inter', sans-serif",
                fontWeight: 600,
                fontSize: 11,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: '#94a3b8',
                marginBottom: 12,
                paddingBottom: 8,
                borderBottom: '1px solid rgba(0, 240, 255, 0.15)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
            }}>
                <span>Passage Telemetry</span>
                <div className="status-pill status-pill--ready" style={{ padding: '2px 8px', fontSize: 8 }}>
                    <div style={{
                        width: 5, height: 5, borderRadius: '50%',
                        background: '#00ff88',
                        boxShadow: '0 0 6px #00ff88',
                    }} />
                    LIVE
                </div>
            </h2>

            {/* ── SUMMARY ROW ── */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <div>
                    <div className="bio-label">DISTANCE</div>
                    <div className="bio-data" style={{ fontSize: 18 }}>
                        {totalDistanceNM?.toFixed(1) ?? '—'}
                        <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 2 }}>NM</span>
                    </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                    <div className="bio-label">DURATION</div>
                    <div className="bio-data" style={{ fontSize: 18 }}>
                        {totalDurationHours
                            ? `${(totalDurationHours / 24).toFixed(1)}`
                            : '—'}
                        <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 2 }}>DAYS</span>
                    </div>
                </div>
            </div>

            {/* ── LIVE TELEMETRY ROW (synced with ghost ship) ── */}
            {ghostShip && c && (
                <div style={{
                    display: 'flex',
                    gap: 14,
                    marginBottom: 10,
                    paddingBottom: 8,
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                }}>
                    <div>
                        <div className="bio-label">BRG</div>
                        <div className="bio-data" style={{ fontSize: 15, color: '#00f0ff' }}>
                            {Math.round(ghostShip.bearing)}°
                        </div>
                    </div>
                    <div>
                        <div className="bio-label">DIST</div>
                        <div className="bio-data" style={{ fontSize: 15, color: '#00f0ff' }}>
                            {Math.round(ghostShip.distanceNM)}
                            <span style={{ fontSize: 9, opacity: 0.5 }}>NM</span>
                        </div>
                    </div>
                    <div>
                        <div className="bio-label">WIND</div>
                        <div className="bio-data" style={{ fontSize: 15, color: windColor, textShadow: `0 0 8px ${windColor}55` }}>
                            {c.wind_spd_kts.toFixed(1)}
                            <span style={{ fontSize: 9, opacity: 0.5 }}>kts</span>
                        </div>
                    </div>
                    <div>
                        <div className="bio-label">WAVE</div>
                        <div className="bio-data" style={{ fontSize: 15, color: waveColor, textShadow: `0 0 8px ${waveColor}55` }}>
                            {c.wave_ht_m.toFixed(1)}
                            <span style={{ fontSize: 9, opacity: 0.5 }}>m</span>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ WIND SPARKLINE (Neon Cyan) ═══ */}
            <div style={{ marginBottom: 4 }}>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: '#64748b',
                    marginBottom: 2,
                }}>
                    <span>WIND (KTS)</span>
                    <span style={{ color: '#00f0ff', textShadow: '0 0 6px rgba(0,240,255,0.3)' }}>
                        PEAK: {peaks.wind.toFixed(1)}
                    </span>
                </div>
                <SparklinePath
                    track={track}
                    dataKey="wind_spd_kts"
                    maxVal={Math.max(peaks.wind, 35)}
                    color="#00f0ff"
                    glowColor="rgba(0, 240, 255, 0.6)"
                    threshold={25}
                    thresholdLabel="25kt"
                    cursorFraction={cursorFraction}
                />
            </div>

            {/* ═══ WAVE SPARKLINE (Deep Ocean Blue) ═══ */}
            <div style={{ marginBottom: 8 }}>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: '#64748b',
                    marginBottom: 2,
                }}>
                    <span>WAVES (M)</span>
                    <span style={{ color: '#0088ff', textShadow: '0 0 6px rgba(0,136,255,0.3)' }}>
                        PEAK: {peaks.wave.toFixed(1)}
                    </span>
                </div>
                <SparklinePath
                    track={track}
                    dataKey="wave_ht_m"
                    maxVal={Math.max(peaks.wave, 4)}
                    color="#0088ff"
                    glowColor="rgba(0, 136, 255, 0.6)"
                    threshold={2.5}
                    thresholdLabel="2.5m"
                    cursorFraction={cursorFraction}
                />
            </div>

            {/* ═══ COST SCORE ═══ */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-end',
                paddingTop: 8,
                borderTop: '1px solid rgba(0, 240, 255, 0.12)',
            }}>
                <span style={{
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 10,
                    fontWeight: 500,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    color: '#64748b',
                }}>
                    ROUTE COST
                </span>
                <span style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 22,
                    fontWeight: 700,
                    color: '#b026ff',
                    filter: 'drop-shadow(0 0 10px rgba(176, 38, 255, 0.7))',
                    letterSpacing: '0.03em',
                }}>
                    {costScore?.toFixed(2) ?? '—'}
                </span>
            </div>
        </div>
    );
};

export default PassageHUD;
