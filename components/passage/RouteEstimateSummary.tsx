import React from 'react';
import {
    routeEstimateLines,
    type RouteFuelEstimate,
    type RouteSailingStats,
} from '../../services/isochrone/routeStats';
import type { RouteComfortSummary } from '../../services/isochrone/routeComfort';

export function RouteEstimateSummary({
    stats,
    fuel,
    comfort,
}: {
    stats?: RouteSailingStats | null;
    fuel?: RouteFuelEstimate | null;
    comfort?: RouteComfortSummary | null;
}) {
    const lines = routeEstimateLines(stats, fuel, comfort);
    if (!lines.length) return null;
    return (
        <div
            aria-label="Route sailing and fuel estimates"
            className="min-w-0 space-y-1 border-t border-white/10 px-3.5 py-2 text-xs leading-relaxed text-slate-300 [overflow-wrap:anywhere]"
        >
            {lines.map((line) => (
                <p key={line}>{line}</p>
            ))}
        </div>
    );
}
