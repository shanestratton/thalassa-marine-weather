/**
 * ChartModes — one-tap layer presets for the Charts page.
 *
 * The chart screen has ~20 toggleable layers across Sky / Tactical /
 * Charts. For new users that's overwhelming; for power users it's
 * still a lot of taps to get from one situational set to another. The
 * Modes chip flips that on its head: tap once → curated preset.
 *
 * Modes:
 *   🌅 Day Sail        — wind, AIS, marks, tides (coastal cruising)
 *   🧭 Offshore Passage — wind, waves, currents, pressure, AIS
 *                        (passage planning, weather-aware)
 *   ⛈️ Storm Watch     — lightning, squall, pressure
 *                        (weather threat focus)
 *   🗺️ Charts Only     — marks, AIS, tides, no weather
 *   ✨ Clear All        — everything off
 *   ⚙️ Custom           — user has manually deviated from any preset
 *
 * The chip lives at top-center, always visible while on Charts. Tap
 * shows a vertical dropdown of all six modes. Selection persists in
 * localStorage so the user's preferred mode survives a relaunch.
 *
 * "Custom" automatically becomes the active mode if the user manually
 * toggles a layer that doesn't match the current preset — so the chip
 * is always honest about what's on screen.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { triggerHaptic } from '../../utils/system';

export type ChartMode = 'day-sail' | 'offshore' | 'storm-watch' | 'charts-only' | 'clear' | 'custom';

interface ModeSpec {
    id: ChartMode;
    icon: string;
    label: string;
    summary: string;
    /** Layers to enable (any not listed are forced off). */
    sky?: string[]; // e.g. 'wind', 'rain', 'pressure', 'currents', 'waves', 'sst', 'chl', 'seaice', 'mld'
    tactical?: {
        ais?: boolean;
        lightning?: boolean;
        cyclone?: boolean;
        squall?: boolean;
        seamark?: boolean;
        tides?: boolean;
        chokepoint?: boolean;
        vesselTracking?: boolean;
    };
    mpa?: boolean;
}

// Order matters — picker shows them in this sequence.
export const MODE_SPECS: ModeSpec[] = [
    {
        id: 'day-sail',
        icon: '🌅',
        label: 'Day Sail',
        summary: 'Wind, AIS, marks, tides',
        sky: ['wind'],
        tactical: { ais: true, seamark: true, tides: true },
    },
    {
        id: 'offshore',
        icon: '🧭',
        label: 'Offshore',
        summary: 'Wind, waves, currents, pressure',
        sky: ['wind', 'waves', 'currents', 'pressure'],
        tactical: { ais: true },
    },
    {
        id: 'storm-watch',
        icon: '⛈️',
        label: 'Storm Watch',
        summary: 'Lightning, squall, pressure',
        sky: ['pressure'],
        tactical: { lightning: true, squall: true },
    },
    {
        id: 'charts-only',
        icon: '🗺️',
        label: 'Charts Only',
        summary: 'Marks, AIS, tides — no weather',
        sky: [],
        tactical: { ais: true, seamark: true, tides: true },
    },
    {
        id: 'clear',
        icon: '✨',
        label: 'Clear All',
        summary: 'Turn everything off',
        sky: [],
        tactical: {},
    },
];

interface ChartModesProps {
    visible: boolean;
    /** Current active sky layer set (from useWeatherLayers). */
    activeSkyLayers: Set<string>;
    /** Toggle a sky layer ON/OFF (calls weather.toggleLayer). */
    toggleSkyLayer: (layer: string) => void;
    /** Set the single active sky layer (calls weather.setActiveLayer). */
    setActiveSkyLayer: (layer: string) => void;

    aisVisible: boolean;
    setAisVisible: (v: boolean) => void;
    lightningVisible: boolean;
    setLightningVisible: (v: boolean) => void;
    cycloneVisible: boolean;
    setCycloneVisible: (v: boolean) => void;
    squallVisible: boolean;
    setSquallVisible: (v: boolean) => void;
    seamarkVisible: boolean;
    setSeamarkVisible: (v: boolean) => void;
    tideStationsVisible: boolean;
    setTideStationsVisible: (v: boolean) => void;
    chokepointVisible: boolean;
    setChokepointVisible: (v: boolean) => void;
    vesselTrackingVisible: boolean;
    setVesselTrackingVisible: (v: boolean) => void;

