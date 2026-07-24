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
    encVisible: boolean;
    encHydration: { total: number; remaining: number };
    encNoCoverage: boolean;
    nightDim: boolean;
    onNightDimChange: (enabled: boolean) => void;
    onToggleChartKey: () => void;
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
    encVisible,
    encHydration,
    encNoCoverage,
    nightDim,
    onNightDimChange,
    onToggleChartKey,
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
                    className="absolute bottom-[calc(17rem+env(safe-area-inset-bottom))] left-1/2 z-[9980] flex min-h-[44px] -translate-x-1/2 items-center whitespace-nowrap rounded-md bg-slate-900/70 px-3 py-1 text-[11px] font-semibold tracking-wide text-gray-300 active:scale-95 sm:bottom-[calc(4.25rem+env(safe-area-inset-bottom))]"
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

            {encNoCoverage && encHydration.remaining === 0 && encVisible && surfaceVisible && (
                <div
                    className="pointer-events-none absolute bottom-6 left-1/2 z-[9980] -translate-x-1/2 whitespace-nowrap rounded-full border border-amber-500/30 bg-slate-900/85 px-3 py-1 text-[11px] font-bold text-amber-300 shadow-lg"
                    aria-live="polite"
                >
                    No chart coverage here — depths unverified
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
