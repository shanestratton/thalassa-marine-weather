import React, { useEffect, useState } from 'react';
import { loadEnsembleForecast } from '../../services/weather/ensembleForecast';
import { ENSEMBLE_PRODUCTS, type EnsembleForecast, type EnsembleProduct } from '../../utils/ensembleForecast';

export default function EnsembleBand({ latitude, longitude }: { latitude: number; longitude: number }) {
    const [product, setProduct] = useState<EnsembleProduct>('ifs');
    const [data, setData] = useState<EnsembleForecast | null>(null);
    const [failed, setFailed] = useState(false);
    const [metric, setMetric] = useState<'wind' | 'gust'>('wind');
    const [hour, setHour] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        setData(null);
        setFailed(false);
        setHour(0);
        loadEnsembleForecast(product, latitude, longitude, controller.signal)
            .then((result) => {
                if (!controller.signal.aborted) setData(result);
            })
            .catch(() => {
                if (!controller.signal.aborted) setFailed(true);
            });
        return () => controller.abort();
    }, [product, latitude, longitude]);
    const currentData =
        data?.product === product && data.latitude === latitude && data.longitude === longitude ? data : null;
    useEffect(() => {
        if (!currentData) return;
        const timer = setTimeout(
            () => {
                setData(null);
                setFailed(true);
            },
            Math.max(0, currentData.receivedAt + 1800000 - Date.now()),
        );
        return () => clearTimeout(timer);
    }, [currentData]);
    const rows = currentData?.hours ?? [];
    const selected = rows[Math.min(hour, rows.length - 1)];
    const statistic = selected?.[metric];
    const max = Math.max(30, ...rows.map((row) => row[metric].p90 ?? 0));
    const x = (i: number) =>
        ((rows[i].time - rows[0].time) / Math.max(1, rows[rows.length - 1].time - rows[0].time)) * 300;
    const y = (n: number) => 92 - (n / max) * 84;
    // Separate contiguous runs: missing members never get bridged by a shaded band.
    const runs: number[][] = [];
    rows.forEach((row, i) => {
        if (row[metric].p50 === null) return;
        if (!i || rows[i - 1][metric].p50 === null) runs.push([]);
        runs[runs.length - 1].push(i);
    });
    const point = (i: number, q: 'p10' | 'p50' | 'p90') => `${x(i)},${y(rows[i][metric][q]!)}`;
    return (
        <section aria-label="Ensemble probability bands" className="space-y-2 p-3 text-xs text-gray-300">
            <div className="flex flex-wrap gap-2">
                {(['ifs', 'ec46'] as const).map((id) => (
                    <button
                        type="button"
                        key={id}
                        aria-pressed={product === id}
                        onClick={() => setProduct(id)}
                        className="min-h-[44px] rounded-lg border border-white/20 px-3"
                    >
                        {id === 'ifs' ? 'IFS · 15 days' : 'EC46 · 46 days'}
                    </button>
                ))}
                <button
                    type="button"
                    onClick={() => setMetric(metric === 'wind' ? 'gust' : 'wind')}
                    className="min-h-[44px] rounded-lg border border-white/20 px-3"
                >
                    {metric === 'wind' ? 'Show gusts' : 'Show wind'}
                </button>
            </div>
            {!currentData ? (
                <p role="status">
                    {failed
                        ? 'Ensemble unavailable. Sign in and try reopening; the existing plan or service may not supply this product.'
                        : 'Loading real ensemble members…'}
                </p>
            ) : (
                <>
                    <p>
                        {ENSEMBLE_PRODUCTS[product].label} · {metric === 'wind' ? '10 m wind' : '10 m gust'} · knots
                    </p>
                    <svg
                        viewBox="0 0 300 100"
                        className="block w-full"
                        role="img"
                        aria-label="10th to 90th percentile band with median"
                    >
                        {runs
                            .filter((run) => run.length > 1)
                            .map((run) => (
                                <g key={run[0]}>
                                    <path
                                        d={`M${run.map((i) => point(i, 'p90')).join('L')}L${[...run]
                                            .reverse()
                                            .map((i) => point(i, 'p10'))
                                            .join('L')}Z`}
                                        fill="#38bdf8"
                                        fillOpacity="0.22"
                                    />
                                    <path
                                        d={`M${run.map((i) => point(i, 'p50')).join('L')}`}
                                        fill="none"
                                        stroke="#7dd3fc"
                                        strokeWidth="2"
                                    />
                                </g>
                            ))}
                    </svg>
                    {selected && (
                        <>
                            <label className="block">
                                Forecast time (UTC)
                                <input
                                    aria-label="Ensemble forecast time"
                                    type="range"
                                    min={0}
                                    max={rows.length - 1}
                                    value={Math.min(hour, rows.length - 1)}
                                    onChange={(e) => setHour(Number(e.target.value))}
                                    className="block min-h-[44px] w-full"
                                />
                            </label>
                            <p>{new Date(selected.time).toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
                            <p role="status">
                                {statistic?.p50 == null ? (
                                    `Insufficient members: ${statistic?.count ?? 0} of 51; at least 41 needed.`
                                ) : (
                                    <>
                                        {metric === 'gust' ? 'Gusts' : 'Wind'} ≥25 kt in {statistic.exceeding} of{' '}
                                        {statistic.count} available members (
                                        {Math.round((statistic.exceeding! / statistic.count) * 100)}%). p10 / median /
                                        p90: {statistic.p10!.toFixed(1)} / {statistic.p50.toFixed(1)} /{' '}
                                        {statistic.p90!.toFixed(1)} kt.
                                    </>
                                )}
                            </p>
                        </>
                    )}
                    <p>
                        Shading is the middle 80% of available members, not a guaranteed range. Missing members are
                        excluded from each count. Run issue time unavailable; received{' '}
                        {new Date(currentData.receivedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC. These are
                        member frequencies, not calibrated probabilities.
                    </p>
                    <p>
                        Data: ECMWF via Open-Meteo (CC BY 4.0); Thalassa percentile/count reduction. Actual coverage
                        ends {new Date(rows[rows.length - 1].time).toISOString().slice(0, 16).replace('T', ' ')} UTC.
                    </p>
                </>
            )}
        </section>
    );
}
