import { useEffect, useId, useRef, useState } from 'react';
import type { ObsChartBase } from '../../types/settings';
import { triggerHaptic } from '../../utils/system';

/** 'light' is the web desk planner's own base (127-DESKMAP), never an Obs pick. */
export type MapBaseKind = ObsChartBase | 'light';

/**
 * Which layer groups a base lights. The imagery bases stay exclusive.
 * 'satellite' is no longer offered (125-13a) and useMapBase reads a saved one
 * as Relief + Sat; the type keeps it readable for old saved settings.
 */
export function mapBaseVisibility(value: MapBaseKind) {
    return {
        relief: value === 'relief' || value === 'reliefSat' || value === 'light',
        landImagery: value === 'reliefSat',
        ocean: value === 'ocean',
        satellite: value === 'satellite',
        hybrid: value === 'hybrid',
    };
}

/* Short labels: the checked one rides in the top-centre pill between the zoom
   readout and the mic. The descriptions say what each base really shows.
   Relief leads (Shane 2026-10-04: the satellite stitching); see reliefBase.ts.
   The old Satellite base is gone (Shane 2026-10-09: "remove the old satellite
   map"): Relief + Sat is the imagery-on-land answer to its stitching, and a
   saved Satellite opens there (useMapBase). Hybrid, imagery with roads and
   names, stays for now. */
export const MAP_BASE_OPTIONS: ReadonlyArray<{
    id: MapBaseKind;
    label: string;
    description: string;
}> = [
    { id: 'relief', label: 'Relief', description: 'Seafloor shape and depth' },
    { id: 'reliefSat', label: 'Relief + Sat', description: 'Seafloor, with satellite land' },
    { id: 'ocean', label: 'Ocean', description: 'Plain sea, depth offshore' },
    { id: 'hybrid', label: 'Hybrid', description: 'Imagery with roads and names' },
];

/* The web desk planner's bases (127-DESKMAP A2): Light first, and none of the
   dark ones. GA and GEBCO are both mean sea level, hence the row's words. */
export const DESK_MAP_BASE_OPTIONS: typeof MAP_BASE_OPTIONS = [
    { id: 'light', label: 'Light', description: 'Easiest to read · seabed is a guide, mean sea level' },
    MAP_BASE_OPTIONS[1],
    MAP_BASE_OPTIONS[3],
];

/** An on/off row drawn on top of the base, after it (the desk's Seamarks). */
export interface MapBaseToggle {
    id: string;
    label: string;
    detail: string;
    on: boolean;
    onToggle: () => void;
}

export interface MapBaseSelectorProps {
    visible: boolean;
    value: MapBaseKind;
    onChange: (value: MapBaseKind) => void;
    /** Installed cells. Zero means there is nothing to switch, so no row. */
    encCellCount: number;
    encVisible: boolean;
    onToggleEnc: () => void;
    /** The bases offered; Obs passes none and gets MAP_BASE_OPTIONS. */
    options?: typeof MAP_BASE_OPTIONS;
    /** The ENC master row (Obs). The desk passes false: the tracer raises its own chart floors. */
    encRow?: boolean;
    /** On/off rows after a separator, in the ENC row's style. */
    toggles?: readonly MapBaseToggle[];
    /** Extra classes on the root (the desk's narrow-window placement, index.css). */
    className?: string;
}

/**
 * Compact visual-base picker for the browsing chart. It deliberately changes
 * only the raster underneath the ENC stack; navigation marks, safety depth and
 * route checks remain owned by their existing layers.
 */
