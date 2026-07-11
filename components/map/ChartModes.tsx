/**
 * ChartModes — one-tap layer presets for the Charts page.
 *
 * The chart screen has ~20 toggleable layers across Sky / Tactical /
 * Charts. For new users that's overwhelming; for power users it's
 * still a lot of taps to get from one situational set to another. The
 * Modes chip flips that on its head: tap once → curated preset.
 *
 * Modes:
 *   Day Sail        — wind, AIS, marks, tides (coastal cruising)
 *   Offshore Passage — wind, waves, currents, pressure, AIS
 *                      (passage planning, weather-aware)
 *   Storm Watch     — lightning, squall, pressure (weather threat focus)
 *   Charts Only     — marks, AIS, tides, no weather
 *   Clear All       — everything off
 *   Custom          — user has manually deviated from any preset
 *
 * The chip lives at top-center, always visible while on Charts. Tap
 * shows a vertical dropdown of all six modes. Selection persists in
 * localStorage so the user's preferred mode survives a relaunch.
 *
 * "Custom" automatically becomes the active mode if the user manually
 * toggles a layer that doesn't match the current preset — so the chip
 * is always honest about what's on screen.
 *
 * Icons migrated from emoji to SVG components 2026-05-16 — visual
 * uplift pass after the 68/100 UX score audit.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createLogger } from '../../utils/createLogger';
import { triggerHaptic } from '../../utils/system';
import { useDeviceClass, pickByDevice } from '../../utils/useDeviceClass';
import {
    SunriseIcon,
    CompassIcon,
    ThunderstormIcon,
    MapIcon,
    SparklesIcon,
    GearIcon,
    CheckIcon,
    AnchorIcon,
} from '../Icons';

const log = createLogger('ChartModes');

export type ChartMode = 'day-sail' | 'offshore' | 'storm-watch' | 'charts-only' | 'clear' | 'custom';

interface ModeSpec {
    id: ChartMode;
    Icon: React.FC<{ className?: string }>;
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
        Icon: SunriseIcon,
        label: 'Day Sail',
        summary: 'Wind, AIS, marks, tides',
        sky: ['wind'],
        tactical: { ais: true, seamark: true, tides: true },
    },
    {
        id: 'offshore',
        Icon: (props) => <CompassIcon {...props} rotation={0} />,
        label: 'Offshore',
        summary: 'Wind, waves, currents, pressure',
        sky: ['wind', 'waves', 'currents', 'pressure'],
        tactical: { ais: true },
    },
    {
        id: 'storm-watch',
        Icon: ThunderstormIcon,
        label: 'Storm Watch',
        summary: 'Lightning, squall, pressure',
        sky: ['pressure'],
        tactical: { lightning: true, squall: true },
    },
    {
        id: 'charts-only',
        Icon: MapIcon,
        label: 'Charts Only',
        summary: 'Marks, AIS, tides — no weather',
        sky: [],
        tactical: { ais: true, seamark: true, tides: true },
    },
    {
        id: 'clear',
        Icon: SparklesIcon,
        label: 'Clear All',
        summary: 'Turn everything off',
        sky: [],
        tactical: {},
    },
];

interface ChartModesProps {
    visible: boolean;
    /** Open the layer-settings sheet (passed from MapHub so the sheet
     *  itself can sit at the top level of the chart screen, not nested
     *  inside this chip's stacking context). */
    onOpenSettings?: () => void;
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

    /** Satellite BASE imagery under everything (routes/marks stay on top). */
    satelliteVisible?: boolean;
    setSatelliteVisible?: (v: boolean) => void;

    /** "Depth right now" — depth tints/numbers re-read as charted +
     *  predicted tide (visual only; MapHub owns the disclaimer + badge). */
    tideDepthMode?: boolean;
    onToggleTideDepth?: () => void;

    /** Chart key — the plain-words legend card (MapHub owns the card). */
    onOpenChartKey?: () => void;

    /**
     * If provided, renders a "Plan ENC Route" action row between the
     * Charts Only and Clear All preset rows in the dropdown. The callback
     * runs `tryInshoreRoute` and returns a short status string for the
     * row's secondary text. ChartModes manages the local busy state.
     *
     * Only shown when `encCellCount > 0` — pointless without imported cells.
     */
    encCellCount?: number;
    onPlanEncRoute?: () => Promise<{ ok: boolean; summary: string }>;

    /** Seaway Graph debug overlay toggle (masterplan Stage IV Phase 10).
     *  Shown beside the ENC route row, gated the same way. */
    seawayDebugVisible?: boolean;
    onToggleSeawayDebug?: () => void;

    /** Invoked by the "Clear All" preset — clears route INK that outlives
     *  layer toggles: the persisted follow-route (SAIL IT survives app
     *  restarts by design) and the chart route/track selections. Without
     *  this, Clear All left old test-route spaghetti on the chart with no
     *  obvious kill (Shane 2026-07-09 "still got the blue spaghetti"). */
    onClearRouteInk?: () => void;
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

    // Plan-ENC-Route action state. Local because the action is "fire and
    // surface a one-line result" — no need to lift to MapHub. The actual
    // routing call comes from props.onPlanEncRoute.
    const [encBusy, setEncBusy] = useState(false);
    const [encLastResult, setEncLastResult] = useState<string | null>(null);
    const showEncRouteRow = !!props.onPlanEncRoute && (props.encCellCount ?? 0) > 0;
    const showSeawayRow = !!props.onToggleSeawayDebug && (props.encCellCount ?? 0) > 0;
    const runEncRoute = useCallback(async () => {
        if (!props.onPlanEncRoute || encBusy) return;
        setEncBusy(true);
        setEncLastResult(null);
        try {
            const result = await props.onPlanEncRoute();
            setEncLastResult(result.summary);
        } catch (err) {
            log.error('ENC route crashed:', err);
            setEncLastResult('Routing failed — try again');
        } finally {
            setEncBusy(false);
        }
    }, [props.onPlanEncRoute, encBusy]);

    // Detect current mode every render — when state matches one of the
    // presets, the chip reflects that preset. When it doesn't, "Custom".
    const detected = detectMode(props);
    // The displayed mode is the detected one; the storedMode is just a
    // hint for which preset the user last chose so we can prefer it on
    // ambiguity (which doesn't actually happen — detectMode is unambiguous —
    // but keeping for future preset overlap).
    const currentMode = detected;
    const currentSpec = MODE_SPECS.find((s) => s.id === currentMode);
    const deviceClass = useDeviceClass();
    // Tablet sizing — bumped font + padding + dropdown width so the
    // chart screen feels tablet-native instead of stretched phone UI.
    const chipFontSize = pickByDevice(deviceClass, 12, 14);
    const chipPaddingV = pickByDevice(deviceClass, 7, 9);
    const chipPaddingH = pickByDevice(deviceClass, 12, 16);
    const dropdownMinWidth = pickByDevice(deviceClass, 240, 320);

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

    // Mutual exclusion with the right-rail Layer menu — when this picker
    // opens we dispatch an event the Layer menu listens for (and vice
    // versa), so only one of the two big dropdowns can be visible at a
    // time. Stops the "half under" overlap on narrow phones where the
    // centred dropdown's right edge collides with the right-rail expanded
    // menu's left edge.
    useEffect(() => {
        if (open) window.dispatchEvent(new CustomEvent('thalassa:chart-modes-open'));
    }, [open]);
    useEffect(() => {
        const onLayerOpen = () => setOpen(false);
        window.addEventListener('thalassa:layer-menu-open', onLayerOpen);
        return () => window.removeEventListener('thalassa:layer-menu-open', onLayerOpen);
    }, []);

    const applyMode = useCallback(
        (spec: ModeSpec) => {
            triggerHaptic('medium');

            // "Clear All" means ALL: route ink too (persisted follow-route,
            // chart route/track selections), not just weather toggles.
            if (spec.id === 'clear') props.onClearRouteInk?.();

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
            // Top-center, fixed so it sits above all map overlays. z-[800]
            // clears the right-rail FABs (z-[700]) and any expanded menus
            // they spawn — the chip is a primary navigation surface, it
            // should never be obscured by a layer toggle. Below modal
            // dialogs (which live in the 900-1000 range).
            className="fixed left-1/2 chart-chip-centered z-[800] pointer-events-auto chart-chip-in"
            style={{ top: 'max(10px, env(safe-area-inset-top))' }}
        >
            <div
                className="flex items-center"
                style={{
                    // 0.95 alpha (was 0.85) — bumped because intense map
                    // layers (squall, lightning, satellite) bled through
                    // at 0.85 + 20px blur, making the chip text hard to
                    // read against bright cells.
                    background: 'rgba(15, 23, 42, 0.95)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 18,
                    boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
                }}
            >
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        setOpen((v) => !v);
                    }}
                    className="flex items-center gap-2 leading-tight"
                    style={{
                        padding: `${chipPaddingV}px ${chipPaddingH}px`,
                        color: 'rgba(255,255,255,0.9)',
                        fontWeight: 600,
                        fontSize: chipFontSize,
                        background: 'transparent',
                        border: 'none',
                        borderRadius: 18,
                    }}
                    aria-label="Open chart mode picker"
                >
                    <span aria-hidden className="inline-flex items-center justify-center w-4 h-4">
                        {currentSpec ? <currentSpec.Icon className="w-4 h-4" /> : <GearIcon className="w-4 h-4" />}
                    </span>
                    <span>{currentSpec?.label ?? 'Custom'}</span>
                    <span className="opacity-50" style={{ fontSize: chipFontSize - 2 }}>
                        {open ? '▴' : '▾'}
                    </span>
                </button>
                {/* Cog opens layer-opacity settings — separated from the
                    mode picker by a thin divider so the two functions are
                    visually distinct. */}
                {props.onOpenSettings && (
                    <>
                        <span
                            aria-hidden
                            style={{
                                width: 1,
                                height: 18,
                                background: 'rgba(255,255,255,0.12)',
                            }}
                        />
                        <button
                            onClick={() => {
                                triggerHaptic('light');
                                props.onOpenSettings?.();
                                setOpen(false);
                            }}
                            className="flex items-center justify-center"
                            style={{
                                padding: '7px 10px 7px 8px',
                                color: 'rgba(255,255,255,0.85)',
                                fontSize: 13,
                                background: 'transparent',
                                border: 'none',
                                borderTopRightRadius: 18,
                                borderBottomRightRadius: 18,
                            }}
                            aria-label="Layer opacity settings"
                        >
                            <GearIcon className="w-4 h-4" />
                        </button>
                    </>
                )}
            </div>

            {open && (
                <div
                    className="absolute left-1/2 -translate-x-1/2 mt-2 flex flex-col gap-1"
                    style={{
                        minWidth: dropdownMinWidth,
                        // 0.97 alpha (was 0.94) — same readability fix as
                        // the chip itself; the dropdown sits over even
                        // more map content so needs to be more opaque.
                        background: 'rgba(15, 23, 42, 0.97)',
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
                        // Inject the "Plan ENC Route" action row immediately
                        // BEFORE the Clear All row so the picker reads:
                        //   Day Sail / Offshore / Storm Watch / Charts Only /
                        //   ─ Plan ENC Route (action, violet) ─
                        //   Clear All
                        const isClearRow = spec.id === 'clear';
                        return (
                            <React.Fragment key={spec.id}>
                                {isClearRow && showEncRouteRow && (
                                    <button
                                        onClick={() => {
                                            triggerHaptic('light');
                                            void runEncRoute();
                                        }}
                                        disabled={encBusy}
                                        className="flex items-center gap-3 text-left transition-colors"
                                        style={{
                                            background: encBusy
                                                ? 'rgba(167, 139, 250, 0.18)'
                                                : 'rgba(167, 139, 250, 0.08)',
                                            borderRadius: 10,
                                            padding: '8px 10px',
                                            border: '1px solid rgba(167, 139, 250, 0.25)',
                                            cursor: encBusy ? 'wait' : 'pointer',
                                        }}
                                        aria-label="Plan ENC test route — Newport to Rivergate"
                                    >
                                        <span
                                            aria-hidden
                                            className="inline-flex items-center justify-center w-[18px] h-[18px] shrink-0"
                                            style={{ color: '#a78bfa' }}
                                        >
                                            <AnchorIcon className="w-[18px] h-[18px]" />
                                        </span>
                                        <span className="flex-1 min-w-0">
                                            <span
                                                className="block font-semibold"
                                                style={{
                                                    color: '#a78bfa',
                                                    fontSize: 13,
                                                }}
                                            >
                                                {encBusy ? 'Routing…' : 'Plan ENC Route'}
                                            </span>
                                            <span
                                                className="block opacity-70"
                                                style={{
                                                    color: 'rgba(255,255,255,0.7)',
                                                    fontSize: 10,
                                                    marginTop: 1,
                                                }}
                                            >
                                                {encLastResult ?? 'Newport → Rivergate demo'}
                                            </span>
                                        </span>
                                    </button>
                                )}
                                {isClearRow && props.setSatelliteVisible && (
                                    <button
                                        onClick={() => {
                                            triggerHaptic('light');
                                            props.setSatelliteVisible?.(!props.satelliteVisible);
                                        }}
                                        className="flex items-center gap-3 text-left transition-colors"
                                        style={{
                                            background: props.satelliteVisible
                                                ? 'rgba(52, 211, 153, 0.18)'
                                                : 'rgba(52, 211, 153, 0.08)',
                                            borderRadius: 10,
                                            padding: '8px 10px',
                                            border: '1px solid rgba(52, 211, 153, 0.25)',
                                        }}
                                        aria-label="Toggle satellite base imagery"
                                    >
                                        <span
                                            aria-hidden
                                            className="inline-flex items-center justify-center w-[18px] h-[18px] shrink-0"
                                            style={{ color: '#34d399' }}
                                        >
                                            <MapIcon className="w-[18px] h-[18px]" />
                                        </span>
                                        <span className="flex-1 min-w-0">
                                            <span
                                                className="block font-semibold"
                                                style={{ color: '#34d399', fontSize: 13 }}
                                            >
                                                Satellite {props.satelliteVisible ? 'ON' : 'off'}
                                            </span>
                                            <span
                                                className="block opacity-70"
                                                style={{
                                                    color: 'rgba(255,255,255,0.7)',
                                                    fontSize: 10,
                                                    marginTop: 1,
                                                }}
                                            >
                                                real imagery under your route, marks &amp; weather
                                            </span>
                                        </span>
                                    </button>
                                )}
                                {isClearRow && props.onToggleTideDepth && (
                                    <button
                                        onClick={() => {
                                            props.onToggleTideDepth?.();
                                        }}
                                        className="flex items-center gap-3 text-left transition-colors"
                                        style={{
                                            background: props.tideDepthMode
                                                ? 'rgba(45, 212, 191, 0.18)'
                                                : 'rgba(45, 212, 191, 0.08)',
                                            borderRadius: 10,
                                            padding: '8px 10px',
                                            border: '1px solid rgba(45, 212, 191, 0.25)',
                                        }}
                                        aria-label="Toggle live tide depth"
                                    >
                                        <span
                                            aria-hidden
                                            className="inline-flex items-center justify-center w-[18px] h-[18px] shrink-0"
                                            style={{ color: '#2dd4bf', fontSize: 15, fontWeight: 900 }}
                                        >
                                            ≈
                                        </span>
                                        <span className="flex-1 min-w-0">
                                            <span
                                                className="block font-semibold"
                                                style={{ color: '#2dd4bf', fontSize: 13 }}
                                            >
                                                Live tide depth {props.tideDepthMode ? 'ON' : 'off'}
                                            </span>
                                            <span
                                                className="block opacity-70"
                                                style={{
                                                    color: 'rgba(255,255,255,0.7)',
                                                    fontSize: 10,
                                                    marginTop: 1,
                                                }}
                                            >
                                                depths as they are right now, not chart datum
                                            </span>
                                        </span>
                                    </button>
                                )}
                                {isClearRow && props.onOpenChartKey && (
                                    <button
                                        onClick={() => {
                                            triggerHaptic('light');
                                            props.onOpenChartKey?.();
                                        }}
                                        className="flex items-center gap-3 text-left transition-colors"
                                        style={{
                                            background: 'rgba(251, 191, 36, 0.08)',
                                            borderRadius: 10,
                                            padding: '8px 10px',
                                            border: '1px solid rgba(251, 191, 36, 0.25)',
                                        }}
                                        aria-label="Open the chart key"
                                    >
                                        <span
                                            aria-hidden
                                            className="inline-flex items-center justify-center w-[18px] h-[18px] shrink-0"
                                            style={{ color: '#fbbf24', fontSize: 14, fontWeight: 900 }}
                                        >
                                            ?
                                        </span>
                                        <span className="flex-1 min-w-0">
                                            <span
                                                className="block font-semibold"
                                                style={{ color: '#fbbf24', fontSize: 13 }}
                                            >
                                                Chart key
                                            </span>
                                            <span
                                                className="block opacity-70"
                                                style={{
                                                    color: 'rgba(255,255,255,0.7)',
                                                    fontSize: 10,
                                                    marginTop: 1,
                                                }}
                                            >
                                                what the shades and numbers mean
                                            </span>
                                        </span>
                                    </button>
                                )}
                                {isClearRow && showSeawayRow && (
                                    <button
                                        onClick={() => {
                                            triggerHaptic('light');
                                            props.onToggleSeawayDebug?.();
                                        }}
                                        className="flex items-center gap-3 text-left transition-colors"
                                        style={{
                                            background: props.seawayDebugVisible
                                                ? 'rgba(56, 189, 248, 0.18)'
                                                : 'rgba(56, 189, 248, 0.08)',
                                            borderRadius: 10,
                                            padding: '8px 10px',
                                            border: '1px solid rgba(56, 189, 248, 0.25)',
                                        }}
                                        aria-label="Toggle the Seaway Graph debug overlay"
                                    >
                                        <span
                                            aria-hidden
                                            className="inline-flex items-center justify-center w-[18px] h-[18px] shrink-0"
                                            style={{ color: '#38bdf8' }}
                                        >
                                            <AnchorIcon className="w-[18px] h-[18px]" />
                                        </span>
                                        <span className="flex-1 min-w-0">
                                            <span
                                                className="block font-semibold"
                                                style={{ color: '#38bdf8', fontSize: 13 }}
                                            >
                                                Seaway Graph {props.seawayDebugVisible ? 'ON' : 'off'}
                                            </span>
                                            <span
                                                className="block opacity-70"
                                                style={{
                                                    color: 'rgba(255,255,255,0.7)',
                                                    fontSize: 10,
                                                    marginTop: 1,
                                                }}
                                            >
                                                gates + channel edges from your charts (debug)
                                            </span>
                                        </span>
                                    </button>
                                )}
                                <button
                                    onClick={() => applyMode(spec)}
                                    className="flex items-center gap-3 text-left transition-colors"
                                    style={{
                                        background: active ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                                        borderRadius: 10,
                                        padding: '8px 10px',
                                        border: active ? '1px solid rgba(56, 189, 248, 0.35)' : '1px solid transparent',
                                    }}
                                >
                                    <span
                                        aria-hidden
                                        className="inline-flex items-center justify-center w-[18px] h-[18px] shrink-0"
                                        style={{ color: active ? '#38bdf8' : 'rgba(255,255,255,0.92)' }}
                                    >
                                        <spec.Icon className="w-[18px] h-[18px]" />
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
                                        <span aria-hidden className="inline-flex items-center text-sky-400">
                                            <CheckIcon className="w-4 h-4" />
                                        </span>
                                    )}
                                </button>
                            </React.Fragment>
                        );
                    })}
                    {currentMode === 'custom' && (
                        <div
                            className="px-2 py-1.5 mt-1 text-[10px] opacity-70 flex items-center gap-1.5"
                            style={{
                                color: 'rgba(255,255,255,0.6)',
                                borderTop: '1px solid rgba(255,255,255,0.06)',
                            }}
                        >
                            <GearIcon className="w-3 h-3" />
                            <span>Custom — pick any preset to reset</span>
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
