/**
 * PassageHUD — Heads Up Display for the 4D Passage Planner
 *
 * Displays real-time telemetry from the ghost ship position:
 * wind speed, wave height, depth, and bearing — with sparkline
 * mini-charts showing conditions along the entire route.
 *
 * Design: Bioluminescent glassmorphism with neon data readouts.
 */

import React, { useMemo } from 'react';
import type { TrackPoint, GhostShipState } from '../../types/spatiotemporal';
import '../../styles/bioluminescent.css';

// ── SVG Sparkline ───────────────────────────────────────────────

interface SparklineProps {
    data: number[];
    color: string;
    cursorPosition?: number;   // 0-1 fraction
    height?: number;
    warning?: number;          // Threshold for color change
}

const Sparkline: React.FC<SparklineProps> = ({
    data,
    color,
    cursorPosition,
    height = 36,
    warning,
}) => {
    if (!data.length) return null;

    const width = 140;
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = max - min || 1;

    const points = data.map((v, i) => {
        const x = (i / (data.length - 1)) * width;
        const y = height - ((v - min) / range) * (height - 4) - 2;
        return `${x},${y}`;
    }).join(' ');

    // Area fill path
    const areaPath = `M 0,${height} L ${points} L ${width},${height} Z`;

    return (
        <svg
            className="sparkline-svg"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            style={{ width: '100%', height }}
        >
            {/* Warning zone (if threshold set) */}
            {warning !== undefined && (
                <rect
                    x={0}
                    y={0}
                    width={width}
                    height={height - ((warning - min) / range) * (height - 4) - 2}
                    fill="rgba(255, 59, 92, 0.08)"
                />
            )}

            {/* Area fill */}
            <path d={areaPath} fill={color} className="sparkline-area" />

            {/* Line */}
            <polyline
                points={points}
                className="sparkline-line"
                stroke={color}
            />

            {/* Cursor line */}
            {cursorPosition !== undefined && (
                <line
                    x1={cursorPosition * width}
                    y1={0}
                    x2={cursorPosition * width}
                    y2={height}
                    className="sparkline-cursor"
                />
            )}
        </svg>
    );
};

// ── HUD Data Row ────────────────────────────────────────────────

interface HUDRowProps {
    label: string;
    value: string;
    unit: string;
    color: string;
    sparkData: number[];
    cursorPos?: number;
    warning?: number;
    className?: string;
}

const HUDRow: React.FC<HUDRowProps> = ({
    label, value, unit, color, sparkData, cursorPos, warning, className,
}) => (
    <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 0',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
    }} className={className}>
        <div style={{ flex: '0 0 80px' }}>
            <div className="bio-label" style={{ marginBottom: 2 }}>{label}</div>
            <div className="bio-data" style={{
                fontSize: 18,
                color,
                textShadow: `0 0 8px ${color}55`,
            }}>
                {value}<span style={{ fontSize: 11, opacity: 0.6, marginLeft: 3 }}>{unit}</span>
            </div>
        </div>
        <div style={{ flex: 1, minWidth: 80 }}>
            <Sparkline
                data={sparkData}
                color={color}
                cursorPosition={cursorPos}
                warning={warning}
            />
        </div>
    </div>
);

// ── Main HUD Component ──────────────────────────────────────────

interface PassageHUDProps {
    track: TrackPoint[] | null;
    ghostShip: GhostShipState | null;
    currentTimeHours: number;
}

const PassageHUD: React.FC<PassageHUDProps> = ({ track, ghostShip, currentTimeHours }) => {
    // Pre-extract sparkline data from the track
    const sparklines = useMemo(() => {
        if (!track || track.length < 2) return null;
        return {
            wind: track.map(t => t.conditions.wind_spd_kts),
            wave: track.map(t => t.conditions.wave_ht_m),
            depth: track.map(t => Math.abs(t.conditions.depth_m ?? 0)),
        };
    }, [track]);

    // Cursor position (0-1)
    const cursorPos = useMemo(() => {
        if (!track || track.length < 2 || !ghostShip) return 0;
        const total = track[track.length - 1].time_offset_hours;
        return total > 0 ? currentTimeHours / total : 0;
    }, [track, ghostShip, currentTimeHours]);

    if (!track || !ghostShip || !sparklines) {
        return null;
    }

    const c = ghostShip.conditions;

    // Color coding
    const windColor = c.wind_spd_kts > 25 ? 'var(--neon-red)' :
        c.wind_spd_kts > 15 ? 'var(--neon-amber)' : 'var(--neon-cyan)';
    const waveColor = c.wave_ht_m > 3 ? 'var(--neon-red)' :
        c.wave_ht_m > 2 ? 'var(--neon-amber)' : 'var(--neon-cyan)';

    return (
        <div className="glass-panel bio-animate-in" style={{
            width: 260,
            padding: '14px 16px',
            pointerEvents: 'auto',
        }}>
            {/* Header */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 10,
                paddingBottom: 8,
                borderBottom: '1px solid rgba(0, 240, 255, 0.1)',
            }}>
                <div className="bio-label" style={{ fontSize: 11, letterSpacing: '0.1em' }}>
                    INTELLIGENCE HUD
                </div>
                <div className="status-pill status-pill--ready" style={{ padding: '2px 8px', fontSize: 8 }}>
                    <div style={{
                        width: 5, height: 5, borderRadius: '50%',
                        background: 'var(--neon-green)',
                        boxShadow: '0 0 6px var(--neon-green)',
                    }} />
                    LIVE
                </div>
            </div>

            {/* Bearing + Speed */}
            <div style={{
                display: 'flex',
                gap: 16,
                marginBottom: 8,
                paddingBottom: 8,
                borderBottom: '1px solid rgba(255,255,255,0.04)',
            }}>
                <div>
                    <div className="bio-label">BRG</div>
                    <div className="bio-data" style={{ fontSize: 16 }}>
                        {Math.round(ghostShip.bearing)}°
                    </div>
                </div>
                <div>
                    <div className="bio-label">DIST</div>
                    <div className="bio-data" style={{ fontSize: 16 }}>
                        {Math.round(ghostShip.distanceNM)}<span style={{ fontSize: 10, opacity: 0.6 }}>NM</span>
                    </div>
                </div>
                <div>
                    <div className="bio-label">WIND DIR</div>
                    <div className="bio-data" style={{ fontSize: 16 }}>
                        {Math.round(c.wind_dir_deg)}°
                    </div>
                </div>
            </div>

            {/* Sparkline Rows */}
            <HUDRow
                label="WIND"
                value={c.wind_spd_kts.toFixed(1)}
                unit="kts"
                color={windColor}
                sparkData={sparklines.wind}
                cursorPos={cursorPos}
                warning={25}
            />
            <HUDRow
                label="WAVE"
                value={c.wave_ht_m.toFixed(1)}
                unit="m"
                color={waveColor}
                sparkData={sparklines.wave}
                cursorPos={cursorPos}
                warning={3}
            />
            <HUDRow
                label="DEPTH"
                value={c.depth_m != null ? `${Math.abs(c.depth_m).toFixed(0)}` : '—'}
                unit="m"
                color="var(--neon-purple)"
                sparkData={sparklines.depth}
                cursorPos={cursorPos}
            />

            {/* Swell */}
            {c.swell_period_s != null && (
                <div style={{ marginTop: 6, display: 'flex', gap: 12 }}>
                    <div>
                        <div className="bio-label">SWELL</div>
                        <div className="bio-data" style={{ fontSize: 14 }}>
                            {c.swell_period_s.toFixed(1)}<span style={{ fontSize: 9, opacity: 0.5 }}>s</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PassageHUD;
