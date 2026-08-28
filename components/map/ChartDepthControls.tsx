import { useRef } from 'react';
import type { TideOffsetRead } from '../../services/TideOffsetService';
import { triggerHaptic } from '../../utils/system';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export const TIDE_DEPTH_ACK_KEY = 'thalassa_tide_depth_ack_v1';

export interface ChartDepthControlsProps {
    /** Browsing-only depth/tide chrome. */
    surfaceVisible: boolean;
    /** The chart vocabulary remains useful while plotting on the Plan surface. */
    chartKeyVisible: boolean;
    plotting: boolean;
    tideDepthMode: boolean;
    tideOffsetInfo: TideOffsetRead | null;
    tideScrubQ: number;
    onTideScrubChange: (quarters: number) => void;
    onToggleTideDepth: () => void;
    encCellCount: number;
    /** Unsigned local/URL packs: display-only, never safety authority. */
    encReferenceCellCount: number;
    encVisible: boolean;
    encHydration: { total: number; remaining: number };
    encNoCoverage: boolean;
    /** Reference warning remains visible on both Browse and Plan surfaces. */
    referenceNoticeVisible: boolean;
    nightDim: boolean;
    onNightDimChange: (enabled: boolean) => void;
    onToggleChartKey: () => void;
    /** Opens the Pi-independent ENC Library when this viewport has no coverage. */
    onOpenEncLibrary: () => void;
}

/**
 * Small, map-relative controls that explain and manipulate the current depth
 * display. MapHub supplies state; this component owns only presentation.
 */
