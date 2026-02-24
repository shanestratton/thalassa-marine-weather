/**
 * PassageCanvas — The Bioluminescent Command Center
 *
 * Master orchestrator for the 4D Passage Planning experience.
 * Layers the WebGL map, glassmorphism panels, temporal scrubber,
 * and ghost ship — all synced to a single time state.
 *
 * Architecture:
 *   ┌─────────────────────────────────────────────┐
 *   │           SpatiotemporalMap (WebGL)          │ ← full bleed
 *   │  ┌──────────┐                 ┌──────────┐  │
 *   │  │ Command  │                 │ Passage  │  │ ← floating glass
 *   │  │  Deck    │                 │   HUD    │  │
 *   │  └──────────┘                 └──────────┘  │
 *   │                                             │
 *   │  ┌─────────────────────────────────────────┐│
 *   │  │         Temporal Scrubber               ││ ← bottom glass bar
 *   │  └─────────────────────────────────────────┘│
 *   └─────────────────────────────────────────────┘
 */

import React, { useState, useCallback } from 'react';
import SpatiotemporalMap from './SpatiotemporalMap';
import TemporalScrubber from './TemporalScrubber';
import PassageHUD from './PassageHUD';
import { useGhostShip } from '../../hooks/passage/useGhostShip';
import type { SpatiotemporalPayload } from '../../types/spatiotemporal';
import '../../styles/bioluminescent.css';

// ── SVG Icons ───────────────────────────────────────────────────

const SailIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 2L8 18h8L12 2z" />
        <path d="M4 20h16" />
    </svg>
);

const PowerIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <rect x="4" y="10" width="16" height="6" rx="2" />
        <path d="M8 10V8a4 4 0 018 0v2" />
        <path d="M4 20h16" />
    </svg>
);

const CloseIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M18 6L6 18M6 6l12 12" />
    </svg>
);

// ── Command Deck — Route Summary + Nav Computer ─────────────────

interface CommandDeckProps {
    payload: SpatiotemporalPayload;
}

const CommandDeck: React.FC<CommandDeckProps> = ({ payload }) => {
    const { summary, mesh_stats, track } = payload;
    const departure = track[0];
    const arrival = track[track.length - 1];

    return (
        <div className="glass-panel--dense glass-panel bio-animate-in" style={{
            width: 260,
            padding: '14px 16px',
        }}>
            {/* ── Title ── */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 12,
                paddingBottom: 10,
                borderBottom: '1px solid rgba(0, 240, 255, 0.12)',
            }}>
                <div style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: 'rgba(0, 240, 255, 0.08)',
                    border: '1px solid rgba(0, 240, 255, 0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#00f0ff',
                }}>
                    {summary.vessel_type === 'sail' ? <SailIcon /> : <PowerIcon />}
                </div>
                <div>
                    <div style={{
                        fontFamily: "'Inter', sans-serif",
                        fontWeight: 700,
                        fontSize: 12,
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase' as const,
                        color: '#ffffff',
                    }}>
                        NAV COMPUTER
                    </div>
                    <div style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 9,
                        color: '#64748b',
                        letterSpacing: '0.05em',
                    }}>
                        {summary.vessel_type.toUpperCase()} • 4D SPATIOTEMPORAL
                    </div>
                </div>
            </div>

            {/* ── Route Endpoints ── */}
            <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <div style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: '#00ff88',
                        boxShadow: '0 0 6px #00ff88',
                    }} />
                    <span style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 11,
                        color: '#e2e8f0',
                    }}>
                        {departure.name}
                    </span>
                </div>
                <div style={{
                    borderLeft: '1px dashed rgba(0, 240, 255, 0.2)',
                    height: 12,
                    marginLeft: 4,
                }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: '#00f0ff',
                        boxShadow: '0 0 6px #00f0ff',
                    }} />
                    <span style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 11,
                        color: '#e2e8f0',
                    }}>
                        {arrival.name}
                    </span>
                </div>
            </div>

            {/* ── Stats Grid ── */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '8px 14px',
            }}>
                <div>
                    <div className="bio-label">DISTANCE</div>
                    <div className="bio-data" style={{ fontSize: 16 }}>
                        {summary.total_distance_nm}
                        <span style={{ fontSize: 9, opacity: 0.5, marginLeft: 2 }}>NM</span>
                    </div>
                </div>
                <div>
                    <div className="bio-label">ETA</div>
                    <div className="bio-data" style={{ fontSize: 16 }}>
                        {summary.total_duration_hours > 48
                            ? `${(summary.total_duration_hours / 24).toFixed(1)}d`
                            : `${summary.total_duration_hours}h`}
                    </div>
                </div>
                <div>
                    <div className="bio-label">WAYPOINTS</div>
                    <div className="bio-data" style={{ fontSize: 16 }}>{track.length}</div>
                </div>
                <div>
                    <div className="bio-label">CORRIDOR</div>
                    <div className="bio-data" style={{ fontSize: 16 }}>
                        ±{mesh_stats.corridor_width_nm}
                        <span style={{ fontSize: 9, opacity: 0.5 }}>NM</span>
                    </div>
                </div>
            </div>

            {/* ── Mesh Telemetry ── */}
            <div style={{
                marginTop: 10,
                paddingTop: 8,
                borderTop: '1px solid rgba(255,255,255,0.04)',
            }}>
                <div style={{
                    fontSize: 9,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: '#64748b',
                    lineHeight: 1.6,
                }}>
                    {mesh_stats.total_nodes} mesh nodes • {mesh_stats.weather_grid_points} wx points
                    <br />
                    {mesh_stats.forecast_hours}h forecast horizon
                    <br />
                    <span style={{ color: 'rgba(0, 240, 255, 0.6)' }}>
                        ⚡ Computed in {summary.computation_ms}ms
                    </span>
                </div>
            </div>
        </div>
    );
};

