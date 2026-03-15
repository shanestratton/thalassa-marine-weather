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
import { createLogger } from '../../utils/createLogger';

const log = createLogger('PassageCanvas');
import SpatiotemporalMap from './SpatiotemporalMap';
import TemporalScrubber from './TemporalScrubber';
import { useGhostShip } from '../../hooks/passage/useGhostShip';
import { WindStore } from '../../stores/WindStore';
import { fetchWW3Grid } from '../../services/ww3CacheClient';
import { fetchGlobalWindField } from '../../services/weather/windField';
import { downloadRouteGPX } from '../../utils/gpxRouteExport';
import { toast } from '../Toast';
import { FONT, SIZE, HEADER_STYLE, MICRO_STYLE, FOOTNOTE_STYLE } from '../../styles/typeScale';
import type { SpatiotemporalPayload } from '../../types/spatiotemporal';
import '../../styles/bioluminescent.css';

// ── SVG Icons ───────────────────────────────────────────────────

const SailIcon = () => (
    <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
    >
        <path d="M12 2L8 18h8L12 2z" />
        <path d="M4 20h16" />
    </svg>
);

const PowerIcon = () => (
    <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
    >
        <rect x="4" y="10" width="16" height="6" rx="2" />
        <path d="M8 10V8a4 4 0 018 0v2" />
        <path d="M4 20h16" />
    </svg>
);

const CloseIcon = () => (
    <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
    >
        <path d="M18 6L6 18M6 6l12 12" />
    </svg>
);

const ChevronIcon: React.FC<{ expanded: boolean }> = ({ expanded }) => (
    <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}
    >
        <path d="M6 9l6 6 6-6" />
    </svg>
);

// ── Command Deck — Collapsible Route Summary ────────────────────

interface CommandDeckProps {
    payload: SpatiotemporalPayload;
    collapsed: boolean;
    onToggle: () => void;
}

const OVERLAY_CARD_STYLE: React.CSSProperties = {
    background: 'rgba(15, 23, 42, 0.85)',

    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 16,
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
    pointerEvents: 'auto',
    color: '#e2e8f0',
};