    mpaVisible?: boolean;
    setMpaVisible?: (v: boolean) => void;
}

const STORAGE_KEY = 'thalassa_chart_mode';

/** Detect which preset (if any) matches the current state. Returns
 *  'custom' when the state doesn't match any preset exactly. */
function detectMode(props: ChartModesProps): ChartMode {
    const skyArr = Array.from(props.activeSkyLayers);
    for (const spec of MODE_SPECS) {
        if (specMatches(spec, props, skyArr)) return spec.id;
    }
    return 'custom';
}

function specMatches(spec: ModeSpec, props: ChartModesProps, skyArr: string[]): boolean {
    const wantSky = new Set(spec.sky ?? []);
    if (skyArr.length !== wantSky.size) return false;
    for (const k of skyArr) if (!wantSky.has(k)) return false;

    const t = spec.tactical ?? {};
    if (!!t.ais !== props.aisVisible) return false;
    if (!!t.lightning !== props.lightningVisible) return false;
    if (!!t.cyclone !== props.cycloneVisible) return false;
    if (!!t.squall !== props.squallVisible) return false;
    if (!!t.seamark !== props.seamarkVisible) return false;
    if (!!t.tides !== props.tideStationsVisible) return false;
    if (!!t.chokepoint !== props.chokepointVisible) return false;
    if (!!t.vesselTracking !== props.vesselTrackingVisible) return false;

    if (props.mpaVisible !== undefined && !!spec.mpa !== !!props.mpaVisible) return false;
    return true;
}

