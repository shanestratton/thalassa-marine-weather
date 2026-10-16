import React from 'react';
import type { DepartureScenario } from '../../services/departureWindow';
import { triggerHaptic } from '../../utils/system';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';

const VERDICT = {
    go: 'Within compared weather limits',
    maybe: 'Check coverage',
    avoid: 'Avoid weather',
    'no-go': 'No viable option',
};
const number = (value: number | null | undefined, suffix = '') =>
    value == null || !Number.isFinite(value) ? 'Unknown' : `${value.toFixed(1)}${suffix}`;
function utc(iso: string): string {
    const d = new Date(iso);
    return Number.isFinite(d.getTime())
        ? `${d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })} UTC`
        : iso;
}
interface Props {
    open: boolean;
    onClose: () => void;
    planning: boolean;
    scenarios: DepartureScenario[];
    progressLabel?: string;
    onAccept: (scenario: DepartureScenario) => void;
    origin?: string;
    destination?: string;
}
export const DepartureWindowSheet: React.FC<Props> = ({
    open,
    onClose,
    planning,
    scenarios,
    progressLabel,
    onAccept,
    origin,
    destination,
}) => {
    const closeButtonRef = React.useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(open, { initialFocusRef: closeButtonRef, onEscape: onClose });
    if (!open) return null;
    const sorted = [...scenarios].sort((a, b) => a.score - b.score || a.departureTime.localeCompare(b.departureTime));
    const best = sorted.find((s) => s.routeFound && s.verdict !== 'no-go' && Number.isFinite(s.score));
    const dates = scenarios.map((s) => s.departureTime).sort();
    return (
        <OverlayPortal className="flex items-center justify-center p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]">
            <div role="presentation" onClick={onClose} className="absolute inset-0 bg-black/70 backdrop-blur-xs" />
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="departure-window-title"
                className="relative w-full max-w-5xl max-h-full flex flex-col bg-slate-950 border border-white/10 rounded-3xl shadow-2xl text-slate-200"
            >
                <div className="p-4 border-b border-white/10">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <h2 id="departure-window-title" className="font-bold text-white">
                                Departure Window
                            </h2>
                            <p className="text-xs text-slate-400">
                                {origin && destination ? `${origin} → ${destination}` : 'Departure weather comparison'}
                            </p>
                        </div>
                        <button
                            type="button"
                            ref={closeButtonRef}
                            onClick={onClose}
                            aria-label="Close"
                            className="p-3 -m-1"
                        >
                            ✕
                        </button>
                    </div>
                    <p className="mt-2 text-xs text-slate-400">
                        Exploratory estimates in 3–6 hour steps, limited to 14 runs and 90 seconds. Only fully covered
                        terms shared by every compared option affect the ranking. Selecting a time reruns chart
                        verification.
                    </p>
                    <p className="mt-1 text-xs text-amber-200">
                        Weather ranking does not clear tide gates. The existing tide leave-window check remains required
                        for a verified chart route.
                    </p>
                    {dates.length > 0 && (
                        <p className="mt-1 text-xs">
                            Evaluated: {utc(dates[0])} to {utc(dates.at(-1)!)} ({dates.length} departures).
                        </p>
                    )}
                    {planning && (
                        <p role="status" className="mt-2 text-xs text-sky-300">
                            {progressLabel ?? `Computing… ${scenarios.length} completed`}
                        </p>
                    )}
                </div>
                {best && !planning && (
                    <div className="px-4 pt-3 text-xs text-emerald-200">
                        Best compared estimate: <strong>{utc(best.departureTime)}</strong>. Ranked on{' '}
                        {best.rankedTerms?.join(', ') ?? 'available weather'}.
                    </div>
                )}
                <div className="overflow-auto p-4" style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}>
                    {!sorted.length && (
                        <p className="text-sm text-slate-400">
                            {planning ? 'Running first scenario…' : 'No completed scenarios available.'}
                        </p>
                    )}
                    {sorted.length > 0 && (
                        <table
                            className="w-full min-w-[880px] text-xs text-left border-collapse"
                            aria-label="Departure weather comparison"
                        >
                            <thead>
                                <tr>
                                    {[
                                        'Departure (UTC)',
                                        'Duration',
                                        'Wind max',
                                        'Wave max',
                                        'Rain max',
                                        'Upwind',
                                        'Ocean current',
                                        'Beta comfort',
                                        'Tide / coverage',
                                    ].map((label) => (
                                        <th key={label} scope="col" className="p-2 border-b border-white/10">
                                            {label}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {sorted.map((s) => (
                                    <tr key={s.departureTime} className="border-b border-white/10 align-top">
                                        <th scope="row" className="p-2">
                                            <button
                                                type="button"
                                                disabled={!s.routeFound || s.verdict === 'no-go'}
                                                aria-label={`Select departure ${utc(s.departureTime)}`}
                                                onClick={() => {
                                                    triggerHaptic('light');
                                                    onAccept(s);
                                                }}
                                                className="text-left text-sky-300 underline disabled:text-slate-500 disabled:no-underline"
                                            >
                                                <span>{utc(s.departureTime)}</span>
                                            </button>
                                            <div className="mt-1 text-slate-400 font-normal">{VERDICT[s.verdict]}</div>
                                        </th>
                                        <td className="p-2">
                                            {s.routeFound ? number(s.durationHours, ' h') : 'No route'}
                                        </td>
                                        <td className="p-2">
                                            {s.windComplete === false ? 'Unknown' : number(s.maxWindKts, ' kn')}
                                        </td>
                                        <td className="p-2">{number(s.maxWaveM, ' m')}</td>
                                        <td className="p-2">{number(s.maxRainMmPerHour, ' mm/h')}</td>
                                        <td className="p-2">{number(s.upwindPct, '%')}</td>
                                        <td className="p-2">
                                            {number(s.avgCurrentKts, ' kn along track')}
                                            <div className="text-slate-500">One surface snapshot; no tidal streams</div>
                                        </td>
                                        <td className="p-2">
                                            {number(s.comfortLevel, '/3')}
                                            <div className="text-slate-500">Total waves only</div>
                                        </td>
                                        <td className="p-2">
                                            Tide: {s.tideStatus ?? 'unknown'}
                                            <div className="text-amber-200">
                                                {s.coverage?.length
                                                    ? `Incomplete: ${s.coverage.join(', ')}`
                                                    : s.routeFound
                                                      ? 'Available weather sampled'
                                                      : 'No route estimate'}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </OverlayPortal>
    );
};
