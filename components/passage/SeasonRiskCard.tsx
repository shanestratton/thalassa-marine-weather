/**
 * SeasonRiskCard — cyclone season along the planned route (W1-12).
 *
 * Lazy-loaded in two places, and neither this card nor the IBTrACS JSON it
 * reads is fetched until one opens on a trip with a route:
 *  - the PLAN page's Trip · Legs modal (TripLegPicker), the live one: saved
 *    legs carry their own geometry (local, so it works offline) and no dates,
 *    so it shows the whole-year strip (`routeLegs`);
 *  - the Trip Overview sheet (`legs`, voyage rows with dates), reachable only
 *    from the parked legacy planner form today.
 * Worldwide — every basin IBTrACS covers, and an honest 0 where tropical
 * cyclones do not go.
 *
 * Reads, for each month the legs are at sea:
 *   "Tropical cyclones near this route in <month>: N in 34 years (IBTrACS)"
 * plus a 12-month strip with the season shaded. Rules for "near", "month"
 * and "season" live in services/climatology/tcClimatology.ts and are
 * summarised in the caption. Climate, not a forecast; counts, not intensities.
 *
 * Honest about gaps: a leg with no route is named, not silently dropped; a
 * trip with no route (or none available offline) gets one line instead of
 * vanishing; and a route into the Mediterranean is told that IBTrACS does
 * not track medicanes, so its 0 is not a measured zero.
 */
import React, { useEffect, useId, useState } from 'react';
import type { Voyage } from '../../services/VoyageService';
import {
    MONTH_NAMES,
    NEAR_ROUTE_BUFFER_NM,
    assessRouteSeason,
    legArrivalIso,
    loadTcClimatology,
    resolveLegGeometry,
    type PlannedRouteLike,
    type RouteLeg,
    type RouteSeason,
    type TcClimatology,
    type TripLegLike,
} from '../../services/climatology/tcClimatology';

type SeasonRiskCardProps =
    | {
          /** The trip's voyage rows, leg 1 → N (rows may carry the planner's geometry). */
          legs: Voyage[];
          routeLegs?: never;
      }
    | {
          /** Legs that already carry their geometry (saved traces), leg 1 → N. */
          routeLegs: RouteLeg[];
          legs?: never;
      };

type CardState =
    | { kind: 'loading' }
    | { kind: 'empty' }
    | { kind: 'no-route'; offline: boolean }
    | { kind: 'error' }
    | { kind: 'ready'; clim: TcClimatology; season: RouteSeason; skipped: number[]; offline: boolean };

interface ResolvedLegs {
    legs: RouteLeg[];
    /** 1-based numbers of the legs with no route to assess. */
    skipped: number[];
}

async function resolveLegs(rows: TripLegLike[]): Promise<ResolvedLegs> {
    let routes: PlannedRouteLike[] = [];
    if (rows.some((r) => !(r.routeCoordinates && r.routeCoordinates.length >= 2))) {
        try {
            const { fetchRoutesAndTracks } = await import('../../services/shiplog/RoutesAndTracks');
            routes = (await fetchRoutesAndTracks()).routes;
        } catch {
            /* offline / signed out: rows' own geometry and end points still work */
        }
    }
    const legs: RouteLeg[] = [];
    const skipped: number[] = [];
    rows.forEach((row, i) => {
        const points = resolveLegGeometry(row, routes);
        if (points) legs.push({ points, departureIso: row.departure_time, arrivalIso: legArrivalIso(row) });
        else skipped.push(i + 1);
    });
    return { legs, skipped };
}