// ── Master Layout ───────────────────────────────────────────────

interface PassageCanvasProps {
    payload: SpatiotemporalPayload;
    onClose?: () => void;
}

const PassageCanvas: React.FC<PassageCanvasProps> = ({ payload, onClose }) => {
    const [currentTimeHours, setCurrentTimeHours] = useState(0);

    const handleTimeChange = useCallback((hour: number) => {
        setCurrentTimeHours(hour);
    }, []);

    // Ghost ship interpolation via Turf.js
    const ghostShip = useGhostShip(payload.track, currentTimeHours);

    const maxTime = payload.summary.total_duration_hours;

    return (
        <div style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            overflow: 'hidden',
            background: '#040d1a',
        }}>
            {/* ═══ LAYER 1: WebGL Map (full bleed) ═══ */}
            <SpatiotemporalMap
                track={payload.track}
                ghostShip={ghostShip}
                boundingBox={payload.bounding_box}
            />

            {/* ═══ LAYER 2: UI Overlay ═══ */}
            <div style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                zIndex: 10,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: '16px 16px 0 16px',
            }}>
                {/* Top row: Command Deck + HUD */}
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    width: '100%',
                    gap: 16,
                }}>
                    {/* Left: Command Deck */}
                    <CommandDeck payload={payload} />

                    {/* Right: Close + HUD */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 12 }}>
                        {/* Close button */}
                        {onClose && (
                            <button
                                onClick={onClose}
                                style={{
                                    pointerEvents: 'auto',
                                    width: 40,
                                    height: 40,
                                    borderRadius: 12,
                                    border: '1px solid rgba(255,255,255,0.15)',
                                    background: 'rgba(10, 20, 35, 0.7)',
                                    backdropFilter: 'blur(12px)',
                                    WebkitBackdropFilter: 'blur(12px)',
                                    color: '#94a3b8',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    cursor: 'pointer',
                                    transition: 'all 0.15s ease',
                                }}
                                aria-label="Close passage canvas"
                            >
                                <CloseIcon />
                            </button>
                        )}

                        {/* Passage HUD with sparklines */}
                        <PassageHUD
                            track={payload.track}
                            ghostShip={ghostShip}
                            currentTimeHours={currentTimeHours}
                            totalDistanceNM={payload.summary.total_distance_nm}
                            totalDurationHours={payload.summary.total_duration_hours}
                            costScore={payload.summary.cost_score}
                        />
                    </div>
                </div>

                {/* Spacer */}
                <div style={{ flex: 1 }} />
            </div>

            {/* ═══ LAYER 3: Temporal Scrubber (pinned bottom) ═══ */}
            <TemporalScrubber
                maxTimeHours={maxTime}
                currentHour={currentTimeHours}
                onChange={handleTimeChange}
            />
        </div>
    );
};

export default PassageCanvas;
