/**
 * ChartModes — the chart screen's layer chip (top-centre).
 *
 * NAME IS NOW HISTORICAL. This was a preset picker: one tap gave you a
 * curated set (Day Sail, Offshore, Storm Watch, Charts Only, Clear All),
 * and the chip showed which preset was live — or "Custom" once you had
 * toggled your way off one.
 *
 * All five presets were removed 2026-07-22 (Shane: "the drop down box that
 * has day sail, offshore, storm watch, charts only... it is just too much
 * noise for that screen"). ~200 lines of preset machinery went with them:
 * MODE_SPECS, detectMode, specMatches, applyMode and the stored-mode key.
 *
 * What is LEFT is what the dropdown had quietly accumulated around the
 * presets, and it is all load-bearing — this is the only UI for any of it:
 *   - Sea chart (ENC) master toggle
 *   - Base switcher: satellite / hybrid / ocean
 *   - Tide-depth mode, night dim, chart key
 *   - Plan ENC Route, Seaway debug (dev rows, self-gating)
 *   - the cog → layer-opacity settings (its ONLY opener)
 *
 * So the chip stays even though the modes are gone. Deleting it strands
 * every item above, which is the same catch-22 that made the old layer FAB
 * unreachable (see 8044e434). If it ever does go, rehome these first.
 *
 * The label went with the presets — there is no mode to name any more — so
 * the chip is now an icon and a caret.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createLogger } from '../../utils/createLogger';
import { triggerHaptic } from '../../utils/system';
import { useDeviceClass, pickByDevice } from '../../utils/useDeviceClass';
import { MapIcon, GearIcon, AnchorIcon } from '../Icons';

const log = createLogger('ChartModes');

interface ChartModesProps {
    visible: boolean;
    /** Open the layer-settings sheet (passed from MapHub so the sheet
     *  itself can sit at the top level of the chart screen, not nested
     *  inside this chip's stacking context). */
    onOpenSettings?: () => void;

    // The ~20 layer props that used to live here (activeSkyLayers, ais,
    // lightning, cyclone, squall, seamark, tides, chokepoint, vesselTracking,
    // mpa, onClearRouteInk) went with the presets on 2026-07-22 — they were
    // read ONLY by applyMode and specMatches, never rendered here. Those
    // toggles are on the RadialHelmMenu and were never this chip's to own.

    /** ENC vector chart master toggle — the only UI for it anywhere. */
    encVisible?: boolean;
    setEncVisible?: (v: boolean) => void;

    /** Satellite BASE imagery under everything (routes/marks stay on top). */
    satelliteVisible?: boolean;
    setSatelliteVisible?: (v: boolean) => void;

    /** Hybrid BASE — the public voyage-page look: satellite-streets
     *  imagery with roads + names. The ONLY other base beside plain
     *  satellite (Shane 2026-07-15); mutually exclusive with it. */
    hybridVisible?: boolean;
    setHybridVisible?: (v: boolean) => void;

    /** MapTiler Ocean BASE — bathymetric chart instead of a photograph. */
    oceanBaseVisible?: boolean;
    setOceanBaseVisible?: (v: boolean) => void;

    /** "Depth right now" — depth tints/numbers re-read as charted +
     *  predicted tide (visual only; MapHub owns the disclaimer + badge). */
    tideDepthMode?: boolean;
    onToggleTideDepth?: () => void;
    /** Night dim — chartplotter-style red-tinted screen dim for the helm. */
    nightDim?: boolean;
    onToggleNightDim?: () => void;

    /** Chart key — the plain-words legend card (MapHub owns the card). */
    onOpenChartKey?: () => void;

    /**
     * If provided, renders a "Plan ENC Route" action row in the dropdown.
     * The callback runs `tryInshoreRoute` and returns a short status string
     * for the row's secondary text. ChartModes manages the local busy state.
     *
     * Only shown when `encCellCount > 0` — pointless without imported cells.
     */
    encCellCount?: number;
    onPlanEncRoute?: () => Promise<{ ok: boolean; summary: string }>;

    /** Seaway Graph debug overlay toggle (masterplan Stage IV Phase 10).
     *  Shown beside the ENC route row, gated the same way. */
    seawayDebugVisible?: boolean;
    onToggleSeawayDebug?: () => void;
}