export function ChartDepthControls({
    surfaceVisible,
    chartKeyVisible,
    plotting,
    tideDepthMode,
    tideOffsetInfo,
    tideScrubQ,
    onTideScrubChange,
    onToggleTideDepth,
    encCellCount,
    encReferenceCellCount,
    encVisible,
    encHydration,
    encNoCoverage,
    referenceNoticeVisible,
    nightDim,
    onNightDimChange,
    onToggleChartKey,
    onOpenEncLibrary,
}: ChartDepthControlsProps) {
    return (
        <>
            {tideDepthMode && surfaceVisible && (
                <>
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            if (tideScrubQ > 0 && tideOffsetInfo) onTideScrubChange(0);
                            else onToggleTideDepth();
                        }}
                        aria-label={
                            tideScrubQ > 0 && tideOffsetInfo
                                ? 'Depths shown at a future tide — tap to return to now'
                                : 'Live tide depth is on — tap to return to chart datum'
                        }
                        className="absolute left-1/2 top-16 z-[9990] -translate-x-1/2 whitespace-nowrap rounded-full border px-4 py-2.5 text-[11px] font-black tracking-wide shadow-lg active:scale-95"
                        style={
                            tideOffsetInfo && tideScrubQ > 0
                                ? {
                                      background: 'rgba(49, 27, 95, 0.92)',
                                      borderColor: 'rgba(167, 139, 250, 0.5)',
                                      color: '#c4b5fd',
                                  }
                                : tideOffsetInfo
                                  ? {
                                        background: 'rgba(13, 63, 70, 0.92)',
                                        borderColor: 'rgba(45, 212, 191, 0.45)',
                                        color: '#5eead4',
                                    }
                                  : {
                                        background: 'rgba(69, 51, 8, 0.92)',
                                        borderColor: 'rgba(251, 191, 36, 0.45)',
                                        color: '#fcd34d',
                                    }
                        }
                    >
                        {tideOffsetInfo
                            ? `${
                                  tideScrubQ > 0
                                      ? `AT ${new Date(Date.now() + tideScrubQ * 900_000).toLocaleTimeString('en-AU', {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                            hour12: false,
                                        })}`
                                      : 'LIVE DEPTH'
                              } ${tideOffsetInfo.offsetM >= 0 ? '+' : ''}${tideOffsetInfo.offsetM.toFixed(1)} m ${
                                  tideOffsetInfo.trend === 'rising' ? '↑' : '↓'
                              }${tideOffsetInfo.stationName ? ` · ${tideOffsetInfo.stationName}` : ''}${
                                  tideOffsetInfo.approx ? ' · approx' : ''
                              }${tideScrubQ > 0 ? ' · tap for now' : ''}`
                            : 'LIVE DEPTH — no tide data, showing chart datum'}
                    </button>
                    {tideOffsetInfo && (
                        <div className="absolute left-1/2 top-[6.4rem] z-[9989] w-60 -translate-x-1/2 rounded-xl border border-white/10 bg-slate-900/85 px-3 pb-1 pt-1.5 shadow-lg">
                            <input
                                type="range"
                                min={0}
                                max={96}
                                step={1}
                                value={tideScrubQ}
                                onChange={(event) => onTideScrubChange(Number(event.target.value))}
                                aria-label="Scrub the tide through the next 24 hours"
                                className={`w-full ${tideScrubQ > 0 ? 'accent-violet-400' : 'accent-teal-400'}`}
                            />
                            <div className="flex justify-between text-[11px] font-bold text-gray-400">
                                <span>now</span>
                                <span>+12 h</span>
                                <span>+24 h</span>
                            </div>
                        </div>
                    )}
                </>
            )}

            {encCellCount > 0 && encVisible && chartKeyVisible && (
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        onToggleChartKey();
                    }}
                    aria-label="What the chart colours and numbers mean"
                    // The Plan map keeps its working controls in one left rail:
                    // tracer → chart key → detail scrubber. When the tracer is
                    // not active, the key simply occupies the scrubber's rail
                    // position rather than floating in the map centre.
                    className="absolute left-3 z-[9996] flex min-h-[44px] w-72 items-center justify-center whitespace-nowrap rounded-xl border border-white/10 bg-slate-900/85 px-3 py-1 text-[11px] font-semibold tracking-wide text-gray-300 shadow-lg backdrop-blur-sm active:scale-95"
                    style={{
                        // 9.2rem while plotting — third cut (Shane 2026-08-25):
                        // 8.8 grazed the scrubber, 9.8 hugged the tracer card
                        // ("too high up… centred between the two cards").
                        // Scrubber tops out ~8.1rem; 9.2 splits the daylight.
                        bottom: plotting
                            ? 'calc(9.2rem + env(safe-area-inset-bottom))'
                            : 'calc(5.4rem + env(safe-area-inset-bottom))',
                    }}
                >
                    {tideDepthMode && tideOffsetInfo
                        ? `depths at predicted tide (${tideOffsetInfo.offsetM >= 0 ? '+' : ''}${tideOffsetInfo.offsetM.toFixed(1)} m)`
                        : 'depths in metres at low tide (LAT)'}
                    <span className="ml-1 text-gray-500">· key</span>
                </button>
            )}

            {encHydration.remaining > 0 && encVisible && surfaceVisible && (
                <div
                    className="pointer-events-none absolute bottom-[calc(20rem+env(safe-area-inset-bottom))] left-1/2 z-[9980] -translate-x-1/2 whitespace-nowrap rounded-full border border-teal-500/30 bg-slate-900/85 px-3 py-1 text-[10px] font-bold text-teal-300 shadow-lg sm:bottom-[calc(7.25rem+env(safe-area-inset-bottom))]"
                    aria-live="polite"
                >
                    Chart downloading… ({encHydration.total - encHydration.remaining + 1} of {encHydration.total})
                </div>
            )}

            {plotting && surfaceVisible && (
                <button
                    onClick={() => onNightDimChange(!nightDim)}
                    aria-label="Toggle night dim"
                    aria-pressed={nightDim}
                    className="absolute top-[104px] left-[224px] z-[700] flex h-11 w-11 items-center justify-center rounded-full border shadow-lg backdrop-blur-md active:scale-95"
                    style={{
                        background: nightDim ? 'rgba(220, 80, 60, 0.30)' : 'rgba(15, 23, 42, 0.85)',
                        borderColor: 'rgba(220, 80, 60, 0.35)',
                        color: '#e07a5f',
                        fontSize: 18,
                    }}
                >
                    ☾
                </button>
            )}

            {encReferenceCellCount > 0 && encVisible && referenceNoticeVisible && (
                <div
                    className={`absolute left-1/2 z-[9995] flex w-[min(440px,calc(100%-24px))] -translate-x-1/2 items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-slate-950/95 px-3 py-2 text-[11px] font-bold text-amber-100 shadow-lg backdrop-blur-sm ${
                        tideDepthMode && surfaceVisible ? 'top-28' : 'top-16'
                    }`}
                    role="status"
                    aria-live="polite"
                >
                    <span className="leading-snug">
                        Unverified reference ENC installed — it cannot establish chart coverage, and route checks ignore
                        it.
                    </span>
                    <button
                        type="button"
                        onClick={() => {
                            triggerHaptic('light');
                            onOpenEncLibrary();
                        }}
                        className="min-h-[44px] shrink-0 rounded-xl border border-amber-400/35 bg-amber-400/15 px-3 text-[10px] font-black uppercase tracking-wider text-amber-100 transition-colors hover:bg-amber-400/25 active:scale-95"
                        aria-label="Manage unverified reference ENCs"
                    >
                        Manage
                    </button>
                </div>
            )}

            {encNoCoverage &&
                encReferenceCellCount === 0 &&
                encHydration.remaining === 0 &&
                encVisible &&
                surfaceVisible && (
                    <div
                        className="absolute bottom-6 left-1/2 z-[9980] flex w-[min(390px,calc(100%-24px))] -translate-x-1/2 items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-slate-900/92 px-3 py-2 text-[11px] font-bold text-amber-200 shadow-lg backdrop-blur-sm"
                        aria-live="polite"
                    >
                        <span className="leading-snug">
                            {encCellCount === 0
                                ? 'No verified ENC charts installed. Library imports are reference-only.'
                                : `You have ${encCellCount} ENC chart${encCellCount === 1 ? '' : 's'}, none covering here.`}
                        </span>
                        {/* The Library button is offered ONLY when there are no
                            charts at all.
                            
                            With charts installed but none covering the view,
                            this used to send the skipper to a page that greets
                            them with "No reference ENC cells are installed" —
                            because the Library lists hand-imported REFERENCE
                            packs, and every Pi and cloud import is tagged
                            navigation. So the one banner shown to a punter who
                            already owns charts led to an empty screen about a
                            different kind of chart. Saying how many they have
                            and where the gap is answers the question the banner
                            actually raises. */}
                        {encCellCount === 0 && (
                            <button
                                type="button"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onOpenEncLibrary();
                                }}
                                className="min-h-[44px] shrink-0 rounded-xl border border-amber-400/35 bg-amber-400/15 px-3 text-[10px] font-black uppercase tracking-wider text-amber-200 transition-colors hover:bg-amber-400/25 active:scale-95"
                                aria-label="Open on-device ENC Library"
                            >
                                ENC Library
                            </button>
                        )}
                    </div>
                )}
        </>
    );
}