export const ChartModes: React.FC<ChartModesProps> = (props) => {
    const [open, setOpen] = useState(false);
    const [storedMode, setStoredMode] = useState<ChartMode | null>(() => {
        try {
            return (localStorage.getItem(STORAGE_KEY) as ChartMode | null) ?? null;
        } catch {
            return null;
        }
    });
    const wrapRef = useRef<HTMLDivElement>(null);

    // Detect current mode every render — when state matches one of the
    // presets, the chip reflects that preset. When it doesn't, "Custom".
    const detected = detectMode(props);
    // The displayed mode is the detected one; the storedMode is just a
    // hint for which preset the user last chose so we can prefer it on
    // ambiguity (which doesn't actually happen — detectMode is unambiguous —
    // but keeping for future preset overlap).
    const currentMode = detected;
    const currentSpec = MODE_SPECS.find((s) => s.id === currentMode);

    // Close picker on outside tap.
    useEffect(() => {
        if (!open) return;
        const onDoc = (e: Event) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('touchstart', onDoc);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('touchstart', onDoc);
        };
    }, [open]);

    const applyMode = useCallback(
        (spec: ModeSpec) => {
            triggerHaptic('medium');

            // Sky: clear everything not in spec, enable everything in spec.
            const wantSky = new Set(spec.sky ?? []);
            // First disable sky layers that shouldn't be on.
            const ALL_SKY = [
                'wind',
                'rain',
                'pressure',
                'clouds',
                'temperature',
                'currents',
                'waves',
                'sst',
                'chl',
                'seaice',
                'mld',
                'velocity',
                'sea',
            ];
            for (const layer of ALL_SKY) {
                const on = props.activeSkyLayers.has(layer);
                const shouldBeOn = wantSky.has(layer);
                if (on !== shouldBeOn) props.toggleSkyLayer(layer);
            }

            // Tactical
            const t = spec.tactical ?? {};
            if (!!t.ais !== props.aisVisible) props.setAisVisible(!!t.ais);
            if (!!t.lightning !== props.lightningVisible) props.setLightningVisible(!!t.lightning);
            if (!!t.cyclone !== props.cycloneVisible) props.setCycloneVisible(!!t.cyclone);
            if (!!t.squall !== props.squallVisible) props.setSquallVisible(!!t.squall);
            if (!!t.seamark !== props.seamarkVisible) props.setSeamarkVisible(!!t.seamark);
            if (!!t.tides !== props.tideStationsVisible) props.setTideStationsVisible(!!t.tides);
            if (!!t.chokepoint !== props.chokepointVisible) props.setChokepointVisible(!!t.chokepoint);
            if (!!t.vesselTracking !== props.vesselTrackingVisible) props.setVesselTrackingVisible(!!t.vesselTracking);

            if (props.setMpaVisible && props.mpaVisible !== undefined) {
                if (!!spec.mpa !== !!props.mpaVisible) props.setMpaVisible(!!spec.mpa);
            }

            try {
                localStorage.setItem(STORAGE_KEY, spec.id);
            } catch {
                /* storage full / unavailable — preset still applied */
            }
            setStoredMode(spec.id);
            setOpen(false);
        },
        [props],
    );

    if (!props.visible) return null;

    return (
        <div
            ref={wrapRef}
            // Top-center, fixed so it sits above all map overlays. z high
            // enough to clear the radial menu's own popovers.
            className="fixed left-1/2 -translate-x-1/2 z-[180] pointer-events-auto chart-chip-in"
            style={{ top: 'max(10px, env(safe-area-inset-top))' }}
        >
            <button
                onClick={() => {
                    triggerHaptic('light');
                    setOpen((v) => !v);
                }}
                className="flex items-center gap-2 text-[12px] leading-tight"
                style={{
                    background: 'rgba(15, 23, 42, 0.85)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 18,
                    padding: '7px 14px',
                    color: 'rgba(255,255,255,0.9)',
                    fontWeight: 600,
                    boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
                }}
                aria-label="Open chart mode picker"
            >
                <span aria-hidden>{currentSpec?.icon ?? '⚙️'}</span>
                <span>{currentSpec?.label ?? 'Custom'}</span>
                <span className="opacity-50 text-[10px]">{open ? '▴' : '▾'}</span>
            </button>

            {open && (
                <div
                    className="absolute left-1/2 -translate-x-1/2 mt-2 flex flex-col gap-1 min-w-[240px]"
                    style={{
                        background: 'rgba(15, 23, 42, 0.94)',
                        backdropFilter: 'blur(24px)',
                        WebkitBackdropFilter: 'blur(24px)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 16,
                        padding: 6,
                        boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                    }}
                >
                    {MODE_SPECS.map((spec) => {
                        const active = currentMode === spec.id;
                        return (
                            <button
                                key={spec.id}
                                onClick={() => applyMode(spec)}
                                className="flex items-center gap-3 text-left transition-colors"
                                style={{
                                    background: active ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                                    borderRadius: 10,
                                    padding: '8px 10px',
                                    border: active ? '1px solid rgba(56, 189, 248, 0.35)' : '1px solid transparent',
                                }}
                            >
                                <span style={{ fontSize: 18 }} aria-hidden>
                                    {spec.icon}
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span
                                        className="block font-semibold"
                                        style={{
                                            color: active ? '#38bdf8' : 'rgba(255,255,255,0.92)',
                                            fontSize: 13,
                                        }}
                                    >
                                        {spec.label}
                                    </span>
                                    <span
                                        className="block opacity-70"
                                        style={{
                                            color: 'rgba(255,255,255,0.7)',
                                            fontSize: 10,
                                            marginTop: 1,
                                        }}
                                    >
                                        {spec.summary}
                                    </span>
                                </span>
                                {active && (
                                    <span
                                        aria-hidden
                                        style={{
                                            color: '#38bdf8',
                                            fontSize: 14,
                                            fontWeight: 700,
                                        }}
                                    >
                                        ✓
                                    </span>
                                )}
                            </button>
                        );
                    })}
                    {currentMode === 'custom' && (
                        <div
                            className="px-2 py-1.5 mt-1 text-[10px] opacity-70"
                            style={{
                                color: 'rgba(255,255,255,0.6)',
                                borderTop: '1px solid rgba(255,255,255,0.06)',
                            }}
                        >
                            ⚙️ Custom — pick any preset to reset
                        </div>
                    )}
                </div>
            )}
            {/* Hide unused storedMode warning while we keep it for future
                use (preset overlap when more modes are added). */}
            {storedMode === null && null}
        </div>
    );
};
