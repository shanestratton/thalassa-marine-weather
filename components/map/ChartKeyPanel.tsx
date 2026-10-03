import { CAUTION_BAND_COLOR, DEPARE_BAND_COLORS, SHALLOW_CAUTION_COLOR } from './encDepthStyle';
import { CAUTION_CLASS_COLOURS, CAUTION_DEFAULT_COLOUR } from './encPopup';
import { seamarkIconDataUri } from './seamarkIcons';
import { LIGHT_COLOUR_HEX } from '../../services/enc/types';
import { BLOCKED_LEAD_DASH, NEEDS_TIDE_AMBER, SURVEY_DASH, UNVERIFIED_ROUTE_DASH } from './inshoreRouteState';

/**
 * The planned route's colours (owner decision 10, Shane 2026-09-30: "Amber if
 * a tide clears it") — the app had no key for them, and solid amber (needs
 * tide) against amber dots (survey) is a difference only a key explains.
 * The inks are the route layers' own (useMapInit). Round-4 review
 * (2026-09-30): the red names every reason it is drawn for, and the leads
 * overlay's own needs-tide dash — which the survey stretches used to share —
 * is keyed apart from the route.
 */
const ROUTE_KEY: readonly { swatch: string; label: string }[] = [
    { swatch: '#2dd4bf', label: 'Clear water' },
    { swatch: '#facc15', label: 'Marked channel' },
    // …and, with no chip, a marked channel's edge close by (round-3 fix-up,
    // 2026-10-03: inshoreRouteState 'edge' — the same amber, named in the
    // route notes).
    { swatch: NEEDS_TIDE_AMBER, label: 'Needs tide — the chip says when; no chip: close to a channel’s edge' },
    {
        swatch: `radial-gradient(circle, ${SURVEY_DASH.ink} 0 1.5px, ${SURVEY_DASH.casing} 1.6px) 0 50% / 5px 6px repeat-x`,
        label: 'Survey may be out, or old',
    },
    { swatch: '#ff1744', label: 'No tide clears it, no tide data, charts disagree, uncharted, canal or hazard' },
    {
        // The unverified line (inshoreRouteState UNVERIFIED_ROUTE_DASH): red
        // and white DASHES on a dark edge — not checked, where the solid red
        // above is checked and dangerous (2026-10-03; amber dashes until
        // then). The white gaps keep it apart from the blocked lead below.
        swatch: [
            `linear-gradient(${UNVERIFIED_ROUTE_DASH.casing}, ${UNVERIFIED_ROUTE_DASH.casing}) top / 100% 1px no-repeat`,
            `linear-gradient(${UNVERIFIED_ROUTE_DASH.casing}, ${UNVERIFIED_ROUTE_DASH.casing}) bottom / 100% 1px no-repeat`,
            `repeating-linear-gradient(90deg, ${UNVERIFIED_ROUTE_DASH.ink} 0 5px, ${UNVERIFIED_ROUTE_DASH.gap} 5px 8px)`,
        ].join(', '),
        label: 'Not checked yet — red and white dashes; it can’t be saved',
    },
    { swatch: '#1e40af', label: 'Offshore' },
    {
        // The leads overlay's own inks (useChartLeadsLayer AMBER_INK on
        // AMBER_CASING_INK — the same two values, without pulling the overlay
        // hook into the key).
        swatch: `repeating-linear-gradient(90deg, ${NEEDS_TIDE_AMBER} 0 5px, ${SURVEY_DASH.casing} 5px 9px)`,
        label: 'Charted lead (leads overlay) that needs tide',
    },
    {
        // The leads overlay's blocked lead (owner decision 5): red dashes on
        // its dark casing (BLOCKED_LEAD_DASH) — keyed here, beside the route's
        // red and white dashes, so the two are never read as one (review
        // fix-up, 2026-10-03).
        swatch: `repeating-linear-gradient(90deg, ${BLOCKED_LEAD_DASH.ink} 0 5px, ${BLOCKED_LEAD_DASH.casing} 5px 8px)`,
        label: 'Charted lead (leads overlay) blocked — red dashes: your mast can’t clear it, or no air draft set',
    },
];

export interface ChartKeyPanelProps {
    visible: boolean;
    imageryOn: boolean;
    tideDepthMode: boolean;
    draftConfigured: boolean;
    onClose: () => void;
    /** Reuse the same chart vocabulary inside OBS's combined key. */
    inline?: boolean;
    tideTimeLabel?: string;
}