const CommandDeck: React.FC<CommandDeckProps> = ({ payload, collapsed, onToggle }) => {
    const { summary, mesh_stats, track } = payload;
    const departure = track[0];
    const arrival = track[track.length - 1];

    return (
        <div
            style={{
                ...OVERLAY_CARD_STYLE,
                maxWidth: 240,
                width: '100%',
                padding: '8px 10px',
            }}
            className="bio-animate-in"
        >
            {/* Tappable Header — always visible */}
            <button
                onClick={onToggle}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    width: '100%',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                }}
            >
                <div
                    style={{
                        width: 26,
                        height: 26,
                        borderRadius: 6,
                        background: 'rgba(56, 189, 248, 0.08)',
                        border: '1px solid rgba(56, 189, 248, 0.2)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#38bdf8',
                        flexShrink: 0,
                    }}
                >
                    {summary.vessel_type === 'sail' ? <SailIcon /> : <PowerIcon />}
                </div>
                <div style={{ flex: 1, textAlign: 'left' }}>
                    <div style={HEADER_STYLE}>NAV COMPUTER</div>
                    <div style={{ ...FOOTNOTE_STYLE }}>
                        {summary.total_distance_nm}NM · {(summary.total_duration_hours / 24).toFixed(1)}d ·{' '}
                        {track.length} waypoints
                    </div>
                </div>
                <div style={{ color: '#64748b', flexShrink: 0 }}>
                    <ChevronIcon expanded={!collapsed} />
                </div>
            </button>

            {/* Expandable details */}
            {!collapsed && (
                <div
                    style={{
                        borderTop: '1px solid rgba(255, 255, 255, 0.06)',
                        marginTop: 6,
                        paddingTop: 6,
                        animation: 'bio-fadein 0.2s ease',
                    }}
                >
                    {/* Route Endpoints */}
                    <div style={{ marginBottom: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                            <div
                                style={{
                                    width: 5,
                                    height: 5,
                                    borderRadius: '50%',
                                    background: '#38bdf8',
                                    boxShadow: '0 0 4px rgba(56,189,248,0.5)',
                                }}
                            />
                            <span style={MICRO_STYLE}>{departure.name}</span>
                        </div>
                        <div style={{ borderLeft: '1px dashed rgba(56,189,248,0.15)', height: 6, marginLeft: 2 }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <div
                                style={{
                                    width: 5,
                                    height: 5,
                                    borderRadius: '50%',
                                    background: '#38bdf8',
                                    boxShadow: '0 0 4px rgba(56,189,248,0.5)',
                                }}
                            />
                            <span style={MICRO_STYLE}>{arrival.name}</span>
                        </div>
                    </div>

                    {/* Stats Grid */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px' }}>
                        <div>
                            <div className="bio-label">DISTANCE</div>
                            <div className="bio-data" style={{ fontSize: 13 }}>
                                {summary.total_distance_nm}
                                <span style={{ fontSize: SIZE.xs, opacity: 0.5 }}>NM</span>
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
                            <div className="bio-data" style={{ fontSize: 13 }}>
                                {track.length}
                            </div>
                        </div>
                        <div>
                            <div className="bio-label">CORRIDOR</div>
                            <div className="bio-data" style={{ fontSize: 13 }}>
                                ±{mesh_stats.corridor_width_nm}
                                <span style={{ fontSize: SIZE.xs, opacity: 0.5 }}>NM</span>
                            </div>
                        </div>
                    </div>

                    {/* Forecast Info */}
                    <div
                        style={{
                            marginTop: 4,
                            paddingTop: 4,
                            borderTop: '1px solid rgba(56,189,248,0.06)',
                            ...FOOTNOTE_STYLE,
                        }}
                    >
                        Forecast: {mesh_stats.forecast_hours}h horizon • Updated just now
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
    const [logbookState, setLogbookState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

    const handleTimeChange = useCallback((hour: number) => {
        setCurrentTimeHours(hour);
    }, []);

    const ghostShip = useGhostShip(payload.track, currentTimeHours);
    const maxTime = payload.summary.total_duration_hours;

    // Export route as GPX file download
    const handleDownloadTrack = useCallback(() => {
        if (saveState === 'saving' || saveState === 'saved') return;
        setSaveState('saving');

        try {
            const track = payload.track;

            // Build a VoyagePlan-compatible object from the spatiotemporal payload
            const plan = {
                origin: track[0]?.name || 'Origin',
                destination: track[track.length - 1]?.name || 'Destination',
                originCoordinates: track[0]
                    ? { lat: track[0].coordinates[1], lon: track[0].coordinates[0] }
                    : undefined,
                destinationCoordinates: track[track.length - 1]
                    ? { lat: track[track.length - 1].coordinates[1], lon: track[track.length - 1].coordinates[0] }
                    : undefined,
                waypoints: track.slice(1, -1).map((tp) => ({
                    name: tp.name,
                    coordinates: { lat: tp.coordinates[1], lon: tp.coordinates[0] },
                    windSpeed: tp.conditions.wind_spd_kts,
                    waveHeight: tp.conditions.wave_ht_m ? tp.conditions.wave_ht_m * 3.28084 : undefined,
                    depth_m: tp.conditions.depth_m ?? undefined,
                })),
                distanceApprox: `${payload.summary.total_distance_nm} NM`,
                durationApprox: `${payload.summary.total_duration_hours} hours`,
                departureDate: payload.summary.departure_time || new Date().toISOString(),
            };

            downloadRouteGPX(plan as any);
            setSaveState('saved');
            toast.success('GPX route exported');
            setTimeout(() => setSaveState('idle'), 3000);
        } catch (err) {
            log.error('[4DMap] GPX export error:', err);
            setSaveState('error');
            toast.error('Failed to export GPX');
            setTimeout(() => setSaveState('idle'), 2000);
        }
    }, [payload, saveState]);

    // Save route to logbook as planned_route
    const handleSaveToLogbook = useCallback(async () => {
        if (logbookState === 'saving' || logbookState === 'saved') return;
        setLogbookState('saving');

        try {
            const { ShipLogService } = await import('../../services/ShipLogService');
            const track = payload.track;

            const plan = {
                origin: track[0]?.name || 'Origin',
                destination: track[track.length - 1]?.name || 'Destination',
                originCoordinates: track[0]
                    ? { lat: track[0].coordinates[1], lon: track[0].coordinates[0] }
                    : undefined,
                destinationCoordinates: track[track.length - 1]
                    ? { lat: track[track.length - 1].coordinates[1], lon: track[track.length - 1].coordinates[0] }
                    : undefined,
                waypoints: track.slice(1, -1).map((tp) => ({
                    name: tp.name,
                    coordinates: { lat: tp.coordinates[1], lon: tp.coordinates[0] },
                    windSpeed: tp.conditions.wind_spd_kts,
                    waveHeight: tp.conditions.wave_ht_m ? tp.conditions.wave_ht_m * 3.28084 : undefined,
                    depth_m: tp.conditions.depth_m ?? undefined,
                })),
                distanceApprox: `${payload.summary.total_distance_nm} NM`,
                durationApprox: `${payload.summary.total_duration_hours} hours`,
                departureDate: payload.summary.departure_time || new Date().toISOString(),
            };

            const voyageId = await ShipLogService.savePassagePlanToLogbook(plan as any);
            if (voyageId) {
                setLogbookState('saved');
                const dest = track[track.length - 1]?.name || 'Destination';
                toast.success(`Route to ${dest} saved to logbook`);
                setTimeout(() => setLogbookState('idle'), 3000);
            } else {
                setLogbookState('error');
                toast.error('Failed to save route');
                setTimeout(() => setLogbookState('idle'), 2000);
            }
        } catch (err) {
            log.error('[4DMap] Save to logbook error:', err);
            setLogbookState('error');
            toast.error('Failed to save route');
            setTimeout(() => setLogbookState('idle'), 2000);
        }
    }, [payload, logbookState]);

    // ── Auto-load wind data for particles ──
    useEffect(() => {
        let cancelled = false;

        async function loadWindData() {
            WindStore.setLoading(true);

            // Try the GFS edge function first (same as MapHub — reliable)
            try {
                const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
                const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY as string;
                const edgeUrl = `${SUPABASE_URL}/functions/v1/fetch-wind-grid`;

                const res = await fetch(edgeUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        apikey: SUPABASE_KEY,
                        Authorization: `Bearer ${SUPABASE_KEY}`,
                    },
                    body: JSON.stringify({
                        north: 90,
                        south: -90,
                        west: -180,
                        east: 180,
                        hours: Math.min(Math.ceil(maxTime) + 6, 120),
                    }),
                });

                if (!cancelled && res.ok) {
                    const buffer = await res.arrayBuffer();
                    const { decodeGrib2Wind } = await import('../../services/weather/decodeGrib2Wind');
                    const grib = decodeGrib2Wind(buffer);
                    if (!cancelled && grib) {
                        // Convert DecodedGrib2Wind → WindGrid
                        const size = grib.width * grib.height;
                        const speedArr = new Float32Array(size);
                        for (let i = 0; i < size; i++) {
                            speedArr[i] = Math.sqrt(grib.u[i] * grib.u[i] + grib.v[i] * grib.v[i]);
                        }
                        const uniqueLats: number[] = [];
                        const uniqueLons: number[] = [];
                        const latStep = (grib.north - grib.south) / (grib.height - 1);
                        const lonStep = (grib.east - grib.west) / (grib.width - 1);
                        for (let r = 0; r < grib.height; r++) uniqueLats.push(grib.south + r * latStep);
                        for (let c = 0; c < grib.width; c++) uniqueLons.push(grib.west + c * lonStep);

                        WindStore.setGrid({
                            u: [grib.u],
                            v: [grib.v],
                            speed: [speedArr],
                            width: grib.width,
                            height: grib.height,
                            lats: uniqueLats,
                            lons: uniqueLons,
                            north: grib.north,
                            south: grib.south,
                            west: grib.west,
                            east: grib.east,
                            totalHours: 1,
                        });
                        log.info(
                            `[4DCanvas] Wind grid loaded: ${grib.width}×${grib.height}, bounds=[${grib.south},${grib.north}]×[${grib.west},${grib.east}]`,
                        );
                        return;
                    }
                }
            } catch (err) {
                log.warn('[4DCanvas] GFS edge function failed, trying fallback:', err);
            }

            // Fallback: try WW3 + global Open-Meteo
            try {
                const ww3Grid = await fetchWW3Grid(Math.ceil(maxTime));
                if (!cancelled && ww3Grid) {
                    WindStore.setGrid(ww3Grid);
                    return;
                }
            } catch (_) {}

            try {
                const windGrid = await fetchGlobalWindField();
                if (!cancelled && windGrid) {
                    WindStore.setGrid(windGrid);
                    return;
                }
            } catch (_) {}

            if (!cancelled) WindStore.setLoading(false);
        }

        loadWindData();
        return () => {
            cancelled = true;
        };
    }, [maxTime]);

    // ── Build seamark + channel polygon GeoJSON from pilotage data ──
    const seamarkGeoJSON = useMemo<GeoJSON.FeatureCollection | null>(() => {
        const features: GeoJSON.Feature[] = [];
        if (payload.pilotage?.departure?.seamarks) {
            features.push(...(payload.pilotage.departure.seamarks as GeoJSON.Feature[]));
        }
        if (payload.pilotage?.arrival?.seamarks) {
            features.push(...(payload.pilotage.arrival.seamarks as GeoJSON.Feature[]));
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

    const [mapReady, setMapReady] = useState(false);

    return (
        <div
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                overflow: 'hidden',
                background: '#040d1a',
            }}
        >
            {/* ═══ MAP LOADING STATE ═══ */}
            <div
                style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: mapReady ? -1 : 5,
                    opacity: mapReady ? 0 : 1,
                    transition: 'opacity 0.6s ease',
                    pointerEvents: mapReady ? 'none' : 'auto',
                    background: '#040d1a',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 16,
                }}
            >
                <div
                    style={{
                        width: 48,
                        height: 48,
                        border: '3px solid rgba(56, 189, 248, 0.15)',
                        borderTopColor: '#38bdf8',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite',
                    }}
                />
                <div
                    style={{
                        fontFamily: FONT.ui,
                        fontSize: SIZE.body,
                        fontWeight: 600,
                        letterSpacing: '0.15em',
                        textTransform: 'uppercase' as const,
                        color: '#64748b',
                    }}
                >
                    Plotting Course…
                </div>
            </div>

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
                onMapReady={() => setMapReady(true)}
            />

            {/* ═══ LAYER 2: UI Overlay ═══ */}
            <div
                style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    zIndex: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    padding: 'max(56px, calc(env(safe-area-inset-top) + 10px)) 10px 140px 10px',
                }}
            >
                {/* ── Top Row: Back (left) + CommandDeck + Save (right) ── */}
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        gap: 8,
                    }}
                >
                    {/* Back button (left) */}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexShrink: 0 }}>
                        {onClose && (
                            <button
                                onClick={onClose}
                                style={{
                                    pointerEvents: 'auto',
                                    width: 44,
                                    height: 44,
                                    borderRadius: '50%',
                                    border: '1px solid rgba(255,255,255,0.15)',
                                    background: 'rgba(15, 23, 42, 0.85)',

                                    color: '#94a3b8',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    cursor: 'pointer',
                                    flexShrink: 0,
                                }}
                                aria-label="Back"
                            >
                                <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth={2.5}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M15 19l-7-7 7-7" />
                                </svg>
                            </button>
                        )}
                    </div>

                    {/* CommandDeck temporarily hidden
                    <CommandDeck
                        payload={payload}
                        collapsed={deckCollapsed}
                        onToggle={() => setDeckCollapsed(c => !c)}
                    />
                    */}

                    {/* Action Buttons (right) */}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexShrink: 0 }}>
                        {/* Save to Logbook (bookmark icon) */}
                        <button
                            onClick={handleSaveToLogbook}
                            disabled={logbookState === 'saving'}
                            style={{
                                pointerEvents: 'auto',
                                width: 44,
                                height: 44,
                                borderRadius: '50%',
                                border: `1px solid ${logbookState === 'saved' ? 'rgba(52,211,153,0.4)' : logbookState === 'error' ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.15)'}`,
                                background:
                                    logbookState === 'saved'
                                        ? 'rgba(6,78,59,0.6)'
                                        : logbookState === 'error'
                                          ? 'rgba(127,29,29,0.6)'
                                          : 'rgba(15, 23, 42, 0.85)',

                                color:
                                    logbookState === 'saved'
                                        ? '#34d399'
                                        : logbookState === 'error'
                                          ? '#ef4444'
                                          : '#a78bfa',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: logbookState === 'saving' ? 'wait' : 'pointer',
                                flexShrink: 0,
                                transition: 'all 0.3s ease',
                            }}
                            aria-label="Save planned route to logbook"
                            title="Save planned route to logbook"
                        >
                            {logbookState === 'saving' ? (
                                <div
                                    style={{
                                        width: 16,
                                        height: 16,
                                        border: '2px solid #a78bfa',
                                        borderTopColor: 'transparent',
                                        borderRadius: '50%',
                                        animation: 'spin 0.8s linear infinite',
                                    }}
                                />
                            ) : logbookState === 'saved' ? (
                                <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    strokeLinecap="round"
                                >
                                    <path d="M20 6L9 17l-5-5" />
                                </svg>
                            ) : logbookState === 'error' ? (
                                <svg
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    strokeLinecap="round"
                                >
                                    <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                            ) : (
                                /* Bookmark / save icon */
                                <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
                                </svg>
                            )}
                        </button>

                        {/* Download Track as GPX (download icon) */}
                        <button
                            onClick={handleDownloadTrack}
                            disabled={saveState === 'saving'}
                            style={{
                                pointerEvents: 'auto',
                                width: 44,
                                height: 44,
                                borderRadius: '50%',
                                border: `1px solid ${saveState === 'saved' ? 'rgba(52,211,153,0.4)' : saveState === 'error' ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.15)'}`,
                                background:
                                    saveState === 'saved'
                                        ? 'rgba(6,78,59,0.6)'
                                        : saveState === 'error'
                                          ? 'rgba(127,29,29,0.6)'
                                          : 'rgba(15, 23, 42, 0.85)',

                                color:
                                    saveState === 'saved' ? '#34d399' : saveState === 'error' ? '#ef4444' : '#94a3b8',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: saveState === 'saving' ? 'wait' : 'pointer',
                                flexShrink: 0,
                                transition: 'all 0.3s ease',
                            }}
                            aria-label="Download track as GPX"
                            title="Download track as GPX"
                        >
                            {saveState === 'saving' ? (
                                <div
                                    style={{
                                        width: 16,
                                        height: 16,
                                        border: '2px solid #94a3b8',
                                        borderTopColor: 'transparent',
                                        borderRadius: '50%',
                                        animation: 'spin 0.8s linear infinite',
                                    }}
                                />
                            ) : saveState === 'saved' ? (
                                <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    strokeLinecap="round"
                                >
                                    <path d="M20 6L9 17l-5-5" />
                                </svg>
                            ) : saveState === 'error' ? (
                                <svg
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    strokeLinecap="round"
                                >
                                    <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                            ) : (
                                <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                >
                                    <path d="M12 2v10m0 0l-3-3m3 3l3-3" />
                                    <path d="M4 15v4a1 1 0 001 1h14a1 1 0 001-1v-4" />
                                </svg>
                            )}
                        </button>
                    </div>
                </div>

                {/* Spacer */}
                <div style={{ flex: 1, minHeight: 8 }} />

                {/* Telemetry temporarily hidden
                <div style={{ marginBottom: 6 }}>
                    <button
                        onClick={() => setHudCollapsed(c => !c)}
                        aria-label={hudCollapsed ? 'Show telemetry panel' : 'Hide telemetry panel'}
                        aria-expanded={!hudCollapsed}
                        style={{
                            pointerEvents: 'auto',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            padding: '8px 12px',
                            minHeight: 44,
                            borderRadius: hudCollapsed ? 10 : '10px 10px 0 0',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            borderBottom: hudCollapsed ? undefined : 'none',
                            background: 'rgba(15, 23, 42, 0.85)',
                            
                            
                            color: '#64748b',
                            cursor: 'pointer',
                            fontFamily: FONT.ui,
                            fontSize: SIZE.xs, letterSpacing: '0.08em',
                            fontWeight: 600,
                            textTransform: 'uppercase' as const,
                        }}
                    >
                        <span style={{ color: '#38bdf8' }}>TELEMETRY</span>
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
                */}
            </div>

            {/* ═══ LAYER 3: Temporal Scrubber (pinned bottom) ═══ */}
            <TemporalScrubber maxTimeHours={maxTime} currentHour={currentTimeHours} onChange={handleTimeChange} />
        </div>
    );
};

export default PassageCanvas;
