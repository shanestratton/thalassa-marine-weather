import React from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import type { OffshoreComparisonView } from '../map/useOffshoreComparison';
import { offshoreComparisonSummary } from '../../services/routing/offshoreModelComparison';

const number = (value: number | null | undefined, suffix: string) =>
    typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : 'Unknown';

export default function OffshoreComparisonSheet({ comparison }: { comparison: OffshoreComparisonView }) {
    const spread = offshoreComparisonSummary(comparison.rows);
    return (
        <ModalSheet
            isOpen={comparison.open}
            onClose={comparison.close}
            title="Compare offshore forecasts"
            maxWidth="max-w-5xl"
            footer={
                <button
                    type="button"
                    className="w-full min-h-11 rounded-xl bg-white/10 px-4 py-2 font-bold text-white"
                    onClick={comparison.close}
                >
                    {comparison.busy || comparison.checking ? 'Stop and close' : 'Close comparison'}
                </button>
            }
        >
            <div className="min-w-0 space-y-3 text-sm text-slate-200">
                <p>
                    Four global models, up to two at a time, within 60 seconds. Dashed lines are forecast candidates.
                    Check and use verifies the full passage against available charts, land, depths and environmental
                    limits.
                </p>
                <p className="text-xs text-slate-400">
                    Candidate distances and ETAs cover the offshore gates. Terminal legs are added and checked before
                    selection. Missing models and forecast cells remain unavailable.
                </p>
                <div
                    className="max-w-full overflow-x-auto rounded-xl border border-white/10"
                    role="region"
                    aria-label="Model comparison results"
                    tabIndex={0}
                >
                    <table className="w-full min-w-160 text-left text-xs">
                        <caption className="sr-only">
                            Forecast routes; only a chart-verified candidate can become the active passage.
                        </caption>
                        <thead className="bg-white/5">
                            <tr>
                                {['Model', 'Distance', 'ETA', 'Worst wind / gust', 'Upwind', 'Motor', 'Use route'].map(
                                    (label) => (
                                        <th key={label} className="px-3 py-2 font-bold">
                                            {label}
                                        </th>
                                    ),
                                )}
                            </tr>
                        </thead>
                        <tbody>
                            {comparison.rows.map((row) => {
                                const verified = comparison.verified[row.model.id];
                                const data = verified ?? row.candidate;
                                return (
                                    <tr key={row.model.id} className="border-t border-white/10">
                                        <th scope="row" className="px-3 py-3">
                                            <span style={{ color: row.model.colour }}>{row.model.label}</span>
                                            <span className="block max-w-48 text-[11px] font-normal text-slate-400">
                                                {row.message ??
                                                    (row.status === 'loading'
                                                        ? 'Checking forecast…'
                                                        : row.status === 'candidate'
                                                          ? verified
                                                              ? 'Final geometry verified'
                                                              : 'Candidate — not verified'
                                                          : 'Unavailable')}
                                            </span>
                                        </th>
                                        <td className="px-3 py-3">{number(data?.result.totalDistanceNM, ' NM')}</td>
                                        <td className="px-3 py-3">
                                            {data ? (
                                                <>
                                                    <span>
                                                        {new Date(data.result.arrivalTime).toLocaleString(undefined, {
                                                            month: 'short',
                                                            day: 'numeric',
                                                            hour: '2-digit',
                                                            minute: '2-digit',
                                                        })}
                                                    </span>
                                                    <span className="block text-slate-400">
                                                        {number(data.result.totalDurationHours, ' h')}
                                                    </span>
                                                </>
                                            ) : (
                                                '—'
                                            )}
                                        </td>
                                        <td className="px-3 py-3">
                                            {number(data?.maxWindKts, ' kt')} / {number(data?.maxGustKts, ' kt')}
                                        </td>
                                        <td className="px-3 py-3">{number(data?.upwindPercent, '%')}</td>
                                        <td className="px-3 py-3">{number(data?.result.motorHours, ' h')}</td>
                                        <td className="px-3 py-3">
                                            <button
                                                type="button"
                                                disabled={
                                                    row.status !== 'candidate' ||
                                                    comparison.busy ||
                                                    !!comparison.checking ||
                                                    comparison.selected === row.model.id
                                                }
                                                onClick={() => void comparison.select(row.model.id)}
                                                className="min-h-11 min-w-24 rounded-lg bg-sky-500/20 px-3 py-2 font-bold text-sky-200 disabled:opacity-50"
                                            >
                                                {comparison.checking === row.model.id
                                                    ? 'Checking…'
                                                    : comparison.selected === row.model.id
                                                      ? 'Selected'
                                                      : 'Check and use'}
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                {comparison.busy && <p role="status">Loading forecasts and computing routes in background Workers…</p>}
                {comparison.message && (
                    <p role="status" className="rounded-lg bg-white/5 p-3">
                        {comparison.message}
                    </p>
                )}
                <p className="text-xs text-slate-400">
                    {spread
                        ? `${spread.modelCount} models returned candidates. Offshore ETA spread: ${spread.etaSpreadHours.toFixed(1)} h. This is model disagreement, not a probability or safety guarantee.`
                        : 'ETA spread needs at least two model candidates. No consensus is inferred from missing models.'}{' '}
                    A changed chart-verified path may have unknown upwind and motor hours.
                </p>
                <ul className="space-y-1 text-[11px] text-slate-400">
                    {comparison.rows.map(({ model }) => (
                        <li key={model.id}>
                            {model.label}: {model.credit}
                        </li>
                    ))}
                </ul>
            </div>
        </ModalSheet>
    );
}
