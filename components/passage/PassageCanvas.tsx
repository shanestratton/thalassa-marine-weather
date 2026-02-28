/**
 * PassageCanvas — The Bioluminescent Command Center
 *
 * Master orchestrator for the 4D Passage Planning experience.
 * Layers the WebGL map, glassmorphism panels, temporal scrubber,
 * and ghost ship — all synced to a single time state.
 *
 * Mobile-responsive layout:
 *   - CommandDeck: collapsible, starts collapsed on mobile (shows summary line)
 *   - PassageHUD: anchored bottom-left above scrubber, collapsible
 *   - Close button: always visible top-right
 *   - No side-by-side overlap on narrow viewports
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import SpatiotemporalMap from './SpatiotemporalMap';
import TemporalScrubber from './TemporalScrubber';
import PassageHUD from './PassageHUD';
import { useGhostShip } from '../../hooks/passage/useGhostShip';
import { WindStore } from '../../stores/WindStore';
import { fetchWW3Grid } from '../../services/ww3CacheClient';
import { fetchGlobalWindField } from '../../services/weather/windField';
import type { SpatiotemporalPayload } from '../../types/spatiotemporal';
import '../../styles/bioluminescent.css';

// ── SVG Icons ───────────────────────────────────────────────────

const SailIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 2L8 18h8L12 2z" />
        <path d="M4 20h16" />
    </svg>
);

const PowerIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <rect x="4" y="10" width="16" height="6" rx="2" />
        <path d="M8 10V8a4 4 0 018 0v2" />
        <path d="M4 20h16" />
    </svg>
);

const CloseIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M18 6L6 18M6 6l12 12" />
    </svg>
);

const ChevronIcon: React.FC<{ expanded: boolean }> = ({ expanded }) => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
        style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}>
        <path d="M6 9l6 6 6-6" />
    </svg>
);

// ── Command Deck — Collapsible Route Summary ────────────────────

interface CommandDeckProps {
    payload: SpatiotemporalPayload;
    collapsed: boolean;
    onToggle: () => void;
}

const CommandDeck: React.FC<CommandDeckProps> = ({ payload, collapsed, onToggle }) => {
    const { summary, mesh_stats, track } = payload;
    const departure = track[0];
    const arrival = track[track.length - 1];

    return (
        <div className="glass-panel bio-animate-in" style={{
            maxWidth: 240,
            width: '100%',
            padding: '8px 10px',
            pointerEvents: 'auto',
        }}>
            {/* Tappable Header — always visible */}
            <button onClick={onToggle} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                width: '100%',
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
            }}>
                <div style={{
                    width: 26, height: 26, borderRadius: 6,
                    background: 'rgba(0, 240, 255, 0.08)',
                    border: '1px solid rgba(0, 240, 255, 0.2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#00f0ff', flexShrink: 0,
                }}>
                    {summary.vessel_type === 'sail' ? <SailIcon /> : <PowerIcon />}
                </div>
                <div style={{ flex: 1, textAlign: 'left' }}>
                    <div style={{
                        fontFamily: "'Inter', sans-serif", fontWeight: 700,
                        fontSize: 10, letterSpacing: '0.08em',
                        textTransform: 'uppercase' as const, color: '#ffffff',
                    }}>
                        NAV COMPUTER
                    </div>
                    <div style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 8, color: '#64748b',
                    }}>
                        {summary.total_distance_nm}NM · {(summary.total_duration_hours / 24).toFixed(1)}d · ⚡{summary.computation_ms}ms
                    </div>
                </div>
                <div style={{ color: '#64748b', flexShrink: 0 }}>
                    <ChevronIcon expanded={!collapsed} />
                </div>
            </button>

            {/* Expandable details */}
            {!collapsed && (
                <div style={{
                    borderTop: '1px solid rgba(0, 240, 255, 0.1)',
                    marginTop: 6, paddingTop: 6,
                    animation: 'bio-fadein 0.2s ease',
                }}>
                    {/* Route Endpoints */}
                    <div style={{ marginBottom: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                            <div style={{
                                width: 5, height: 5, borderRadius: '50%',
                                background: '#00ff88', boxShadow: '0 0 4px #00ff88',
                            }} />
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#e2e8f0' }}>
                                {departure.name}
                            </span>
                        </div>
                        <div style={{ borderLeft: '1px dashed rgba(0,240,255,0.15)', height: 6, marginLeft: 2 }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <div style={{
                                width: 5, height: 5, borderRadius: '50%',
                                background: '#00f0ff', boxShadow: '0 0 4px #00f0ff',
                            }} />
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#e2e8f0' }}>
                                {arrival.name}
                            </span>
                        </div>
                    </div>

                    {/* Stats Grid */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px' }}>
                        <div>
                            <div className="bio-label">DISTANCE</div>
                            <div className="bio-data" style={{ fontSize: 13 }}>
                                {summary.total_distance_nm}<span style={{ fontSize: 8, opacity: 0.5 }}>NM</span>
                            </div>
                        </div>
                        <div>
                            <div className="bio-label">ETA</div>
                            <div className="bio-data" style={{ fontSize: 13 }}>
                                {summary.total_duration_hours > 48
                                    ? `${(summary.total_duration_hours / 24).toFixed(1)}d`
                                    : `${summary.total_duration_hours}h`}
                            </div>
                        </div>
                        <div>
                            <div className="bio-label">WAYPOINTS</div>
                            <div className="bio-data" style={{ fontSize: 13 }}>{track.length}</div>
                        </div>
                        <div>
                            <div className="bio-label">CORRIDOR</div>
                            <div className="bio-data" style={{ fontSize: 13 }}>
                                ±{mesh_stats.corridor_width_nm}<span style={{ fontSize: 8, opacity: 0.5 }}>NM</span>
                            </div>
                        </div>
                    </div>

                    {/* Mesh Info */}
                    <div style={{
                        marginTop: 4, paddingTop: 4,
                        borderTop: '1px solid rgba(255,255,255,0.04)',
                        fontSize: 8, fontFamily: "'JetBrains Mono', monospace",
                        color: '#64748b', lineHeight: 1.4,
                    }}>
                        {mesh_stats.total_nodes} nodes • {mesh_stats.weather_grid_points} wx pts • {mesh_stats.forecast_hours}h horizon
                    </div>
                </div>
            )}
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
    const [deckCollapsed, setDeckCollapsed] = useState(true);
    const [hudCollapsed, setHudCollapsed] = useState(false);
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

    const handleTimeChange = useCallback((hour: number) => {
        setCurrentTimeHours(hour);
    }, []);

    const ghostShip = useGhostShip(payload.track, currentTimeHours);
    const maxTime = payload.summary.total_duration_hours;

    // Save route to logbook as planned_route
    const handleSaveToLogbook = useCallback(async () => {
        if (saveState === 'saving' || saveState === 'saved') return;
        setSaveState('saving');

        try {
            const { ShipLogService } = await import('../../services/ShipLogService');
            const track = payload.track;

            // Build a VoyagePlan-compatible object from the spatiotemporal payload
            const fakePlan = {
                origin: track[0]?.name || 'Origin',
                destination: track[track.length - 1]?.name || 'Destination',
                originCoordinates: track[0] ? { lat: track[0].coordinates[1], lon: track[0].coordinates[0] } : undefined,
                destinationCoordinates: track[track.length - 1] ? { lat: track[track.length - 1].coordinates[1], lon: track[track.length - 1].coordinates[0] } : undefined,
                waypoints: track.slice(1, -1).map(tp => ({
                    name: tp.name,
                    coordinates: { lat: tp.coordinates[1], lon: tp.coordinates[0] },
                    windSpeed: tp.conditions.wind_spd_kts,
                    waveHeight: tp.conditions.wave_ht_m ? tp.conditions.wave_ht_m * 3.28084 : undefined, // m → ft
                    depth_m: tp.conditions.depth_m ?? undefined,
                })),
                distanceApprox: `${payload.summary.total_distance_nm} NM`,
                durationApprox: `${payload.summary.total_duration_hours} hours`,
                departureDate: payload.summary.departure_time || new Date().toISOString(),
            };

            const voyageId = await ShipLogService.savePassagePlanToLogbook(fakePlan as any);
            if (voyageId) {
                setSaveState('saved');
                setTimeout(() => setSaveState('idle'), 3000);
            } else {
                setSaveState('error');
                setTimeout(() => setSaveState('idle'), 2000);
            }
        } catch (err) {
            console.error('[4DMap] Save to logbook error:', err);
            setSaveState('error');
            setTimeout(() => setSaveState('idle'), 2000);
        }
    }, [payload, saveState]);

    // ── Auto-load wind data for particles ──
    useEffect(() => {
        let cancelled = false;

        async function loadWindData() {
            WindStore.setLoading(true);

            const ww3Grid = await fetchWW3Grid(Math.ceil(maxTime));
            if (!cancelled && ww3Grid) {
                WindStore.setGrid(ww3Grid);
                return;
            }

            const windGrid = await fetchGlobalWindField();
            if (!cancelled && windGrid) {
                WindStore.setGrid(windGrid);
                return;
            }

            if (!cancelled) WindStore.setLoading(false);
        }

        loadWindData();
        return () => { cancelled = true; };
    }, [maxTime]);

    // ── Build seamark + channel polygon GeoJSON from pilotage data ──
    const seamarkGeoJSON = useMemo<GeoJSON.FeatureCollection | null>(() => {
        const features: GeoJSON.Feature[] = [];
        if (payload.pilotage?.departure?.seamarks) {
            features.push(...payload.pilotage.departure.seamarks as GeoJSON.Feature[]);
        }
        if (payload.pilotage?.arrival?.seamarks) {
            features.push(...payload.pilotage.arrival.seamarks as GeoJSON.Feature[]);
        }
        if (features.length === 0) return null;
        return { type: 'FeatureCollection', features };
    }, [payload.pilotage]);

    const channelPolygonGeoJSON = useMemo<GeoJSON.Feature<GeoJSON.Polygon> | null>(() => {
        // Combine departure + arrival polygons into one if both exist
        const depPoly = payload.pilotage?.departure?.channel_polygon;
        const arrPoly = payload.pilotage?.arrival?.channel_polygon;
        const ring = depPoly || arrPoly;
        if (!ring || ring.length < 4) return null;
        return {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [ring] },
        };
    }, [payload.pilotage]);

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
                corridorWidthNM={payload.mesh_stats.corridor_width_nm}
                vesselType={payload.summary.vessel_type as 'sail' | 'power'}
                currentTimeHours={currentTimeHours}
                seamarkGeoJSON={seamarkGeoJSON}
                channelPolygonGeoJSON={channelPolygonGeoJSON}
            />

            {/* ═══ LAYER 2: UI Overlay ═══ */}
            <div style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                zIndex: 10,
                display: 'flex',
                flexDirection: 'column',
                padding: 'max(56px, calc(env(safe-area-inset-top) + 10px)) 10px 140px 10px',
            }}>
                {/* ── Top Row: Back (left) + CommandDeck + Save (right) ── */}
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 8,
                }}>
                    {/* Back button (left) */}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexShrink: 0 }}>
                        {onClose && (
                            <button
                                onClick={onClose}
                                style={{
                                    pointerEvents: 'auto',
                                    width: 36, height: 36,
                                    borderRadius: '50%',
                                    border: '1px solid rgba(255,255,255,0.15)',
                                    background: 'rgba(10, 20, 35, 0.8)',
                                    backdropFilter: 'blur(12px)',
                                    WebkitBackdropFilter: 'blur(12px)',
                                    color: '#94a3b8',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    cursor: 'pointer',
                                    flexShrink: 0,
                                }}
                                aria-label="Back"
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M15 19l-7-7 7-7" />
                                </svg>
                            </button>
                        )}
                    </div>

                    {/* CommandDeck (center-ish) */}
                    <CommandDeck
                        payload={payload}
                        collapsed={deckCollapsed}
                        onToggle={() => setDeckCollapsed(c => !c)}
                    />

                    {/* Save to Logbook (right) */}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexShrink: 0 }}>
                        <button
                            onClick={handleSaveToLogbook}
                            disabled={saveState === 'saving'}
                            style={{
                                pointerEvents: 'auto',
                                width: 36, height: 36,
                                borderRadius: '50%',
                                border: `1px solid ${saveState === 'saved' ? 'rgba(52,211,153,0.4)' : saveState === 'error' ? 'rgba(239,68,68,0.4)' : 'rgba(167,139,250,0.3)'}`,
                                background: saveState === 'saved' ? 'rgba(6,78,59,0.6)' : saveState === 'error' ? 'rgba(127,29,29,0.6)' : 'rgba(10, 20, 35, 0.8)',
                                backdropFilter: 'blur(12px)',
                                WebkitBackdropFilter: 'blur(12px)',
                                color: saveState === 'saved' ? '#34d399' : saveState === 'error' ? '#ef4444' : '#a78bfa',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                cursor: saveState === 'saving' ? 'wait' : 'pointer',
                                flexShrink: 0,
                                transition: 'all 0.3s ease',
                            }}
                            aria-label="Save route to logbook"
                            title="Save route to logbook"
                        >
                            {saveState === 'saving' ? (
                                <div style={{ width: 14, height: 14, border: '2px solid #a78bfa', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                            ) : saveState === 'saved' ? (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                    <path d="M20 6L9 17l-5-5" />
                                </svg>
                            ) : saveState === 'error' ? (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                    <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                            ) : (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                    <path d="M12 2v10m0 0l-3-3m3 3l3-3" />
                                    <path d="M4 15v4a1 1 0 001 1h14a1 1 0 001-1v-4" />
                                </svg>
                            )}
                        </button>
                    </div>
                </div>

                {/* Spacer */}
                <div style={{ flex: 1, minHeight: 8 }} />

                {/* ── Bottom: HUD (above scrubber) ── */}
                <div style={{ marginBottom: 6 }}>
                    {/* Toggle tab */}
                    <button
                        onClick={() => setHudCollapsed(c => !c)}
                        style={{
                            pointerEvents: 'auto',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            padding: '3px 8px',
                            borderRadius: '6px 6px 0 0',
                            border: '1px solid rgba(0, 240, 255, 0.1)',
                            borderBottom: 'none',
                            background: 'rgba(10, 20, 35, 0.75)',
                            backdropFilter: 'blur(12px)',
                            WebkitBackdropFilter: 'blur(12px)',
                            color: '#64748b',
                            cursor: 'pointer',
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 8, letterSpacing: '0.08em',
                            textTransform: 'uppercase' as const,
                        }}
                    >
                        <span style={{ color: '#00f0ff' }}>TELEMETRY</span>
                        <ChevronIcon expanded={!hudCollapsed} />
                    </button>

                    {!hudCollapsed && (
                        <PassageHUD
                            track={payload.track}
                            ghostShip={ghostShip}
                            currentTimeHours={currentTimeHours}
                            totalDistanceNM={payload.summary.total_distance_nm}
                            totalDurationHours={payload.summary.total_duration_hours}
                            costScore={payload.summary.cost_score}
                        />
                    )}
                </div>
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
