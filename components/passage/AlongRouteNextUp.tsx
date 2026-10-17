import React from 'react';
import { nextAlongRouteRow, useAlongRouteReport } from '../../stores/alongRouteReportStore';

/** Only a report explicitly loaded on this account/boat, for this exact line.
 * No request, extrapolated current fix, approach advice or automatic follow. */
export function AlongRouteNextUp({
    points,
    alongNm,
}: {
    points: readonly { lat: number; lon: number }[];
    alongNm: number | null;
}) {
    const report = useAlongRouteReport();
    const key = JSON.stringify(points.map(({ lat, lon }) => [lat, lon]));
    const row = report?.routeIdentity === key ? nextAlongRouteRow(report, alongNm) : null;
    if (!row) return null;
    return (
        <div
            className="min-w-0 break-words border-b border-white/10 px-1 py-1 text-center text-[10px] leading-tight text-sky-200"
            data-testid="along-route-next-up"
        >
            <p className="font-black uppercase">Next reference · {row.kind}</p>
            <p>{row.name}</p>
            <p>
                {(row.alongNm - alongNm!).toFixed(1)} NM along · {row.offRouteNm.toFixed(1)} NM off line
            </p>
            <p>{row.etaMs === null ? 'ETA unknown' : `Plan ${new Date(row.etaMs).toISOString().slice(11, 16)} UTC`}</p>
            <p className="text-slate-400">Access / transit unverified</p>
        </div>
    );
}