export interface LiveTideAckModalProps {
    visible: boolean;
    onCancel: () => void;
    onAccept: () => void;
}

export function LiveTideAckModal({ visible, onCancel, onAccept }: LiveTideAckModalProps) {
    const cancelButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(visible, {
        initialFocusRef: cancelButtonRef,
        onEscape: onCancel,
    });

    if (!visible) return null;

    return (
        <div
            className="fixed inset-0 z-[10060] flex items-end justify-center bg-black/60 sm:items-center"
            onClick={onCancel}
            role="presentation"
        >
            <div
                ref={dialogRef}
                className="w-full max-w-md rounded-t-3xl border border-teal-500/30 bg-slate-900 p-5 shadow-2xl sm:rounded-3xl"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="live-tide-depth-title"
                tabIndex={-1}
            >
                <h2
                    id="live-tide-depth-title"
                    className="mb-2 text-sm font-black uppercase tracking-widest text-teal-300"
                >
                    Live tide depth
                </h2>
                <p className="mb-3 text-[13px] leading-snug text-gray-200">
                    Depths re-tint to charted depth + the predicted tide at the nearest station, refreshed every few
                    minutes. Numbers turn teal so you always know you're not reading chart datum.
                </p>
                <p className="mb-4 text-[12px] leading-snug text-amber-300/90">
                    It's a prediction, not a measurement: wind and pressure can move real water by 0.3 m or more, tide
                    differs across a bay, and sand moves. Your sounder is the truth. Route checks stay on chart datum
                    (LAT).
                </p>
                <div className="flex gap-2">
                    <button
                        ref={cancelButtonRef}
                        onClick={onCancel}
                        className="flex-1 rounded-xl bg-white/5 py-2.5 text-[12px] font-black uppercase tracking-wide text-gray-300 active:scale-95"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => {
                            try {
                                localStorage.setItem(TIDE_DEPTH_ACK_KEY, new Date().toISOString());
                            } catch {
                                /* private mode — sheet just shows again next time */
                            }
                            onAccept();
                        }}
                        className="flex-1 rounded-xl bg-teal-500/20 py-2.5 text-[12px] font-black uppercase tracking-wide text-teal-300 active:scale-95"
                    >
                        Show live depths
                    </button>
                </div>
            </div>
        </div>
    );
}