/**
 * Static chart vocabulary: depth palette, datum explanation, seamarks and
 * caution-area colours. Kept outside MapHub so changes to the legend cannot
 * accidentally touch map lifecycle or layer orchestration.
 */
export function ChartKeyPanel({
    visible,
    imageryOn,
    tideDepthMode,
    draftConfigured,
    onClose,
    inline = false,
    tideTimeLabel = 'RIGHT NOW',
}: ChartKeyPanelProps) {
    if (!visible) return null;

    return (
        <div
            role="region"
            aria-label="Nautical chart key"
            // Tracer card = 9995 and compass rose = 9996. The key is an
            // explicitly-opened planning reference, so it must sit above both
            // while remaining below blocking sheets/modals (10050+).
            className={
                inline
                    ? 'min-w-0'
                    : 'absolute bottom-44 right-2 z-9997 w-64 max-h-[calc(100dvh-12rem)] overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-slate-900/95 p-3 shadow-2xl'
            }
        >
            <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-black uppercase tracking-widest text-amber-300">Chart key</span>
                {!inline && (
                    <button
                        onClick={onClose}
                        aria-label="Close chart key"
                        className="flex min-h-[44px] min-w-[44px] items-center justify-center text-xs font-bold text-gray-400"
                    >
                        ✕
                    </button>
                )}
            </div>

            {!imageryOn && (
                <div className="mb-1 flex overflow-hidden rounded-md border border-white/10">
                    {(
                        [
                            [DEPARE_BAND_COLORS.drying, 'dries'],
                            [DEPARE_BAND_COLORS.b0to2, '0–2'],
                            [DEPARE_BAND_COLORS.b2to5, '2–5'],
                            [DEPARE_BAND_COLORS.b5to10, '5–10'],
                            [DEPARE_BAND_COLORS.b10to20, '10–20'],
                            [DEPARE_BAND_COLORS.b20to50, '20–50'],
                            [DEPARE_BAND_COLORS.b50plus, '50+'],
                        ] as const
                    ).map(([hex, label]) => (
                        <div key={label} className="flex-1">
                            <div style={{ background: hex, height: 14 }} />
                            <div className="bg-slate-800 py-0.5 text-center text-[10px] font-bold text-gray-300">
                                {label}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <div className="space-y-1 text-[10px] leading-snug text-gray-300">
                {!imageryOn && (
                    <div>Bluer = shallower — like the paper chart. White = deep. Khaki dries at low tide.</div>
                )}
                {tideDepthMode ? (
                    <div>Numbers are metres of water {tideTimeLabel} (charted + predicted tide) — 3₄ means 3.4 m.</div>
                ) : (
                    <div>Numbers are metres at the lowest tide (LAT) — 3₄ means 3.4 m. Olive numbers dry.</div>
                )}
                {imageryOn ? (
                    <div className="text-sky-200">
                        Over imagery: bright white glaze = water with the router&apos;s full margin under your keel (1½×
                        draft + 0.5 m).
                        <span style={{ color: CAUTION_BAND_COLOR }}> Light amber</span> = margin-thin (clears the keel
                        but the router still flags it as a hazard);
                        <span style={{ color: SHALLOW_CAUTION_COLOR }}> amber</span> = too shallow;
                        <span style={{ color: DEPARE_BAND_COLORS.drying }}> khaki</span> = dries at low tide. Bare
                        imagery = no usable depth here — uncharted, unattributed, or surveyed too coarsely for this
                        zoom. Treat it as unsurveyed.
                    </div>
                ) : (
                    <div>
                        The <span className="font-bold text-orange-400">amber</span> contour is your keel&apos;s limit;
                        thin slate-grey lines join equal depths.
                    </div>
                )}
                {!draftConfigured && (
                    <div className="text-amber-300">
                        Keel reads use a default 2.5 m draft — set your vessel in Settings.
                    </div>
                )}
                {tideDepthMode && (
                    <div className="text-teal-300">
                        Teal numbers = live tide depth is on (drying numbers stay olive).
                    </div>
                )}
            </div>

            <div className="mt-2 space-y-1 border-t border-white/10 pt-2 text-[10px] leading-snug text-gray-300">
                <span className="font-black uppercase tracking-wider text-gray-200">Planned route</span>
                <div className="grid grid-cols-1 gap-y-1">
                    {ROUTE_KEY.map(({ swatch, label }) => (
                        <div key={label} className="flex min-w-0 items-center gap-1.5">
                            <span
                                className="inline-block h-1.5 w-5 shrink-0 rounded-xs"
                                style={{ background: swatch }}
                                aria-hidden
                            />
                            <span className="min-w-0">{label}</span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="mt-2 space-y-1 border-t border-white/10 pt-2 text-[10px] leading-snug text-gray-300">
                <div className="flex items-center justify-between">
                    <span className="font-black uppercase tracking-wider text-gray-200">Marks &amp; lights</span>
                    <span className="text-[11px] text-gray-400">Shown in IALA-A colours · most tap to read</span>
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                    {(
                        [
                            ['icon', 'sm-buoy-port', 'Port-hand (can)'],
                            ['icon', 'sm-buoy-starboard', 'Starboard (cone)'],
                            ['icons4', 'cardinal', 'Cardinals (N E S W)'],
                            ['icon', 'sm-safe-water', 'Safe water'],
                            ['icon', 'sm-isolated-danger', 'Isolated danger'],
                            ['icon', 'sm-special', 'Special mark'],
                            ['icon', 'sm-buoy-prefchan-stbd', 'Preferred channel'],
                            ['icon', 'sm-hazard-wreck-dangerous', 'Wreck'],
                            ['icon', 'sm-hazard-rock', 'Rock / obstruction'],
                            ['icon', 'sm-light-major', 'Light'],
                            ['icon', 'sm-anchorage', 'Anchorage'],
                            ['icon', 'sm-mark-unknown', 'Unknown mark'],
                            ['sector', '', 'Light sector'],
                            ['swatch', CAUTION_DEFAULT_COLOUR, 'Restricted / caution'],
                            ['swatch', CAUTION_CLASS_COLOURS.CBLARE ?? '#7c3aed', 'Submarine cable'],
                            ['swatch', CAUTION_CLASS_COLOURS.PIPARE ?? '#5b21b6', 'Pipeline'],
                            ['swatch', CAUTION_CLASS_COLOURS.TSSLPT ?? '#d97706', 'TSS lane / precautionary'],
                            ['swatch', CAUTION_CLASS_COLOURS.TSEZNE ?? '#c2410c', 'TSS keep-out zone'],
                            ['swatch', CAUTION_CLASS_COLOURS.MARCUL ?? '#5f7a3a', 'Marine farm'],
                            ['swatch', CAUTION_CLASS_COLOURS.SBDARE ?? '#8a8a5a', 'Seabed type'],
                            ['swatch', CAUTION_CLASS_COLOURS.DWRTPT ?? '#0e7490', 'Deep-water route'],
                            ['swatch', '#3b82c4', 'Fairway edge'],
                            ['swatch', '#f59e0b', 'Leading line / track'],
                        ] as const
                    ).map(([kind, key, label]) => (
                        <div
                            key={label}
                            className={`flex min-w-0 items-center gap-1.5 ${kind === 'icons4' ? 'col-span-2' : ''}`}
                        >
                            {kind === 'icon' ? (
                                <img
                                    src={seamarkIconDataUri(key) ?? ''}
                                    alt=""
                                    aria-hidden
                                    className="h-5 w-5 shrink-0"
                                />
                            ) : kind === 'icons4' ? (
                                <span className="flex shrink-0 -space-x-1">
                                    {['north', 'east', 'south', 'west'].map((cardinal) => (
                                        <img
                                            key={cardinal}
                                            src={seamarkIconDataUri(`sm-cardinal-${cardinal}`) ?? ''}
                                            alt=""
                                            aria-hidden
                                            className="h-5 w-5"
                                        />
                                    ))}
                                </span>
                            ) : kind === 'sector' ? (
                                <span
                                    className="inline-block h-2.5 w-5 shrink-0 rounded-xs border border-white/25"
                                    style={{
                                        background: `linear-gradient(90deg,${LIGHT_COLOUR_HEX.green ?? '#22c55e'} 34%,${LIGHT_COLOUR_HEX.white ?? '#f0e030'} 34%,${LIGHT_COLOUR_HEX.white ?? '#f0e030'} 66%,${LIGHT_COLOUR_HEX.red ?? '#ef4444'} 66%)`,
                                    }}
                                />
                            ) : (
                                <span
                                    className="inline-block h-2.5 w-5 shrink-0 rounded-xs border border-white/25"
                                    style={{ background: key }}
                                />
                            )}
                            <span className="min-w-0 truncate">{label}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
