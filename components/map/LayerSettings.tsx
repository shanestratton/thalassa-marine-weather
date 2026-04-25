/**
 * LayerSettings — per-layer customisation sheet for the chart screen.
 *
 * Triggered from a small ⚙ cog inside the ChartModes chip. Opens a
 * compact panel listing every layer the user can actually configure
 * (currently: opacity sliders for the raster overlays they care about
 * — squall, rain, pressure, clouds, temperature, CMEMS daily). The
 * particle layers (wind, currents, waves) skip opacity for now because
 * they're WebGL custom layers with their own paint expressions.
 *
 * Each slider:
 *   - Reads its initial value from localStorage (falls back to 100%).
 *   - Calls the Mapbox map directly via setPaintProperty for live
 *     feedback while the user drags.
 *   - Persists on slider release so the user's preferred opacity
 *     survives layer toggles + relaunches.
 *
 * Out of scope intentionally: per-layer threshold tuning, particle
 * density, lightning TTL. Each is a follow-up. The single biggest
 * customisation gap was "I want to see the chart through the weather"
 * — opacity solves that.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import { triggerHaptic } from '../../utils/system';

interface LayerSettingsProps {
    visible: boolean;
    onClose: () => void;
    /** Map ref so we can apply paint properties directly. */
    mapRef: React.MutableRefObject<mapboxgl.Map | null>;
    /** Names of currently active sky layers (e.g. 'rain', 'pressure',
     *  'clouds', 'temperature', 'sst', 'chl', 'seaice', 'mld'). */
    activeSkyLayers: Set<string>;
    /** Whether the squall layer is showing — gives us its slider when on. */
    squallVisible: boolean;
}

interface ConfigurableLayer {
    id: string; // user-facing key (used for storage)
    label: string;
    icon: string;
    /** Predicate — only show this row when this is true. */
    isActive: () => boolean;
    /** Mapbox layer IDs whose `raster-opacity` should track the slider.
     *  Multiple IDs covers cases like rain (many sub-frames) and
     *  pressure (heatmap + contour lines). */
    getMapboxLayerIds: (map: mapboxgl.Map) => string[];
}

const STORAGE_PREFIX = 'thalassa_layer_opacity_';

function readOpacity(key: string): number {
    try {
        const v = localStorage.getItem(STORAGE_PREFIX + key);
        if (!v) return 100;
        const n = parseFloat(v);
        return isFinite(n) ? Math.max(0, Math.min(100, n)) : 100;
    } catch {
        return 100;
    }
}

function writeOpacity(key: string, value: number): void {
    try {
        localStorage.setItem(STORAGE_PREFIX + key, String(value));
    } catch {
        /* full / unavailable */
    }
}

/** Apply the opacity to every matching Mapbox layer. Uses
 *  setPaintProperty so changes appear live without rebuilding sources. */
function applyOpacity(map: mapboxgl.Map, layerIds: string[], opacityPct: number): void {
    const value = Math.max(0, Math.min(1, opacityPct / 100));
    for (const id of layerIds) {
        try {
            if (!map.getLayer(id)) continue;
            const layerType = map.getLayer(id)?.type;
            if (layerType === 'raster') {
                map.setPaintProperty(id, 'raster-opacity', value);
            } else if (layerType === 'circle') {
                map.setPaintProperty(id, 'circle-opacity', value);
            } else if (layerType === 'fill') {
                map.setPaintProperty(id, 'fill-opacity', value);
            } else if (layerType === 'line') {
                map.setPaintProperty(id, 'line-opacity', value);
            } else if (layerType === 'symbol') {
                map.setPaintProperty(id, 'text-opacity', value);
                map.setPaintProperty(id, 'icon-opacity', value);
            }
        } catch {
            /* layer may not be on the map yet */
        }
    }
}

