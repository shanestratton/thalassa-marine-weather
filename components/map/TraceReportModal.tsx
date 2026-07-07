/**
 * Route report (masterplan Phase 3) — the review step of the Guided Passage
 * Builder. Once the trace is built (hand + auto), this modal groups every
 * leg verdict by severity, headlines THE departure window ("leave 09:10–
 * 13:30 and every tide gate clears"), and offers per-issue action:
 *   • Fix — micro-A* detour on the already-built tracer grid, spliced back
 *     as pins (the app doesn't just say no, it shows the way through);
 *   • Acknowledge — for the unfixable (uncharted / conflicting data): the
 *     skipper owns the line, the ack is explicit. No fake fixes, ever.
 * Approve-all runs every fixable danger in one tap.
 */
import React from 'react';
import type { TraceLegVerdict, TracePoint } from '../../services/routeTracer';
import { traceHealth } from '../../services/routeTracer';

interface Props {
    open: boolean;
    onClose: () => void;
    pins: TracePoint[];
    verdicts: TraceLegVerdict[];
    tideLabels: Record<number, string>;
    /** null while computing, '' when nothing tide-gated. */
    departureLabel: string | null;
    ackedLegs: ReadonlySet<number>;
    /** Leg index currently being fixed (spinner), or null. */
    fixBusy: number | null;
    onFlyTo: (p: TracePoint) => void;
    onFixLeg: (i: number) => void;
    onFixAll: () => void;
    onAckLeg: (i: number) => void;
}

const sevRow = (
    v: TraceLegVerdict,
    i: number,
    pins: TracePoint[],
    tideLabels: Record<number, string>,
    acked: ReadonlySet<number>,
    fixBusy: number | null,
    onFlyTo: Props['onFlyTo'],
    onFixLeg: Props['onFixLeg'],
    onAckLeg: Props['onAckLeg'],
): React.ReactNode => {
    const spot = v.issues[0]?.at ?? v.minAt ?? pins[i];
    const isAcked = acked.has(i);
    return (
        <div key={i} className={`rounded-xl border border-white/10 bg-white/5 p-2 ${isAcked ? 'opacity-50' : ''}`}>
            <button onClick={() => onFlyTo(spot)} className="w-full text-left">
                <div className="flex items-start gap-1.5 text-[12px] leading-tight text-gray-100">
                    <span className={v.grade === 'danger' ? 'text-red-400' : 'text-amber-300'}>
                        {v.grade === 'danger' ? '⛔' : '⚠'}
                    </span>
                    <span>
                        <span className="font-mono text-gray-400">
                            leg {i + 1}→{i + 2}
                        </span>{' '}
                        {v.issues[0]?.message ?? v.grade}
                    </span>
                </div>
                <div className="pl-5 text-[11px] leading-tight text-gray-400">
                    {v.issues.slice(1).map((iss, k) => (
                        <div key={k}>· {iss.message}</div>
                    ))}
                    {tideLabels[i] && <div>🌊 {tideLabels[i]}</div>}
                    {v.nudge && <div>💡 {v.nudge}</div>}
                    <div className="text-gray-500">tap to view on the chart</div>
                </div>
            </button>
            {v.grade === 'danger' && !isAcked && (
                <div className="mt-1.5 flex gap-1.5 pl-5">
                    <button
                        onClick={() => onFixLeg(i)}
                        disabled={fixBusy !== null}
                        className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-emerald-300 active:scale-95 disabled:opacity-50"
                    >
                        {fixBusy === i ? 'Fixing…' : 'Fix it'}
                    </button>
                    <button
                        onClick={() => onAckLeg(i)}
                        className="rounded-lg bg-white/5 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-gray-300 active:scale-95"
                    >
                        Acknowledge
                    </button>
                </div>
            )}
        </div>
    );
};

export const TraceReportModal: React.FC<Props> = ({
    open,
    onClose,
    pins,
    verdicts,
    tideLabels,
    departureLabel,
    ackedLegs,
    fixBusy,
    onFlyTo,
    onFixLeg,
    onFixAll,
    onAckLeg,
}) => {
    if (!open) return null;
    const h = traceHealth(verdicts);
    const dangers = verdicts.map((v, i) => ({ v, i })).filter((x) => x.v.grade === 'danger');
    const cautions = verdicts.map((v, i) => ({ v, i })).filter((x) => x.v.grade === 'caution');
    const fixable = dangers.filter((x) => !ackedLegs.has(x.i));
    return (
        <div className="fixed inset-0 z-[10050] flex items-end justify-center bg-black/60 sm:items-center">
            <div className="max-h-[80vh] w-full max-w-md overflow-hidden rounded-t-3xl border border-white/10 bg-slate-900 shadow-2xl sm:rounded-3xl">
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                    <span className="text-sm font-black uppercase tracking-widest text-amber-300">Route report</span>
                    <button onClick={onClose} className="text-sm font-bold text-gray-400">
                        Close
                    </button>
                </div>
                <div className="border-b border-white/10 px-4 py-2 text-[12px] font-bold">
                    <span className="text-emerald-300">{h.clear} clear</span>
                    <span className="text-gray-500"> · </span>
                    <span className="text-amber-300">{h.caution} caution</span>
                    <span className="text-gray-500"> · </span>
                    <span className="text-red-400">{h.danger} no-go</span>
                </div>
                {departureLabel === null ? (
                    <div className="border-b border-white/10 px-4 py-2 text-[11px] text-gray-400">
                        Checking tide gates…
                    </div>
                ) : departureLabel !== '' ? (
                    <div className="border-b border-white/10 bg-sky-500/10 px-4 py-2.5 text-[13px] font-black leading-snug text-sky-300">
                        🌊 {departureLabel}
                    </div>
                ) : null}
                <div className="max-h-[46vh] space-y-2 overflow-y-auto px-4 py-3">
                    {verdicts.length === 0 && (
                        <div className="text-[12px] text-gray-400">No legs yet — trace a route first.</div>
                    )}
                    {dangers.map((x) =>
                        sevRow(x.v, x.i, pins, tideLabels, ackedLegs, fixBusy, onFlyTo, onFixLeg, onAckLeg),
                    )}
                    {cautions.map((x) =>
                        sevRow(x.v, x.i, pins, tideLabels, ackedLegs, fixBusy, onFlyTo, onFixLeg, onAckLeg),
                    )}
                    {h.danger === 0 && h.caution === 0 && verdicts.length > 0 && (
                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-[12px] font-bold text-emerald-300">
                            ✓ Every leg checks out for your keel. Good water the whole way.
                        </div>
                    )}
                </div>
                {fixable.length > 0 && (
                    <div className="border-t border-white/10 px-4 py-3">
                        <button
                            onClick={onFixAll}
                            disabled={fixBusy !== null}
                            className="w-full rounded-xl bg-emerald-500/20 py-2.5 text-[12px] font-black uppercase tracking-wide text-emerald-300 active:scale-95 disabled:opacity-50"
                        >
                            {fixBusy !== null
                                ? 'Fixing…'
                                : `Fix all ${fixable.length} no-go leg${fixable.length > 1 ? 's' : ''}`}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};