export const ChartModes: React.FC<ChartModesProps> = (props) => {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    // Plan-ENC-Route action state. Local because the action is "fire and
    // surface a one-line result" — no need to lift to MapHub. The actual
    // routing call comes from props.onPlanEncRoute.
    const [encBusy, setEncBusy] = useState(false);
    const [encLastResult, setEncLastResult] = useState<string | null>(null);
    const showEncRouteRow = !!props.onPlanEncRoute && (props.encCellCount ?? 0) > 0;
    // DEV-ONLY row (Shane 2026-07-12: "we still have our blue squiggles"
    // — the Phase 10 gate-graph debug overlay sat one tap below
    // Satellite and kept getting flipped on while exploring the menu).
    // The masterplan is explicit: "debug map overlay only". Resurrect it
    // for a debugging session with
    // localStorage.setItem('thalassa_dev_seaway', 'true').
    const seawayDevMode = (() => {
        try {
            return localStorage.getItem('thalassa_dev_seaway') === 'true';
        } catch {
            return false;
        }
    })();
    const showSeawayRow = seawayDevMode && !!props.onToggleSeawayDebug && (props.encCellCount ?? 0) > 0;
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

    // The mutual-exclusion handshake with the right-rail Layer menu lived
    // here: this picker dispatched 'thalassa:chart-modes-open' and listened
    // for 'thalassa:layer-menu-open', so only one of the two big dropdowns
    // could be open at once. Both halves went 2026-07-22 with the legacy
    // LayerFABMenu — it was the sole listener for the first event and the
    // sole dispatcher of the second, so the pair had become a conversation
    // with nobody. There is no longer a second dropdown to collide with.

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
                    aria-label="Open chart layers"
                >
                    {/* Icon only. The preset name (or "Custom" once you had
                        deviated from one) used to sit here and was the noisiest
                        thing on the chart — a wide pill of text centred over the
                        water, changing under you as you toggled layers (Shane
                        2026-07-22). The presets it named are gone; what remains
                        behind this chip is the sea chart, the base switcher and
                        the rest, so a layers glyph says it without the width. */}
                    <span aria-hidden className="inline-flex items-center justify-center w-4 h-4">
                        <MapIcon className="w-4 h-4" />
                    </span>
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
                        // Landscape phones: ~10 rows overran a 375 px-tall
                        // viewport with no scroll, putting Chart key +
                        // Clear All permanently off-screen in the cockpit's
                        // most common orientation (2026-07-12 audit).
                        maxHeight: 'min(68vh, 520px)',
                        overflowY: 'auto',
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
                    {props.setEncVisible && props.encVisible !== undefined && (
                        <button
                            onClick={() => {
                                triggerHaptic('light');
                                props.setEncVisible?.(!props.encVisible);
                            }}
                            className="flex items-center gap-3 text-left transition-colors"
                            style={{
                                background: props.encVisible ? 'rgba(56, 189, 248, 0.18)' : 'rgba(56, 189, 248, 0.08)',
                                borderRadius: 10,
                                padding: '8px 10px',
                                border: '1px solid rgba(56, 189, 248, 0.25)',
                            }}
                            aria-label="Toggle the sea chart"
                            aria-pressed={props.encVisible}
                        >
                            <span
                                aria-hidden
                                className="inline-flex items-center justify-center w-[18px] h-[18px] shrink-0"
                                style={{ color: '#38bdf8' }}
                            >
                                <MapIcon className="w-[18px] h-[18px]" />
                            </span>
                            <span className="flex-1 min-w-0">
                                <span className="block font-semibold" style={{ color: '#38bdf8', fontSize: 13 }}>
                                    Sea chart {props.encVisible ? 'ON' : 'off'}
                                </span>
                                <span
                                    className="block opacity-70"
                                    style={{
                                        color: 'rgba(255,255,255,0.7)',
                                        fontSize: 10,
                                        marginTop: 1,
                                    }}
                                >
                                    depth bands, contours, marks and hazards
                                </span>
                            </span>
                        </button>
                    )}
                    {showEncRouteRow && (
                        <button
                            onClick={() => {
                                triggerHaptic('light');
                                void runEncRoute();
                            }}
                            disabled={encBusy}
                            className="flex items-center gap-3 text-left transition-colors"
                            style={{
                                background: encBusy ? 'rgba(167, 139, 250, 0.18)' : 'rgba(167, 139, 250, 0.08)',
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
                    {props.setSatelliteVisible && (
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
                                <span className="block font-semibold" style={{ color: '#34d399', fontSize: 13 }}>
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
                    {props.setHybridVisible && (
                        <button
                            onClick={() => {
                                triggerHaptic('light');
                                props.setHybridVisible?.(!props.hybridVisible);
                            }}
                            className="flex items-center gap-3 text-left transition-colors"
                            style={{
                                background: props.hybridVisible
                                    ? 'rgba(56, 189, 248, 0.20)'
                                    : 'rgba(56, 189, 248, 0.08)',
                                borderRadius: 10,
                                padding: '8px 10px',
                                border: '1px solid rgba(56, 189, 248, 0.3)',
                            }}
                            aria-label="Toggle hybrid satellite base (imagery with roads and names)"
                        >
                            <span
                                aria-hidden
                                className="inline-flex items-center justify-center w-[18px] h-[18px] shrink-0"
                                style={{ color: '#38bdf8', fontSize: 14, lineHeight: 1 }}
                            >
                                🗺️
                            </span>
                            <span className="flex-1 min-w-0">
                                <span className="block font-semibold" style={{ color: '#38bdf8', fontSize: 13 }}>
                                    Hybrid {props.hybridVisible ? 'ON' : 'off'}
                                </span>
                                <span
                                    className="block opacity-70"
                                    style={{
                                        color: 'rgba(255,255,255,0.7)',
                                        fontSize: 10,
                                        marginTop: 1,
                                    }}
                                >
                                    imagery with roads &amp; names — the public-page look
                                </span>
                            </span>
                        </button>
                    )}
                    {props.setOceanBaseVisible && (
                        <button
                            onClick={() => {
                                triggerHaptic('light');
                                props.setOceanBaseVisible?.(!props.oceanBaseVisible);
                            }}
                            className="flex items-center gap-3 text-left transition-colors"
                            style={{
                                background: props.oceanBaseVisible
                                    ? 'rgba(45, 212, 191, 0.20)'
                                    : 'rgba(45, 212, 191, 0.08)',
                                borderRadius: 10,
                                padding: '8px 10px',
                                border: '1px solid rgba(45, 212, 191, 0.3)',
                            }}
                            aria-label="Toggle bathymetric ocean base"
                            aria-pressed={props.oceanBaseVisible ?? false}
                        >
                            <span
                                aria-hidden
                                className="inline-flex items-center justify-center w-[18px] h-[18px] shrink-0"
                                style={{ color: '#2dd4bf', fontSize: 14, lineHeight: 1 }}
                            >
                                🌊
                            </span>
                            <span className="flex-1 min-w-0">
                                <span className="block font-semibold" style={{ color: '#2dd4bf', fontSize: 13 }}>
                                    Bathymetry {props.oceanBaseVisible ? 'ON' : 'off'}
                                </span>
                                <span
                                    className="block opacity-70"
                                    style={{
                                        color: 'rgba(255,255,255,0.7)',
                                        fontSize: 10,
                                        marginTop: 1,
                                    }}
                                >
                                    depth contours as the chart — no photo
                                </span>
                            </span>
                        </button>
                    )}
                    {props.onToggleTideDepth && (
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
                                <span className="block font-semibold" style={{ color: '#2dd4bf', fontSize: 13 }}>
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
                    {props.onToggleNightDim && (
                        <button
                            onClick={() => {
                                props.onToggleNightDim?.();
                            }}
                            className="flex items-center gap-3 text-left transition-colors"
                            style={{
                                background: props.nightDim ? 'rgba(220, 80, 60, 0.18)' : 'rgba(220, 80, 60, 0.08)',
                                borderRadius: 10,
                                padding: '8px 10px',
                                border: '1px solid rgba(220, 80, 60, 0.25)',
                            }}
                            aria-label="Toggle night dim"
                            aria-pressed={props.nightDim ?? false}
                        >
                            <span
                                aria-hidden
                                className="inline-flex items-center justify-center w-[18px] h-[18px] shrink-0"
                                style={{ color: '#e07a5f', fontSize: 14 }}
                            >
                                ☾
                            </span>
                            <span className="flex-1 min-w-0">
                                <span className="block font-semibold" style={{ color: '#e07a5f', fontSize: 13 }}>
                                    Night dim {props.nightDim ? 'ON' : 'off'}
                                </span>
                                <span
                                    className="block opacity-70"
                                    style={{
                                        color: 'rgba(255,255,255,0.7)',
                                        fontSize: 10,
                                        marginTop: 1,
                                    }}
                                >
                                    red-tinted dim protects night vision at the helm
                                </span>
                            </span>
                        </button>
                    )}
                    {props.onOpenChartKey && (
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
                                <span className="block font-semibold" style={{ color: '#fbbf24', fontSize: 13 }}>
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
                    {showSeawayRow && (
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
                                <span className="block font-semibold" style={{ color: '#38bdf8', fontSize: 13 }}>
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
                </div>
            )}
        </div>
    );
};
