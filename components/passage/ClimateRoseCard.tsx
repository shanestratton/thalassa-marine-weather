import React, { useEffect, useState } from 'react';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import {
    assessEra5Climate,
    climateRouteWeights,
    lowerExposureMonths,
    CLIMATE_WAVE_BINS,
    CLIMATE_WIND_BINS,
    type ClimatePoint,
    type ClimateRouteMonth,
} from '../../services/climatology/era5Climate';
import { readEra5Climate } from '../../services/climatology/era5ClimateReader';
import type { TripLegLike } from '../../services/climatology/tcClimatology';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COLORS = ['#94a3b8', '#7dd3fc', '#38bdf8', '#34d399', '#fbbf24', '#fb923c', '#f87171', '#e879f9'];
type Props = { routeLegs?: readonly { points: readonly ClimatePoint[] }[]; legs?: readonly TripLegLike[] };
function Rose({
    values,
    label,
    bins,
    unit,
}: {
    values: number[];
    label: string;
    bins: readonly number[];
    unit: string;
}) {
    const totals = Array.from({ length: 16 }, (_, d) => values.slice(d * 8, d * 8 + 8).reduce((a, b) => a + b, 0));
    const max = Math.max(0.01, ...totals);
    const point = (angle: number, radius: number) =>
        `${60 + Math.sin(angle) * radius},${60 - Math.cos(angle) * radius}`;
    return (
        <div className="min-w-0 space-y-1">
            <h4 className="font-bold text-gray-200">{label}</h4>
            <svg
                viewBox="0 0 120 120"
                className="block w-full"
                role="img"
                aria-label={`${label} rose, directions coming from`}
            >
                <circle cx="60" cy="60" r="48" stroke="#64748b" fill="none" strokeWidth="0.5" />
                {totals.flatMap((_, direction) => {
                    let sum = 0;
                    return COLORS.map((color, bin) => {
                        const before = 48 * Math.sqrt(sum / max);
                        sum += values[direction * 8 + bin];
                        const after = 48 * Math.sqrt(sum / max),
                            angle = (direction * Math.PI) / 8,
                            half = Math.PI / 18;
                        return after > before ? (
                            <path
                                key={`${direction}-${bin}`}
                                d={`M${point(angle - half, before)}L${point(angle - half, after)}A${after},${after} 0 0 1 ${point(angle + half, after)}L${point(angle + half, before)}${before ? `A${before},${before} 0 0 0 ${point(angle - half, before)}` : ''}Z`}
                                fill={color}
                            />
                        ) : null;
                    });
                })}
                <text x="60" y="8" textAnchor="middle" fill="#cbd5e1" fontSize="8">
                    N
                </text>
            </svg>
            <p>Outer ring {Math.round(max * 100)}% per direction.</p>
            <ul className="flex flex-wrap gap-x-2 gap-y-1" aria-label={`${label} magnitude bins`}>
                {bins.map((v, i) => (
                    <li key={v}>
                        <span aria-hidden="true" style={{ color: COLORS[i] }}>
                            ●
                        </span>{' '}
                        {v}
                        {i === bins.length - 1 ? '+' : `–${bins[i + 1]}`} {unit}
                    </li>
                ))}
            </ul>
        </div>
    );
}
export default function ClimateRoseCard({ routeLegs, legs }: Props) {
    const [open, setOpen] = useState(false);
    const [month, setMonth] = useState(0);
    const [result, setResult] = useState<{
        months: ClimateRouteMonth[];
        generatedAt: string;
        routeLegs: Props['routeLegs'];
        legs: Props['legs'];
        scope: AuthIdentityScope;
    } | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        const scope = getAuthIdentityScope();
        const unsubscribe = subscribeAuthIdentityScope(() => {
            controller.abort();
            setResult(null);
            setFailed(true);
        });
        setResult(null);
        setFailed(false);
        const current = () => !controller.signal.aborted && isAuthIdentityScopeCurrent(scope);
        (async () => {
            let routes = routeLegs;
            if (!routes) {
                if (!legs?.length || legs.length > 100) throw new Error('No trip geometry');
                const saved = legs.some((leg) => !leg.routeCoordinates?.length)
                    ? (await import('../../services/shiplog/RoutesAndTracks')).fetchRoutesAndTracks
                    : null;
                const library = saved ? await saved() : { routes: [] };
                if (!current()) return;
                routes = legs.map((leg) => {
                    const matches = library.routes.filter(
                        (route) =>
                            (leg.saved_route_id && route.savedRouteId === leg.saved_route_id) ||
                            route.linkedPlanId === leg.id,
                    );
                    const points = leg.routeCoordinates?.length
                        ? leg.routeCoordinates
                        : matches.length === 1
                          ? matches[0].points
                          : null;
                    if (!points || points.length < 2) throw new Error('A leg has no unique saved route');
                    return { points };
                });
            }
            const weights = climateRouteWeights(routes);
            const source = await readEra5Climate(weights, controller.signal);
            if (current())
                setResult({
                    months: assessEra5Climate(weights, source.cells),
                    generatedAt: source.generatedAt,
                    routeLegs,
                    legs,
                    scope,
                });
        })().catch(() => {
            if (current()) setFailed(true);
        });
        return () => {
            controller.abort();
            unsubscribe();
        };
    }, [open, routeLegs, legs]);
    // Hide the old route synchronously; an effect alone leaves a stale frame on prop change.
    const visible =
        result && result.routeLegs === routeLegs && result.legs === legs && isAuthIdentityScopeCurrent(result.scope)
            ? result
            : null;
    const row = visible?.months[month];
    const best = visible ? lowerExposureMonths(visible.months) : [];
    return (
        <section aria-label="30-year wind and wave climate" className="mt-3 min-w-0 space-y-2 text-xs text-gray-400">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="min-h-[44px] w-full rounded-xl border border-white/10 px-3 text-left text-sky-300"
            >
                {open ? 'Hide wind and wave climate' : '30-year wind and wave climate'}
            </button>
            {open && (
                <div className="space-y-3 rounded-xl border border-white/10 p-3">
                    <p>
                        ERA5 reanalysis · 1991–2020 · coarse 1° grid. Historical climate, not a forecast or a
                        safe-passage recommendation.
                    </p>
                    {!visible ? (
                        <p role="status">
                            {failed
                                ? 'Climate unavailable: the static dataset, complete saved route or network is missing. No months are ranked.'
                                : 'Loading checked climate tiles…'}
                        </p>
                    ) : (
                        row && (
                            <>
                                <label className="flex flex-wrap items-center gap-2">
                                    Month{' '}
                                    <select
                                        aria-label="Climate month"
                                        value={month}
                                        onChange={(e) => setMonth(Number(e.target.value))}
                                        className="min-h-[44px] rounded-lg border border-white/20 bg-slate-900 px-3 text-gray-100"
                                    >
                                        {MONTHS.map((label, i) => (
                                            <option key={label} value={i}>
                                                {label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <p>
                                    {((row.coveredNm / row.totalNm) * 100).toFixed(0)}% of route length has both
                                    variables in all 30 years, with at least 90% original hourly coverage in each
                                    year/month.
                                </p>
                                {row.coveredNm > 0 ? (
                                    <>
                                        <p>
                                            Covered route: wind ≥34 kt in {(row.gales * 100).toFixed(1)}% of hours;
                                            significant waves ≥3 m in {(row.highWaves * 100).toFixed(1)}%.
                                        </p>
                                        <div className="grid grid-cols-2 gap-3">
                                            <Rose
                                                values={row.windRose}
                                                label="Wind"
                                                bins={CLIMATE_WIND_BINS}
                                                unit="kt"
                                            />
                                            <Rose
                                                values={row.waveRose}
                                                label="Waves"
                                                bins={CLIMATE_WAVE_BINS}
                                                unit="m"
                                            />
                                        </div>
                                        <p>
                                            Calm: wind &lt;1 kt {(row.windCalm * 100).toFixed(1)}%; waves &lt;0.1 m{' '}
                                            {(row.waveCalm * 100).toFixed(1)}%. Roses use route-length-weighted local
                                            frequencies; nearby cells are not independent observations.
                                        </p>
                                    </>
                                ) : (
                                    <p>
                                        No qualified 30-year coverage for this route/month. Missing ocean or land-mask
                                        cells are not calm water.
                                    </p>
                                )}
                                <p>
                                    {best.length
                                        ? `Lower historical exposure among fully covered months: ${best.map((i) => MONTHS[i]).join(', ')} (gale frequency first, waves ≥3 m second).`
                                        : 'No fully covered month: no best-month ranking.'}
                                </p>
                                <p>
                                    Data: Copernicus Climate Change Service / ECMWF ERA5, CC BY 4.0. Provider regridded
                                    to 1°; Thalassa hourly distributions and route weighting. Dataset built{' '}
                                    {visible.generatedAt.slice(0, 10)}. Climate changes and local coast effects can
                                    differ from this historical baseline.
                                </p>
                            </>
                        )
                    )}
                </div>
            )}
        </section>
    );
}