export const LayerSettings: React.FC<LayerSettingsProps> = ({
    visible,
    onClose,
    mapRef,
    activeSkyLayers,
    squallVisible,
}) => {
    const wrapRef = useRef<HTMLDivElement>(null);

    // Build the list of configurable layers based on what's currently
    // active. Layers that aren't on the map don't appear in the sheet —
    // empty sheet is meaningfully different from "you have no layers
    // on" so we render a hint when that happens.
    const configurable: ConfigurableLayer[] = [
        {
            id: 'rain',
            label: 'Rain & Forecast',
            icon: '🌧️',
            isActive: () => activeSkyLayers.has('rain'),
            getMapboxLayerIds: (map) => {
                const ids: string[] = [];
                const layers = map.getStyle()?.layers ?? [];
                for (const l of layers) {
                    if (l.id.startsWith('radar-') || l.id.startsWith('rainbow-fc-')) ids.push(l.id);
                }
                return ids;
            },
        },
        {
            id: 'pressure',
            label: 'Pressure / Isobars',
            icon: '🌡️',
            isActive: () => activeSkyLayers.has('pressure'),
            getMapboxLayerIds: () => ['pressure-heatmap-layer', 'isobar-lines'],
        },
        {
            id: 'clouds',
            label: 'Clouds',
            icon: '☁️',
            isActive: () => activeSkyLayers.has('clouds'),
            getMapboxLayerIds: () => ['tiles-clouds'],
        },
        {
            id: 'temperature',
            label: 'Temperature',
            icon: '🌡️',
            isActive: () => activeSkyLayers.has('temperature'),
            getMapboxLayerIds: () => ['tiles-temperature'],
        },
        {
            id: 'sst',
            label: 'Sea-Surface Temp',
            icon: '🌊',
            isActive: () => activeSkyLayers.has('sst'),
            getMapboxLayerIds: (map) => {
                const ids: string[] = [];
                const layers = map.getStyle()?.layers ?? [];
                for (const l of layers) if (l.id.includes('sst')) ids.push(l.id);
                return ids;
            },
        },
        {
            id: 'chl',
            label: 'Chlorophyll',
            icon: '🦠',
            isActive: () => activeSkyLayers.has('chl'),
            getMapboxLayerIds: (map) => {
                const ids: string[] = [];
                const layers = map.getStyle()?.layers ?? [];
                for (const l of layers) if (l.id.includes('chl')) ids.push(l.id);
                return ids;
            },
        },
        {
            id: 'seaice',
            label: 'Sea Ice',
            icon: '🧊',
            isActive: () => activeSkyLayers.has('seaice'),
            getMapboxLayerIds: (map) => {
                const ids: string[] = [];
                const layers = map.getStyle()?.layers ?? [];
                for (const l of layers) if (l.id.includes('seaice')) ids.push(l.id);
                return ids;
            },
        },
        {
            id: 'mld',
            label: 'Mixed Layer Depth',
            icon: '🌀',
            isActive: () => activeSkyLayers.has('mld'),
            getMapboxLayerIds: (map) => {
                const ids: string[] = [];
                const layers = map.getStyle()?.layers ?? [];
                for (const l of layers) if (l.id.includes('mld')) ids.push(l.id);
                return ids;
            },
        },
        {
            id: 'squall',
            label: 'Squall Threat',
            icon: '⛈️',
            isActive: () => squallVisible,
            getMapboxLayerIds: () => ['squall-rainbow-layer'],
        },
    ];

    const activeRows = configurable.filter((c) => c.isActive());

    const [opacities, setOpacities] = useState<Record<string, number>>(() => {
        const o: Record<string, number> = {};
        for (const c of configurable) o[c.id] = readOpacity(c.id);
        return o;
    });

    // Re-apply persisted opacity when a layer becomes active. Without
    // this a user toggling rain ON would always see it at 100% even
    // if they previously dimmed it.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        for (const row of activeRows) {
            const ids = row.getMapboxLayerIds(map);
            applyOpacity(map, ids, opacities[row.id] ?? 100);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeRows.length]);

    // Outside-tap close.
    useEffect(() => {
        if (!visible) return;
        const onDoc = (e: Event) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('touchstart', onDoc);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('touchstart', onDoc);
        };
    }, [visible, onClose]);

    const handleSlide = useCallback(
        (id: string, value: number) => {
            const map = mapRef.current;
            const row = configurable.find((c) => c.id === id);
            if (!map || !row) return;
            const ids = row.getMapboxLayerIds(map);
            applyOpacity(map, ids, value);
            setOpacities((prev) => ({ ...prev, [id]: value }));
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );

    const handleRelease = useCallback((id: string, value: number) => {
        triggerHaptic('light');
        writeOpacity(id, value);
    }, []);

    if (!visible) return null;

    return (
        <div
            ref={wrapRef}
            className="fixed left-1/2 -translate-x-1/2 z-[185] pointer-events-auto chart-chip-in"
            style={{ top: 'max(56px, calc(env(safe-area-inset-top) + 56px))' }}
            role="dialog"
            aria-label="Layer settings"
        >
            <div
                className="flex flex-col"
                style={{
                    background: 'rgba(15, 23, 42, 0.94)',
                    backdropFilter: 'blur(24px)',
                    WebkitBackdropFilter: 'blur(24px)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 16,
                    boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                    minWidth: 280,
                    maxWidth: 'calc(100vw - 32px)',
                }}
            >
                {/* Header */}
                <div
                    className="flex items-center justify-between"
                    style={{
                        padding: '10px 14px',
                        borderBottom: '1px solid rgba(255,255,255,0.06)',
                    }}
                >
                    <span
                        className="font-semibold tracking-wide"
                        style={{ color: 'rgba(255,255,255,0.92)', fontSize: 12 }}
                    >
                        Layer Opacity
                    </span>
                    <button
                        onClick={onClose}
                        aria-label="Close layer settings"
                        className="opacity-60 hover:opacity-100"
                        style={{
                            color: '#fff',
                            fontSize: 16,
                            lineHeight: 1,
                            padding: '0 4px',
                        }}
                    >
                        ×
                    </button>
                </div>

                {/* Body */}
                <div style={{ padding: '8px 12px' }}>
                    {activeRows.length === 0 ? (
                        <div
                            className="text-[11px] opacity-70"
                            style={{ color: 'rgba(255,255,255,0.7)', padding: '12px 4px' }}
                        >
                            No layers active. Turn one on from the menu and its opacity will appear here.
                        </div>
                    ) : (
                        activeRows.map((row) => {
                            const value = opacities[row.id] ?? 100;
                            return (
                                <div key={row.id} style={{ padding: '8px 0' }}>
                                    <div className="flex items-center justify-between mb-1">
                                        <span
                                            className="flex items-center gap-2"
                                            style={{ color: 'rgba(255,255,255,0.88)', fontSize: 12 }}
                                        >
                                            <span aria-hidden style={{ fontSize: 14 }}>
                                                {row.icon}
                                            </span>
                                            <span className="font-semibold">{row.label}</span>
                                        </span>
                                        <span
                                            style={{
                                                color: 'rgba(255,255,255,0.6)',
                                                fontSize: 10,
                                                fontFamily: 'monospace',
                                                letterSpacing: 0.3,
                                            }}
                                        >
                                            {value}%
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        min={0}
                                        max={100}
                                        step={5}
                                        value={value}
                                        onChange={(e) => handleSlide(row.id, parseInt(e.target.value, 10))}
                                        onMouseUp={(e) =>
                                            handleRelease(row.id, parseInt((e.target as HTMLInputElement).value, 10))
                                        }
                                        onTouchEnd={(e) =>
                                            handleRelease(row.id, parseInt((e.target as HTMLInputElement).value, 10))
                                        }
                                        className="w-full"
                                        aria-label={`${row.label} opacity`}
                                        style={{ accentColor: '#38bdf8' }}
                                    />
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
};