/** Legs that bring their own line: those with fewer than two points are named as skipped. */
function splitRouteLegs(given: RouteLeg[]): ResolvedLegs {
    const legs: RouteLeg[] = [];
    const skipped: number[] = [];
    given.forEach((leg, i) => {
        const ok = (leg.points ?? []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
        if (ok.length >= 2) legs.push({ ...leg, points: ok });
        else skipped.push(i + 1);
    });
    return { legs, skipped };
}

/** Offline, the saved routes come back empty (RoutesAndTracks swallows the failure): say why. */
const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

const joinNumbers = (nums: number[]): string =>
    nums.length === 1 ? String(nums[0]) : `${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}`;

/** "Leg 2 has no saved route, so it is not counted." */
function skippedLegsLine(skipped: number[], offline: boolean): string | null {
    if (skipped.length === 0) return null;
    const one = skipped.length === 1;
    const reason = offline ? 'no route available offline' : 'no saved route';
    return `${one ? 'Leg' : 'Legs'} ${joinNumbers(skipped)} ${one ? 'has' : 'have'} ${reason}, so ${
        one ? 'it is' : 'they are'
    } not counted.`;
}

export const SeasonRiskCard: React.FC<SeasonRiskCardProps> = ({ legs, routeLegs: givenLegs }) => {
    const [state, setState] = useState<CardState>({ kind: 'loading' });
    const titleId = useId();

    useEffect(() => {
        let cancelled = false;
        setState({ kind: 'loading' });
        (async () => {
            const total = givenLegs ? givenLegs.length : (legs?.length ?? 0);
            const { legs: routeLegs, skipped } = givenLegs
                ? splitRouteLegs(givenLegs)
                : await resolveLegs((legs ?? []) as TripLegLike[]);
            if (cancelled) return;
            // Saved legs are local: being offline is never the reason one is missing.
            const offline = !givenLegs && isOffline();
            if (routeLegs.length === 0) {
                setState(total === 0 ? { kind: 'empty' } : { kind: 'no-route', offline });
                return;
            }
            try {
                const clim = await loadTcClimatology();
                const season = assessRouteSeason(clim, routeLegs);
                if (cancelled) return;
                setState(season ? { kind: 'ready', clim, season, skipped, offline } : { kind: 'no-route', offline });
            } catch {
                if (!cancelled) setState({ kind: 'error' });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [legs, givenLegs]);

    if (state.kind === 'loading' || state.kind === 'empty') return null;

    const header = (subtitle: string) => (
        <div className="px-1">
            <h3 id={titleId} className="text-[11px] font-bold text-sky-300 uppercase tracking-widest">
                Cyclone Season
            </h3>
            <p className="text-[11px] text-gray-500 leading-snug mt-0.5">{subtitle}</p>
        </div>
    );

    if (state.kind === 'error') {
        return (
            <section className="space-y-2" aria-labelledby={titleId}>
                {header('Tropical cyclones that passed near this route.')}
                <p className="px-1 text-[11px] text-gray-500">
                    Cyclone climatology couldn’t load. Try reopening the trip.
                </p>
            </section>
        );
    }

    if (state.kind === 'no-route') {
        return (
            <section className="space-y-2" aria-labelledby={titleId}>
                {header('Tropical cyclones that passed near this route.')}
                <p data-testid="tc-no-route" className="px-1 text-[11px] text-gray-500">
                    {state.offline
                        ? 'This trip has no route available offline, so the cyclone season can’t be shown.'
                        : 'This trip has no saved route yet, so the cyclone season can’t be shown.'}
                </p>
            </section>
        );
    }

    const { clim, season, skipped, offline } = state;
    const skippedLine = skippedLegsLine(skipped, offline);
    const yearsLabel = `${season.years} years`;
    const plannedMonths = new Set(season.planned.map((p) => p.month));
    // A multi-leg trip: a month line counts only the legs at sea that month,
    // the strip the whole trip, so the two can differ. Say so when they do.
    const linesDifferFromStrip = season.planned.some((p) => p.count !== season.monthly[p.month]);
    const caption = [
        'Climate, not a forecast; storm counts, not intensities.',
        `Near = the ${clim.boxDeg}° boxes the route crosses, plus ${NEAR_ROUTE_BUFFER_NM} NM.`,
        `Counted: tropical cyclones at ${clim.minWindKt} kt or more.`,
        'Shaded: one storm a decade or more.',
        season.planned.length > 0 ? 'Outlined: your passage.' : null,
        linesDifferFromStrip ? 'The months count the whole trip; each line, only the legs at sea that month.' : null,
    ]
        .filter(Boolean)
        .join(' ');

    return (
        <section className="space-y-2" aria-labelledby={titleId}>
            {header(
                `Tropical cyclones (hurricanes, typhoons) that passed near this route, ${season.firstYear}–${season.lastYear}.`,
            )}
            <div className="rounded-xl bg-white/3 border border-white/6 p-3 space-y-2.5">
                {season.planned.length > 0 ? (
                    <div className="space-y-1">
                        {season.planned.map((p) => (
                            <p
                                key={p.month}
                                data-testid="tc-month-line"
                                className="text-[12px] text-gray-200 leading-snug flex items-start gap-1.5"
                            >
                                <span
                                    aria-hidden="true"
                                    className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                                        p.inSeason ? 'bg-amber-400' : 'bg-white/25'
                                    }`}
                                />
                                <span>
                                    Tropical cyclones near this route in {MONTH_NAMES[p.month]}:{' '}
                                    <strong className={p.inSeason ? 'text-amber-300' : 'text-white'}>{p.count}</strong>{' '}
                                    in {yearsLabel} (IBTrACS)
                                </span>
                            </p>
                        ))}
                    </div>
                ) : (
                    <p className="text-[11px] text-gray-400">
                        No departure date yet: the strip shows every month along this route.
                    </p>
                )}

                {skippedLine && (
                    <p data-testid="tc-skipped-legs" className="text-[11px] text-gray-400 leading-snug">
                        {skippedLine}
                    </p>
                )}

                {season.mediterranean && (
                    <p data-testid="tc-coverage-note" className="text-[11px] text-amber-200/90 leading-snug">
                        Not covered: Mediterranean ‘medicanes’ (e.g. Ianos 2020, Daniel 2023) are not in IBTrACS, so a 0
                        here is not a measured zero.
                    </p>
                )}

                {/* Two rows of six (Jan–Jun, Jul–Dec): at the app's 12 px text floor a
                    3-digit count (a long NW Pacific route reaches 119 in August)
                    cannot fit a twelfth of a 320 px phone. */}
                <ol aria-label="Tropical cyclones near this route by month" className="grid grid-cols-6 gap-1">
                    {season.monthly.map((count, m) => {
                        const inSeason = season.inSeason[m];
                        const planned = plannedMonths.has(m);
                        const label = [
                            `${MONTH_NAMES[m]}: ${count} ${count === 1 ? 'storm' : 'storms'} in ${yearsLabel}`,
                            inSeason ? 'cyclone season' : null,
                            planned ? 'your passage' : null,
                        ]
                            .filter(Boolean)
                            .join(' · ');
                        return (
                            <li
                                key={m}
                                aria-label={label}
                                data-in-season={inSeason ? 'true' : 'false'}
                                data-planned={planned ? 'true' : 'false'}
                                className={`min-w-0 flex flex-col items-center gap-0.5 rounded-md border py-1 text-[11px] leading-none ${
                                    inSeason
                                        ? 'bg-amber-500/15 border-amber-500/30 text-amber-200'
                                        : 'bg-white/2 border-white/5 text-gray-500'
                                } ${planned ? 'ring-1 ring-sky-300/80 font-bold' : ''}`}
                            >
                                <span aria-hidden="true">{MONTH_NAMES[m].slice(0, 3)}</span>
                                <span aria-hidden="true" className="tabular-nums">
                                    {count}
                                </span>
                            </li>
                        );
                    })}
                </ol>

                <p className="text-[10px] text-gray-500 leading-snug">{caption}</p>
                <p className="text-[10px] text-gray-500 leading-snug">
                    Data: {clim.source} (International Best Track Archive for Climate Stewardship), accessed{' '}
                    {clim.accessed}.
                </p>
            </div>
        </section>
    );
};

export default SeasonRiskCard;
