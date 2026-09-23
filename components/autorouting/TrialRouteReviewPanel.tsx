import React, { useMemo } from 'react';
import type { AutoroutingTrialRoute } from '../../types/autorouting';
import {
    isTrialTrackAdvisory,
    trialChartTrackAdvisories,
    trialDisplayWaypointGrade,
    TRIAL_GRADE_COLORS,
    type TrialRouteReview,
} from '../../services/autoroutingReview';
import type { TracePoint } from '../../services/routeTracer';
import type { AutoroutingProviderFinding } from '../../types/autorouting';
import { providerHazardViewport } from '../../services/providerHazardGeometry';
import { formatLatDegMin, formatLonDegMin } from '../../utils/formatDegMin';
import {
    buildTrialWaypointPlan,
    displayWaypointForPathIndex,
    displayWaypointLegRange,
    type TrialDisplayWaypoint,
} from '../../services/autoroutingDisplayWaypoints';
import './TrialRouteReviewPanel.css';

const PAGE_SIZE = 20;
const control = 'min-h-11 rounded-lg border border-white/15 px-3 text-micro font-bold disabled:opacity-40';
export function TrialRouteReviewPanel({
    coordinates,
    waypoints: suppliedWaypoints,
    sparse: suppliedSparse,
    route,
    review,
    selected,
    onSelect,
    onFocus,
    onInspectWaypoint,
    onLocateProvider,
    onStop,
    onRecheck,
}: {
    coordinates: AutoroutingTrialRoute['coordinates'];
    waypoints?: TrialDisplayWaypoint[];
    sparse?: boolean;
    route?: AutoroutingTrialRoute;
    review: TrialRouteReview | null;
    selected: number;
    onSelect: (index: number) => void;
    onFocus: (point: TracePoint) => void;
    onInspectWaypoint?: (index: number) => void;
    onLocateProvider?: (finding: AutoroutingProviderFinding) => void;
    onStop: () => void;
    onRecheck: () => void;
}) {
    // Waypoints are a presentation plan only. The route and every original
    // segment verdict remain untouched, including at fractional spacing points.
    const handoverIndex = route?.canalDeparture?.handoverIndex;
    // A move invalidates the report, not the existence of its hazards. Keep
    // the original findings visible, explicitly historical, beside new checks.
    const providerReport = route?.localEdit?.originalProposal.providerCheck ?? route?.providerCheck;
    const providerDangers = providerReport?.findings.filter((finding) => finding.severity === 'danger') ?? [];
    const providerAdvisories = providerReport?.findings.filter((finding) => finding.severity !== 'danger') ?? [];
    const waypointPlan = useMemo(
        () =>
            suppliedWaypoints
                ? { waypoints: suppliedWaypoints, sparse: suppliedSparse ?? true }
                : buildTrialWaypointPlan(coordinates, handoverIndex == null ? [] : [handoverIndex]),
        [suppliedWaypoints, suppliedSparse, coordinates, handoverIndex],
    );
    const { waypoints, sparse } = waypointPlan;
    const legRanges = useMemo(
        () => waypoints.map((_, index) => displayWaypointLegRange(waypoints, index)),
        [waypoints],
    );
    const trackAdvisories = useMemo(() => trialChartTrackAdvisories(review), [review]);
    const trackLocations = useMemo(() => {
        const bySegment = new Map<number, Array<{ id: string; number: number; spot: TracePoint }>>();
        trackAdvisories.forEach((advisory, index) => {
            advisory.legs.forEach((location) => {
                const entries = bySegment.get(location.index) ?? [];
                entries.push({ id: advisory.id, number: index + 1, spot: location.spot });
                bySegment.set(location.index, entries);
            });
        });
        return bySegment;
    }, [trackAdvisories]);
    const first = Math.floor(Math.max(0, Math.min(selected, waypoints.length - 1)) / PAGE_SIZE) * PAGE_SIZE;
    const segmentCount = Math.max(0, coordinates.length - 1);
    const originalLegs = review?.legs.slice(0, segmentCount) ?? [];
    const done = originalLegs.filter(Boolean).length;
    const danger = originalLegs.filter((l) => l?.verdict.grade === 'danger').length;
    const caution = originalLegs.filter((l) => l?.verdict.grade === 'caution').length;
    const incomplete = segmentCount - originalLegs.filter((l) => l && !l.incomplete).length;
    const checking = !review || review.phase === 'checking';
    const status = checking
        ? `Checking ${done}/${segmentCount} detailed route segments…`
        : review.phase === 'stale'
          ? 'Charts changed — recheck this proposal.'
          : review.phase === 'error'
            ? 'Chart checks failed — route remains unchecked.'
            : review.phase === 'stopped'
              ? `Checks stopped at ${done}/${segmentCount} detailed route segments.`
              : `${danger} danger · ${caution} caution · ${incomplete} incomplete · ${done}/${segmentCount} checked segments`;
    const providerFinding = (finding: AutoroutingProviderFinding, index: number) => (
        <li
            key={`${finding.featureIndex}-${index}`}
            className="trial-provider-finding"
            data-severity={finding.severity}
            style={{
                color: finding.severity === 'danger' ? TRIAL_GRADE_COLORS.danger : TRIAL_GRADE_COLORS.caution,
            }}
        >
            {onLocateProvider && providerHazardViewport(finding) ? (
                <button
                    type="button"
                    className="min-h-11 w-full text-left underline decoration-dotted"
                    aria-label={`Locate provider finding ${finding.featureIndex + 1}`}
                    onClick={() => onLocateProvider(finding)}
                >
                    {finding.message} ↗
                </button>
            ) : (
                <p>{finding.message}</p>
            )}
            {finding.provenance && (
                <details className="trial-review-disclosure mt-1 text-gray-300">
                    <summary>Provider details · source feature {finding.featureIndex + 1}</summary>
                    <dl className="space-y-1 break-words">
                        {Object.entries(finding.provenance.properties).map(([key, value]) => (
                            <div key={key}>
                                <dt className="font-semibold">{key}</dt>
                                <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                            </div>
                        ))}
                    </dl>
                    {finding.provenance.omittedPropertyCount > 0 && (
                        <p>
                            {finding.provenance.omittedPropertyCount} additional source properties are retained only in
                            the original provider report.
                        </p>
                    )}
                </details>
            )}
        </li>
    );
    return (
        <section aria-label="Route chart checks" className="trial-review-panel space-y-2">
            {route && (
                <section
                    aria-label="SevenCs provider report"
                    data-severity={providerReport?.status === 'unsafe' ? 'danger' : 'caution'}
                    role={providerReport?.status === 'unsafe' ? 'alert' : undefined}
                    className="trial-provider-report rounded-lg border p-2 space-y-1 text-micro"
                    style={{
                        borderColor:
                            providerReport?.status === 'unsafe'
                                ? TRIAL_GRADE_COLORS.danger
                                : TRIAL_GRADE_COLORS.caution,
                        color:
                            providerReport?.status === 'unsafe'
                                ? TRIAL_GRADE_COLORS.danger
                                : TRIAL_GRADE_COLORS.caution,
                    }}
                >
                    <h3 className="font-bold">
                        {route.localEdit
                            ? 'Original SevenCs report · before waypoint edits'
                            : providerReport?.status === 'unsafe'
                              ? 'SevenCs reported an unsafe proposal'
                              : providerReport?.status === 'caution'
                                ? 'SevenCs reported cautions'
                                : 'Provider clearance is not established'}
                    </h3>
                    {route.localEdit && (
                        <p className="font-semibold">
                            Original provider status: {providerReport?.status ?? 'not reported'} · historical only.
                        </p>
                    )}
                    <p>
                        {route.localEdit
                            ? 'This report does not check the edited route. Original findings remain below for review. '
                            : ''}
                        {providerReport?.status === 'unsafe' ? 'Do not use this proposal for navigation. ' : ''}
                        Local chart checks below do not override provider findings or establish route safety.
                        {route.canalDeparture
                            ? ' The provider report covers the SevenCs section only, not the local canal.'
                            : ''}
                    </p>
                    {providerDangers.length > 0 && (
                        <ul className="space-y-1" aria-label="Provider dangers">
                            {providerDangers.map(providerFinding)}
                        </ul>
                    )}
                    {providerAdvisories.length > 0 && (
                        <details className="trial-review-disclosure">
                            <summary>
                                {providerAdvisories.length} provider{' '}
                                {providerAdvisories.length === 1 ? 'advisory' : 'advisories'} · inspect findings
                            </summary>
                            <ul className="space-y-1" aria-label="Provider advisories">
                                {providerAdvisories.map(providerFinding)}
                            </ul>
                        </details>
                    )}
                </section>
            )}
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold">Waypoints & local chart checks</h3>
                <button type="button" className={control} onClick={checking ? onStop : onRecheck}>
                    {checking ? 'Stop checks' : 'Recheck charts'}
                </button>
            </div>
            <p role="status" className="text-micro font-semibold text-amber-300">
                {status}
            </p>
            <p className="text-micro text-gray-300">
                Local checks only · depth at LAT · {waypoints.length} waypoints · {coordinates.length} detailed route
                points · no tide credited.
            </p>
            <details className="trial-review-disclosure text-micro text-gray-300">
                <summary>What the colours mean</summary>
                <p>Green: no local issue found · amber: check · red: local danger · grey: unchecked.</p>
            </details>
            {sparse ? (
                <p className="text-micro text-gray-300">
                    Corners + every 50 NM. The full route is kept for chart checks and saving.
                </p>
            ) : (
                <p role="alert" className="text-micro text-amber-300">
                    Waypoint summary unavailable for this geometry. Showing all original route points for inspection.
                </p>
            )}
            {trackAdvisories.length > 0 && (
                <section
                    aria-label="Chart track advisories"
                    className="space-y-1 rounded-lg border border-amber-300/20 p-2"
                >
                    <h4 className="text-micro font-bold text-amber-300">Chart track advisories</h4>
                    <ol className="space-y-2">
                        {trackAdvisories.map((advisory, index) => {
                            const label =
                                advisory.label ||
                                (advisory.kind === 'leading-line'
                                    ? 'Unnamed leading line'
                                    : 'Unnamed recommended track');
                            const ranges = advisory.legRanges
                                .map(({ first, last }) =>
                                    first === last ? `${first + 1}` : `${first + 1}–${last + 1}`,
                                )
                                .join(', ');
                            return (
                                <li key={advisory.id}>
                                    <button
                                        type="button"
                                        className="min-h-11 w-full text-left text-micro text-amber-300"
                                        aria-label={`Locate track ${index + 1}: ${label}`}
                                        onClick={() => {
                                            onSelect(displayWaypointForPathIndex(waypoints, advisory.worst.index + 1));
                                            onFocus(advisory.worst.spot);
                                        }}
                                    >
                                        <span className="block font-bold underline decoration-dotted">
                                            Track {index + 1} · {label} ↗
                                        </span>
                                        <span className="block">
                                            Up to {Math.round(advisory.maxOffsetM)} m from charted track — review
                                            alignment.
                                        </span>
                                        <span className="block text-gray-300">
                                            Detailed route {advisory.legs.length === 1 ? 'segment' : 'segments'}{' '}
                                            {ranges}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ol>
                </section>
            )}
            <details open>
                <summary className="min-h-11 cursor-pointer content-center text-micro font-bold">
                    Inspect waypoints
                </summary>
                <ol className="trial-review-waypoints space-y-1" start={first + 1} aria-label="Proposal waypoints">
                    {waypoints.slice(first, first + PAGE_SIZE).map((waypoint, offset) => {
                        const [lon, lat] = waypoint.coordinates;
                        const index = first + offset;
                        const range = legRanges[index];
                        const segments = range
                            ? Array.from({ length: range.last - range.first + 1 }, (_, n) => ({
                                  index: range.first + n,
                                  leg: review?.legs[range.first + n],
                              }))
                            : [];
                        const hasUnchecked =
                            !range ||
                            review?.phase === 'stale' ||
                            review?.phase === 'error' ||
                            segments.some(({ leg }) => !leg || leg.incomplete || leg.verdict.minDepthM == null);
                        const grade = trialDisplayWaypointGrade(review, range);
                        const knownDepths = segments.flatMap(({ leg }) =>
                            leg?.verdict.minDepthM != null && Number.isFinite(leg.verdict.minDepthM)
                                ? [leg.verdict.minDepthM]
                                : [],
                        );
                        const minDepthM = knownDepths.length ? Math.min(...knownDepths) : null;
                        const color = TRIAL_GRADE_COLORS[grade];
                        const advisoryCount = segments.reduce(
                            (count, { index: segmentIndex, leg }) =>
                                count +
                                (leg?.verdict.issues.filter(
                                    (issue) => issue.severity !== 'danger' && !isTrialTrackAdvisory(issue),
                                ).length ?? 0) +
                                (trackLocations.get(segmentIndex)?.length ?? 0) +
                                (leg?.verdict.nudge ? 1 : 0),
                            0,
                        );
                        return (
                            <li
                                key={index}
                                data-grade={grade}
                                data-selected={selected === index}
                                className={`trial-review-waypoint rounded-lg border p-2 ${selected === index ? 'border-sky-400' : 'border-white/10'}`}
                            >
                                <button
                                    type="button"
                                    className="trial-review-waypoint-button min-h-11 w-full text-left text-micro"
                                    aria-label={onInspectWaypoint ? `Select waypoint ${index + 1}` : undefined}
                                    onClick={() => {
                                        onSelect(index);
                                        onFocus({ lat, lon });
                                        onInspectWaypoint?.(index);
                                    }}
                                >
                                    <span className="min-w-0">
                                        <span className="trial-review-waypoint-number font-bold" style={{ color }}>
                                            ● {index + 1}
                                            {index === 0
                                                ? ' · Departure'
                                                : index === waypoints.length - 1
                                                  ? ' · Destination'
                                                  : waypoint.kind === 'handover'
                                                    ? ' · Canal exit'
                                                    : ''}
                                        </span>
                                        <span className="block font-mono">
                                            {formatLatDegMin(lat)} {formatLonDegMin(lon)}
                                        </span>
                                    </span>
                                    {onInspectWaypoint && (
                                        <span aria-hidden="true" className="trial-review-row-arrow">
                                            ›
                                        </span>
                                    )}
                                </button>
                                {index > 0 && (
                                    <p className="trial-review-leg text-micro text-gray-200">
                                        Leg {index}→{index + 1}: {grade === 'clear' ? 'no issue found' : grade}
                                        {minDepthM != null
                                            ? ` · ${minDepthM.toFixed(1)} m least${knownDepths.length < segments.length ? ' known' : ''}`
                                            : ' · depth not established'}
                                        {hasUnchecked && grade !== 'unchecked' ? ' · checks incomplete' : ''}
                                    </p>
                                )}
                                {segments.map(({ index: segmentIndex, leg }) => {
                                    const verdict = leg?.verdict;
                                    const dangers =
                                        verdict?.issues.filter((issue) => issue.severity === 'danger') ?? [];
                                    if (!dangers.length && !verdict?.needsTide) return null;
                                    return (
                                        <div key={segmentIndex} className="trial-review-urgent">
                                            {segments.length > 1 && (
                                                <h4 className="text-micro font-semibold text-gray-300">
                                                    Segment {segmentIndex + 1}
                                                </h4>
                                            )}
                                            {dangers.map((issue, n) => {
                                                const spot = issue.mark ?? issue.at;
                                                return spot ? (
                                                    <button
                                                        key={n}
                                                        type="button"
                                                        className="block min-h-11 text-left text-micro underline decoration-dotted"
                                                        data-severity="danger"
                                                        style={{ color: TRIAL_GRADE_COLORS.danger }}
                                                        onClick={() => {
                                                            onSelect(index);
                                                            onFocus(spot);
                                                        }}
                                                    >
                                                        {issue.message} ↗
                                                    </button>
                                                ) : (
                                                    <p
                                                        key={n}
                                                        className="text-micro"
                                                        data-severity="danger"
                                                        style={{ color: TRIAL_GRADE_COLORS.danger }}
                                                    >
                                                        {issue.message}
                                                    </p>
                                                );
                                            })}
                                            {verdict?.needsTide && (
                                                <p className="text-micro text-amber-300">
                                                    Needs tide — no tidal clearance or departure window established.
                                                </p>
                                            )}
                                        </div>
                                    );
                                })}
                                {(advisoryCount > 0 || (range && segments.length > 1)) && (
                                    <details className="trial-review-disclosure trial-review-waypoint-details">
                                        <summary>
                                            {advisoryCount > 0
                                                ? `${advisoryCount} ${advisoryCount === 1 ? 'advisory' : 'advisories'} · details`
                                                : 'Detailed segment checks'}
                                        </summary>
                                        {range && segments.length > 1 && (
                                            <p className="text-micro text-gray-300">
                                                Full-route checks · segments {range.first + 1}–{range.last + 1}
                                            </p>
                                        )}
                                        {segments.map(({ index: segmentIndex, leg }) => {
                                            const verdict = leg?.verdict;
                                            if (!verdict?.issues.length && !verdict?.needsTide && !verdict?.nudge)
                                                return null;
                                            return (
                                                <div
                                                    key={segmentIndex}
                                                    aria-label={`Detailed route segment ${segmentIndex + 1}`}
                                                >
                                                    {segments.length > 1 && (
                                                        <h4 className="mt-2 text-micro font-semibold text-gray-300">
                                                            Segment {segmentIndex + 1}
                                                        </h4>
                                                    )}
                                                    {verdict.issues.map((issue, n) => {
                                                        if (isTrialTrackAdvisory(issue) || issue.severity === 'danger')
                                                            return null;
                                                        const spot = issue.mark ?? issue.at;
                                                        const issueColor =
                                                            TRIAL_GRADE_COLORS[
                                                                issue.severity === 'info' ? 'clear' : 'caution'
                                                            ];
                                                        return spot ? (
                                                            <button
                                                                key={n}
                                                                type="button"
                                                                className="block min-h-11 text-left text-micro underline decoration-dotted"
                                                                data-severity={issue.severity}
                                                                style={{ color: issueColor }}
                                                                onClick={() => {
                                                                    onSelect(index);
                                                                    onFocus(spot);
                                                                }}
                                                            >
                                                                {issue.message} ↗
                                                            </button>
                                                        ) : (
                                                            <p
                                                                key={n}
                                                                className="text-micro"
                                                                data-severity={issue.severity}
                                                                style={{ color: issueColor }}
                                                            >
                                                                {issue.message}
                                                            </p>
                                                        );
                                                    })}
                                                    {trackLocations.get(segmentIndex)?.map((location) => (
                                                        <button
                                                            key={location.id}
                                                            type="button"
                                                            className="block min-h-11 text-left text-micro text-amber-300 underline decoration-dotted"
                                                            aria-label={`Locate track ${location.number} near segment ${segmentIndex + 1}`}
                                                            onClick={() => {
                                                                onSelect(index);
                                                                onFocus(location.spot);
                                                            }}
                                                        >
                                                            Track advisory {location.number} ↗
                                                        </button>
                                                    ))}
                                                    {verdict.nudge && (
                                                        <p className="text-micro text-gray-300">{verdict.nudge}</p>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </details>
                                )}
                            </li>
                        );
                    })}
                </ol>
                {waypoints.length > PAGE_SIZE && (
                    <div className="flex items-center justify-between gap-2 pt-2">
                        <button
                            type="button"
                            className={control}
                            disabled={first === 0}
                            onClick={() => onSelect(first - PAGE_SIZE)}
                        >
                            Previous
                        </button>
                        <span className="text-micro">
                            {first + 1}–{Math.min(first + PAGE_SIZE, waypoints.length)} / {waypoints.length}
                        </span>
                        <button
                            type="button"
                            className={control}
                            disabled={first + PAGE_SIZE >= waypoints.length}
                            onClick={() => onSelect(first + PAGE_SIZE)}
                        >
                            Next
                        </button>
                    </div>
                )}
            </details>
        </section>
    );
}
