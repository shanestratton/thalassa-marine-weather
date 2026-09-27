import { useEffect, useId, useRef, useState } from 'react';
import { triggerHaptic } from '../../utils/system';

export type MapBaseKind = 'hybrid' | 'satellite' | 'ocean';

export function mapBaseVisibility(value: MapBaseKind): {
    hybrid: boolean;
    satellite: boolean;
    ocean: boolean;
} {
    return {
        hybrid: value === 'hybrid',
        satellite: value === 'satellite',
        ocean: value === 'ocean',
    };
}

const MAP_BASE_OPTIONS: ReadonlyArray<{
    id: MapBaseKind;
    label: string;
    description: string;
}> = [
    { id: 'hybrid', label: 'Hybrid', description: 'Imagery with place names' },
    { id: 'satellite', label: 'Satellite', description: 'Clean aerial imagery' },
    { id: 'ocean', label: 'Ocean', description: 'Bathymetry background' },
];

export interface MapBaseSelectorProps {
    visible: boolean;
    value: MapBaseKind;
    onChange: (value: MapBaseKind) => void;
    /** Installed cells. Zero means there is nothing to switch, so no row. */
    encCellCount: number;
    encVisible: boolean;
    onToggleEnc: () => void;
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
}: MapBaseSelectorProps) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const menuId = useId();
    const selected = MAP_BASE_OPTIONS.find((option) => option.id === value) ?? MAP_BASE_OPTIONS[0];
    /* The ENC row is a menu item too, so the arrow keys have to know about it
       or the one control a skipper reaches for under memory pressure would be
       the one item they cannot reach without a mouse. */
    const itemCount = MAP_BASE_OPTIONS.length + 1;
    const noCharts = encCellCount === 0;

    useEffect(() => {
        if (!visible) setOpen(false);
    }, [visible]);

    useEffect(() => {
        if (!open) return;
        optionRefs.current[MAP_BASE_OPTIONS.findIndex((option) => option.id === value)]?.focus({ preventScroll: true });

        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', closeOnOutsidePointer);
        return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
    }, [open, value]);

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
            className={`absolute left-1/2 flex -translate-x-1/2 flex-col items-center ${open ? 'z-9998' : 'z-700'}`}
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
                <span className="text-[10px] font-black uppercase tracking-wider">{selected.label}</span>
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
                    className="thalassa-popover-solid mt-2 w-[min(280px,calc(100vw-152px))] rounded-2xl border border-white/10 bg-slate-950/95 p-2 shadow-2xl"
                >
                    {MAP_BASE_OPTIONS.map((option, index) => {
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

                        A CHECKBOX, not a fourth radio. Hybrid/Satellite/Ocean
                        are one exclusive choice of raster; ENC is a separate
                        stack drawn ABOVE whichever of those is showing. Making
                        it a menuitemradio would tell a screen reader that
                        turning charts on turns the base map off.

                        Always offered, including with no charts installed:
                        browse charts start off on every fresh OBS (Release
                        119), and the no-charts notice (with its Library
                        button, the one Add Charts route) only shows while
                        charts are on. Gating this row on an installed cell
                        left a fresh install no way to reach either
                        (Shane 2026-09-27). */}
                    <>
                        <div role="separator" className="mx-2 my-1 h-px bg-white/10" />
                        <button
                            ref={(element) => {
                                optionRefs.current[MAP_BASE_OPTIONS.length] = element;
                            }}
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={encVisible}
                            aria-label={encVisible ? 'Turn ENC charts off' : 'Turn ENC charts on'}
                            onClick={() => {
                                triggerHaptic('light');
                                onToggleEnc();
                                setOpen(false);
                                triggerRef.current?.focus({ preventScroll: true });
                            }}
                            className={`flex min-h-[52px] w-full items-center justify-between rounded-xl px-3 text-left transition-colors active:scale-[0.98] ${
                                encVisible
                                    ? 'border border-emerald-400/35 bg-emerald-500/15 text-emerald-200'
                                    : 'border border-white/10 text-slate-400'
                            }`}
                        >
                            <span>
                                <span className="block text-xs font-black">ENC charts</span>
                                <span className="block text-[10px] font-medium text-slate-400">
                                    {noCharts
                                        ? 'None installed yet'
                                        : encVisible
                                          ? 'Safety layers above the base'
                                          : 'Hidden — base map only'}
                                </span>
                            </span>
                            {/* The state, not just what tapping does. */}
                            <span
                                className={`text-[10px] font-black uppercase tracking-wider ${
                                    encVisible ? 'text-emerald-300' : 'text-slate-500'
                                }`}
                            >
                                {encVisible ? 'ON' : 'OFF'}
                            </span>
                        </button>
                    </>
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