export function MapBaseSelector({
    visible,
    value,
    onChange,
    encCellCount,
    encVisible,
    onToggleEnc,
    options = MAP_BASE_OPTIONS,
    encRow = true,
    toggles = [],
    className = '',
}: MapBaseSelectorProps) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const menuId = useId();
    const selected = options.find((option) => option.id === value) ?? options[0];
    /* The ENC row and the switches are menu items too, so the arrow keys have
       to know about them or the one control a skipper reaches for under memory
       pressure would be the one item they cannot reach without a mouse. */
    const itemCount = options.length + (encRow ? 1 : 0) + toggles.length;
    const noCharts = encCellCount === 0;
    /* With nothing installed and the layer off, 'OFF' was a state for charts
       that don't exist, with no hint that the tap leads to getting some: it
       turns the layer on, and its no-charts notice carries the ENC Library
       button (UX scorecard run 10). Once on, the row says so as before. */
    const offerAdd = noCharts && !encVisible;
    const encDetail = noCharts
        ? 'None installed yet'
        : encVisible
          ? 'Safety layers above the base'
          : 'Hidden — base map only';
    const encName = `ENC charts, ${encDetail.toLowerCase()}${offerAdd ? ', tap to add charts' : ''}`;
    /* ── ENC MASTER SWITCH, then the desk's switches ──
       The ENC row lives here rather than floating on the chart (Shane
       2026-09-05: "move the enc button up into that drop down box... put it
       at the bottom after ocean"). A CHECKBOX, not another radio: the bases
       are one exclusive choice, and ENC is a separate stack drawn ABOVE
       whichever of those is showing; a menuitemradio would tell a screen
       reader that turning charts on turns the base map off. Always offered,
       including with no charts installed: browse charts start off on every
       fresh OBS (Release 119), and the no-charts notice (with its Library
       button, the one Add Charts route) only shows while charts are on.
       Gating this row on an installed cell left a fresh install no way to
       reach either (Shane 2026-09-27). The desk passes encRow={false} and its
       own switches (127-DESKMAP B1: Seamarks), drawn the same way. */
    const checks: Array<MapBaseToggle & { name?: string; add?: boolean }> = [
        ...(encRow
            ? [
                  {
                      id: 'enc',
                      label: 'ENC charts',
                      detail: encDetail,
                      on: encVisible,
                      onToggle: onToggleEnc,
                      name: encName,
                      add: offerAdd,
                  },
              ]
            : []),
        ...toggles,
    ];

    useEffect(() => {
        if (!visible) setOpen(false);
    }, [visible]);

    useEffect(() => {
        if (!open) return;
        optionRefs.current[options.findIndex((option) => option.id === value)]?.focus({ preventScroll: true });

        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', closeOnOutsidePointer);
        return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
    }, [open, value, options]);

    if (!visible) return null;

    /* Centred on the SAME top row as the zoom pill (left) and the Calypso
       mic / system-status pair (right) — Shane 2026-08-06: "smack bang in
       the middle". h-12 on the trigger matches those two 48px controls so
       the three read as one line; the menu is centred under the trigger by
       items-center rather than hanging off its left edge. */
    return (
        <div
            ref={rootRef}
            // An open picker must sit above passive coverage/tide notices.
            // The closed trigger shares the zoom readout's z-700, so the layer
            // menu (z-700, later in the tree) dims it with the rest of the
            // chart's controls instead of leaving it lit (UX scorecard run 7).
            className={`absolute left-1/2 flex -translate-x-1/2 flex-col items-center ${open ? 'z-9998' : 'z-700'} ${className}`}
            style={{ top: 'calc(env(safe-area-inset-top) + 8px)' }}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    setOpen(false);
                    triggerRef.current?.focus({ preventScroll: true });
                    return;
                }
                if (!open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
                event.preventDefault();
                const focusedIndex = optionRefs.current.findIndex((option) => option === document.activeElement);
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                const nextIndex = (focusedIndex + direction + itemCount) % itemCount;
                optionRefs.current[nextIndex]?.focus({ preventScroll: true });
            }}
        >
            <button
                ref={triggerRef}
                type="button"
                onClick={() => {
                    triggerHaptic('light');
                    setOpen((current) => !current);
                }}
                className="flex h-12 min-h-[44px] items-center gap-2 rounded-2xl border border-white/10 bg-slate-900/90 px-3 text-white shadow-xl backdrop-blur-xl transition-colors hover:bg-slate-800/95 active:scale-95"
                aria-label={`Map base: ${selected.label}`}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
            >
                <MapBaseIcon />
                <span className="thalassa-map-base-label text-[10px] font-black uppercase tracking-wider">
                    {selected.label}
                </span>
                {/* No beta badge here (Shane 2026-08-06: "completely remove the
                    Free Beta wording from the OBS page altogether"). The chart
                    is the working surface; the beta framing belongs in the app
                    header, under Skipper, and nowhere else. Dropping it also
                    halves this pill's width, which is what lets it sit centred
                    between the zoom readout and the mic without crowding
                    either. */}
                <span className="text-[10px] text-slate-400" aria-hidden="true">
                    {open ? '▴' : '▾'}
                </span>
            </button>

            {open && (
                <div
                    id={menuId}
                    role="menu"
                    aria-label="Map base"
                    // Opaque (thalassa-popover-solid): at /95 + blur the chart's coach
                    // mark read through behind the Hybrid row (UX scorecard run 5).
                    // thalassa-map-base-menu (index.css) bounds it above the tab
                    // bar and scrolls it: the chart is an isolated stacking
                    // context, so even open at z-9998 it paints under App's
                    // z-900 nav, and on a 320px-tall landscape phone with the
                    // bar open the ENC row sat under the Plan tab.
                    className="thalassa-popover-solid thalassa-map-base-menu mt-2 w-[min(280px,calc(100vw-152px))] rounded-2xl border border-white/10 bg-slate-950/95 p-2 shadow-2xl"
                >
                    {options.map((option, index) => {
                        const checked = option.id === value;
                        return (
                            <button
                                key={option.id}
                                ref={(element) => {
                                    optionRefs.current[index] = element;
                                }}
                                type="button"
                                role="menuitemradio"
                                aria-checked={checked}
                                onClick={() => {
                                    triggerHaptic('light');
                                    onChange(option.id);
                                    setOpen(false);
                                    triggerRef.current?.focus({ preventScroll: true });
                                }}
                                className={`flex min-h-[52px] w-full items-center justify-between rounded-xl px-3 text-left transition-colors active:scale-[0.98] ${
                                    checked
                                        ? 'border border-sky-400/35 bg-sky-500/15 text-sky-200'
                                        : 'border border-transparent text-slate-200 hover:bg-white/6'
                                }`}
                            >
                                <span>
                                    <span className="block text-xs font-black">{option.label}</span>
                                    <span className="block text-[10px] font-medium text-slate-400">
                                        {option.description}
                                    </span>
                                </span>
                                <span className={checked ? 'text-sky-300' : 'text-slate-400'} aria-hidden="true">
                                    {checked ? '●' : '○'}
                                </span>
                            </button>
                        );
                    })}

                    {/* ── ENC MASTER SWITCH ──
                        Lives here rather than floating on the chart (Shane
                        2026-09-05: "move the enc button up into that drop down
                        box... put it at the bottom after ocean").

                        A CHECKBOX, not another radio. The bases are one
                        exclusive choice; ENC is a separate stack drawn
                        ABOVE whichever of those is showing. Making
                        it a menuitemradio would tell a screen reader that
                        turning charts on turns the base map off.

                        Always offered, including with no charts installed:
                        browse charts start off on every fresh OBS (Release
                        119), and the no-charts notice (with its Library
                        button, the one Add Charts route) only shows while
                        charts are on. Gating this row on an installed cell
                        left a fresh install no way to reach either
                        (Shane 2026-09-27). */}
                    {checks.length > 0 && <div role="separator" className="mx-2 my-1 h-px bg-white/10" />}
                    {/* Named for the layer and its state, not for the tap:
                        'Turn ENC charts on' with aria-checked=false read as
                        "Turn ENC charts on, unchecked" and dropped 'None
                        installed yet' (UX scorecard run 9). aria-checked
                        carries on/off. */}
                    {checks.map((row, index) => (
                        <button
                            key={row.id}
                            ref={(element) => {
                                optionRefs.current[options.length + index] = element;
                            }}
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={row.on}
                            aria-label={row.name ?? `${row.label}, ${row.detail}`}
                            onClick={() => {
                                triggerHaptic('light');
                                row.onToggle();
                                setOpen(false);
                                triggerRef.current?.focus({ preventScroll: true });
                            }}
                            className={`flex min-h-[52px] w-full items-center justify-between rounded-xl px-3 text-left transition-colors active:scale-[0.98] ${
                                row.on
                                    ? 'border border-emerald-400/35 bg-emerald-500/15 text-emerald-200'
                                    : 'border border-white/10 text-slate-400'
                            }`}
                        >
                            <span>
                                <span className="block text-xs font-black">{row.label}</span>
                                <span className="block text-[10px] font-medium text-slate-400">{row.detail}</span>
                            </span>
                            {/* The state, not just what tapping does, while there
                                are charts to show; with none, the next step. */}
                            <span
                                className={`shrink-0 pl-2 text-[10px] font-black uppercase tracking-wider ${
                                    row.on ? 'text-emerald-300' : row.add ? 'text-sky-300' : 'text-slate-500'
                                }`}
                            >
                                {row.on ? 'ON' : row.add ? 'Add ›' : 'OFF'}
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

function MapBaseIcon() {
    return (
        // White, like the layers and Locate glyphs: one glyph colour across the
        // chart's controls (UX scorecard run 7).
        <svg
            className="h-4 w-4 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.7}
            aria-hidden="true"
        >
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 6.75l5.5-3 5.5 3 5.5-3v13.5l-5.5 3-5.5-3-5.5 3V6.75z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.25 3.75v13.5m5.5-10.5v13.5" />
        </svg>
    );
}
