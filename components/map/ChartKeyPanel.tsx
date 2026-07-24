import { CAUTION_BAND_COLOR, DEPARE_BAND_COLORS, SHALLOW_CAUTION_COLOR } from './encDepthStyle';
import { CAUTION_CLASS_COLOURS, CAUTION_DEFAULT_COLOUR } from './encPopup';
import { seamarkIconDataUri } from './seamarkIcons';
import { LIGHT_COLOUR_HEX } from '../../services/enc/types';

export interface ChartKeyPanelProps {
    visible: boolean;
    imageryOn: boolean;
    tideDepthMode: boolean;
    draftConfigured: boolean;
    onClose: () => void;
}

/**
 * Static chart vocabulary: depth palette, datum explanation, seamarks and
 * caution-area colours. Kept outside MapHub so changes to the legend cannot
 * accidentally touch map lifecycle or layer orchestration.
 */
export function ChartKeyPanel({ visible, imageryOn, tideDepthMode, draftConfigured, onClose }: ChartKeyPanelProps) {
    if (!visible) return null;

    return (
        <div
            role="region"
            aria-label="Nautical chart key"
            // Tracer card = 9995 and compass rose = 9996. The key is an
            // explicitly-opened planning reference, so it must sit above both
            // while remaining below blocking sheets/modals (10050+).
            className="absolute bottom-44 right-2 z-[9997] w-64 max-h-[calc(100dvh-12rem)] overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-slate-900/95 p-3 shadow-2xl"
        >
            <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-black uppercase tracking-widest text-amber-300">Chart key</span>
                <button
                    onClick={onClose}
                    aria-label="Close chart key"
                    className="flex min-h-[44px] min-w-[44px] items-center justify-center text-xs font-bold text-gray-400"
                >
                    ✕
                </button>
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
                    <div>Numbers are metres of water RIGHT NOW (charted + predicted tide) — 3₄ means 3.4 m.</div>
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
                <div className="flex items-center justify-between">
                    <span className="font-black uppercase tracking-wider text-gray-200">Marks &amp; lights</span>
                    <span className="text-[11px] text-gray-400">IALA-A here · most tap to read</span>
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
                                    className="inline-block h-2.5 w-5 shrink-0 rounded-sm border border-white/25"
                                    style={{
                                        background: `linear-gradient(90deg,${LIGHT_COLOUR_HEX.green ?? '#22c55e'} 34%,${LIGHT_COLOUR_HEX.white ?? '#f0e030'} 34%,${LIGHT_COLOUR_HEX.white ?? '#f0e030'} 66%,${LIGHT_COLOUR_HEX.red ?? '#ef4444'} 66%)`,
                                    }}
                                />
                            ) : (
                                <span
                                    className="inline-block h-2.5 w-5 shrink-0 rounded-sm border border-white/25"
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
