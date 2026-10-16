import type { TideShortcutView } from '../../services/routing/tideGatedPlanning';

export interface TideShortcutControlProps {
    enabled: boolean;
    setEnabled: (value: boolean) => void;
    bufferMinutes: number;
    setBufferMinutes: (value: number) => void;
    review: TideShortcutView | null;
}
export function TideShortcutControl({
    enabled,
    setEnabled,
    bufferMinutes,
    setBufferMinutes,
    review,
}: TideShortcutControlProps) {
    const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return (
        <details
            className="mx-3.5 mb-3 min-w-0 rounded-lg border border-amber-400/20 bg-amber-500/5 text-xs text-slate-200"
            data-testid="tide-shortcut-control"
        >
            <summary className="min-h-11 cursor-pointer px-3 py-3 font-semibold text-amber-200">
                Tide windows · {enabled ? (review?.kind === 'preview' ? 'timed preview' : 'on') : 'off'}
            </summary>
            <div className="space-y-3 px-3 pb-3 break-words">
                <label className="flex min-h-11 items-center gap-3">
                    <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                    Consider a tide-gated shortcut
                </label>
                {enabled && (
                    <label className="flex min-h-11 flex-wrap items-center gap-2">
                        Arrival buffer (minutes)
                        <input
                            aria-label="Tide shortcut arrival buffer in minutes"
                            type="number"
                            min={1}
                            max={60}
                            step={1}
                            value={bufferMinutes}
                            className="min-h-11 w-20 rounded-md border border-white/20 bg-slate-900 px-2 text-base"
                            onChange={(event) => {
                                const value = Number(event.target.value);
                                if (Number.isInteger(value) && value >= 1 && value <= 60) setBufferMinutes(value);
                            }}
                        />
                    </label>
                )}
                <p>
                    For charted passages up to 50 NM. Uses the planned speed and exact departure, with the full arrival
                    buffer. No automatic wait or departure change.
                </p>
                {enabled && (
                    <p role="status">
                        {review?.kind === 'held'
                            ? review.reason
                            : review?.kind === 'preview'
                              ? `Amber preview: depart ${time(review.departureMs)}, modeled arrival ${time(review.arrivalMs)} at ${review.speedKts} kn, ±${review.uncertaintyMs / 60000} min. Review expires ${time(review.expiresAtMs)}. Save, export and departure actions remain held for this temporary preview.`
                              : 'Reading tide evidence already aboard. The ordinary route remains available when a timed crossing cannot qualify.'}
                    </p>
                )}
                {review?.kind === 'preview' && <p>{review.sourceSummary}</p>}
                <p className="text-slate-400">
                    Official high/low tables are informational. WorldTides has no reviewed navigation permission. A
                    delay needs a separately reviewed holding area; a loop is never treated as a wait.
                </p>
            </div>
        </details>
    );
}
