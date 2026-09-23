import React, { useId, useMemo } from 'react';
import type { TideStationDetails } from '../../services/tides/stationDetails';
import { resolveTimeZone } from '../../utils/timezone';
import {
    stationWindDirection,
    tideGaugePresentation,
    tideHeightLabel,
    TIDE_CURVE_HEIGHT,
    TIDE_CURVE_WIDTH,
    type TideDisplayTrend,
} from './tideStationPresentation';
import './TideStationCard.css';

export interface TideStationCardProps {
    station: TideStationDetails['station'];
    detail: TideStationDetails | null;
    loading?: boolean;
    offline?: boolean;
    error?: boolean;
    nowMs?: number;
    onClose: () => void;
    onRetry?: () => void;
}

/** A relative-range water-level gauge, not a sounding or a depth gauge. */
export function TideStationGauge({
    fraction,
    trend,
    size = 68,
    label,
}: {
    fraction: number | null;
    trend: TideDisplayTrend;
    size?: number;
    label?: string;
}) {
    const filled =
        fraction === null || !Number.isFinite(fraction) ? 0 : Math.ceil(Math.max(0, Math.min(1, fraction)) * 6);
    return (
        <svg
            className="tide-station-gauge"
            viewBox="0 0 72 72"
            width={size}
            height={size}
            role={label ? 'img' : undefined}
            aria-label={label}
            aria-hidden={label ? undefined : true}
        >
            <rect className="tide-station-gauge__case" x="1" y="1" width="70" height="70" rx="9" />
            {Array.from({ length: 6 }, (_, i) => (
                <g key={i}>
                    <path className="tide-station-gauge__tick" d={`M7 ${14 + i * 9}h4`} />
                    <rect
                        className={i >= 6 - filled ? 'tide-station-gauge__filled' : 'tide-station-gauge__empty'}
                        x="15"
                        y={10 + i * 9}
                        width="24"
                        height="7"
                        rx="1.5"
                    />
                </g>
            ))}
            {trend === 'rising' || trend === 'falling' ? (
                <path
                    className="tide-station-gauge__arrow"
                    transform={trend === 'rising' ? 'rotate(180 54 36)' : undefined}
                    d="M54 20v31m-8-8 8 9 8-9"
                />
            ) : (
                <path
                    className="tide-station-gauge__unknown"
                    d={trend === 'steady' ? 'M47 36h14' : 'M49 31h10m-10 10h10'}
                />
            )}
        </svg>
    );
}

function stationZone(station: TideStationCardProps['station'], hint: string | null | undefined): string {
    if (hint) {
        try {
            new Intl.DateTimeFormat('en-AU', { timeZone: hint }).format();
            return hint;
        } catch {
            /* A provider's invalid zone must not silently become the device zone. */
        }
    }
    return resolveTimeZone(station.lat, station.lon);
}

function localTime(ms: number, zone: string, includeDay = false): string {
    return new Intl.DateTimeFormat('en-AU', {
        timeZone: zone,
        ...(includeDay ? { weekday: 'short' as const, day: 'numeric' as const, month: 'short' as const } : {}),
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(ms);
}

function zoneName(ms: number, zone: string): string {
    return (
        new Intl.DateTimeFormat('en-AU', { timeZone: zone, timeZoneName: 'short' })
            .formatToParts(ms)
            .find((part) => part.type === 'timeZoneName')?.value ?? zone
    );
}

const TREND_LABEL: Record<TideDisplayTrend, string> = {
    rising: 'Rising',
    falling: 'Falling',
    steady: 'Steady level',
    unknown: 'Trend unavailable',
};

export function TideStationCard({
    station,
    detail,
    loading = false,
    offline = false,
    error = false,
    nowMs = Date.now(),
    onClose,
    onRetry,
}: TideStationCardProps) {
    const titleId = useId();
    const gradientId = useId().replace(/:/g, '');
    const zone = useMemo(() => stationZone(station, detail?.timezone ?? station.timezone), [station, detail?.timezone]);
    const gauge = useMemo(() => tideGaugePresentation(detail?.heights ?? [], nowMs), [detail?.heights, nowMs]);
    const curve = gauge.curve;
    const extremes = (detail?.extremes ?? [])
        .filter((item) => Number.isFinite(item.timeMs) && item.timeMs >= nowMs && Number.isFinite(item.heightM))
        .slice()
        .sort((a, b) => a.timeMs - b.timeMs);
    const high = extremes.find((item) => item.type === 'High');
    const low = extremes.find((item) => item.type === 'Low');
    const datum = detail?.datum?.trim() || null;
    const datumLabel =
        datum === 'MSL' ? 'Mean sea level (MSL)' : datum === 'LAT' ? 'Lowest astronomical tide (LAT)' : datum;
    const wind = detail?.wind;
    const windDirection = wind ? stationWindDirection(wind.directionDeg) : null;
    const validWind =
        wind &&
        Number.isFinite(wind.speedKn) &&
        wind.speedKn >= 0 &&
        wind.speedKn <= 300 &&
        windDirection &&
        Number.isFinite(wind.validTimeMs) &&
        Math.abs(wind.validTimeMs - nowMs) <= 90 * 60_000;
    const differentStation = detail?.predictionStationName && detail.predictionStationName !== station.name;
    const differentLocation =
        detail?.predictionLocation &&
        (Math.abs(detail.predictionLocation.lat - station.lat) > 0.001 ||
            Math.abs(detail.predictionLocation.lon - station.lon) > 0.001);
    const hasData = !!detail && (detail.heights.length > 0 || detail.extremes.length > 0);

    return (
        <section className="tide-station-card" aria-labelledby={titleId} aria-busy={loading}>
            <header className="tide-station-card__header">
                <div>
                    <p className="tide-station-card__eyebrow">Tide station</p>
                    <h2 id={titleId}>{station.name}</h2>
                </div>
                <button
                    className="tide-station-card__close"
                    type="button"
                    aria-label="Close tide station"
                    onClick={onClose}
                >
                    ×
                </button>
            </header>

            <div className="tide-station-card__body">
                {loading && !hasData ? (
                    <p className="tide-station-card__status" role="status">
                        Loading tide predictions…
                    </p>
                ) : null}
                {offline ? (
                    <p className="tide-station-card__notice" role="status">
                        {hasData ? 'Offline · showing saved predictions' : 'Offline · tide predictions unavailable'}
                    </p>
                ) : null}
                {!loading && !hasData && !offline ? (
                    <p className="tide-station-card__status" role="status">
                        {error
                            ? 'Tide predictions could not be loaded.'
                            : 'No tide predictions available for this station.'}
                    </p>
                ) : null}
                {error && hasData ? (
                    <p className="tide-station-card__notice" role="status">
                        Refresh unavailable · showing saved predictions
                    </p>
                ) : null}
                {onRetry && !loading && (error || offline || !hasData) ? (
                    <button type="button" className="tide-station-card__retry" onClick={onRetry}>
                        Try again
                    </button>
                ) : null}

                <div className="tide-station-card__reading">
                    <TideStationGauge fraction={gauge.fraction} trend={gauge.trend} />
                    <div className="tide-station-card__value">
                        <p className="tide-station-card__eyebrow">Predicted now · {localTime(nowMs, zone)}</p>
                        <p className="tide-station-card__height">
                            <strong>{tideHeightLabel(gauge.heightM)}</strong>
                            <span>m</span>
                        </p>
                        <p className="tide-station-card__trend">
                            {gauge.heightM === null ? 'Current height unavailable' : TREND_LABEL[gauge.trend]}
                        </p>
                    </div>
                </div>
                <p className="tide-station-card__datum">
                    {datumLabel ? (
                        <>
                            Datum: <strong>{datumLabel}</strong>
                        </>
                    ) : (
                        'Vertical datum not supplied'
                    )}
                </p>
                <p className="tide-station-card__explain">
                    Predicted, not measured.
                    {gauge.heightM !== null
                        ? ' Height between samples is interpolated.'
                        : detail?.extremes.length
                          ? ' High/low events do not provide a current reading.'
                          : ''}
                </p>

                <div className="tide-station-card__events" aria-label="Next high and low water">
                    {[
                        { label: 'Next high water', short: 'HW', event: high },
                        { label: 'Next low water', short: 'LW', event: low },
                    ].map(({ label, short, event }) => (
                        <div className="tide-station-card__event" key={short}>
                            <p className="tide-station-card__eyebrow">{label}</p>
                            <p className="tide-station-card__event-height">
                                {event ? tideHeightLabel(event.heightM) : '—'} <span>m</span>
                            </p>
                            <p className="tide-station-card__event-time">
                                {event ? localTime(event.timeMs, zone, true) : 'Not available'}
                            </p>
                        </div>
                    ))}
                </div>

                {curve ? (
                    <figure className="tide-station-card__curve">
                        <figcaption>
                            <strong>Next 24 hours</strong>
                            <span>
                                {tideHeightLabel(curve.minM)}–{tideHeightLabel(curve.maxM)} m
                            </span>
                        </figcaption>
                        <svg
                            viewBox={`0 0 ${TIDE_CURVE_WIDTH} ${TIDE_CURVE_HEIGHT}`}
                            role="img"
                            aria-label={`24-hour predicted tide curve, from ${tideHeightLabel(curve.minM)} to ${tideHeightLabel(curve.maxM)} metres relative to ${datumLabel ?? 'an unspecified datum'}`}
                        >
                            <defs>
                                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="currentColor" stopOpacity="0.24" />
                                    <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
                                </linearGradient>
                            </defs>
                            <path className="tide-station-card__curve-grid" d="M8 14h284M8 58h284M8 102h284" />
                            <path d={curve.areaPath} fill={`url(#${gradientId})`} />
                            <path className="tide-station-card__curve-line" d={curve.linePath} />
                            <circle
                                className="tide-station-card__curve-now"
                                cx={curve.points[0].x}
                                cy={curve.points[0].y}
                                r="4"
                            />
                        </svg>
                        <div className="tide-station-card__curve-times">
                            <span>Now</span>
                            <span>+6h</span>
                            <span>+12h</span>
                            <span>+18h</span>
                            <span>+24h</span>
                        </div>
                        <p className="tide-station-card__explain">Gauge fill shows position within this 24h range.</p>
                    </figure>
                ) : (
                    <p className="tide-station-card__curve-empty">
                        24h curve unavailable · complete height samples required
                    </p>
                )}

                {validWind ? (
                    <div className="tide-station-card__wind">
                        <p className="tide-station-card__eyebrow">Forecast wind · station position</p>
                        <p className="tide-station-card__wind-reading">
                            <strong>
                                {wind.speedKn.toFixed(1)} <span>kn</span>
                            </strong>
                            <span>from {windDirection}</span>
                        </p>
                        <p className="tide-station-card__explain">
                            Valid {localTime(wind.validTimeMs, zone, true)} {zoneName(wind.validTimeMs, zone)} ·{' '}
                            {wind.model}
                        </p>
                        <p className="tide-station-card__explain">Not measured or vessel apparent wind.</p>
                    </div>
                ) : wind ? (
                    <p className="tide-station-card__curve-empty">Wind forecast does not cover this time.</p>
                ) : null}

                <footer className="tide-station-card__footer">
                    <p>Times at station · {zoneName(nowMs, zone)}</p>
                    {differentStation || differentLocation ? (
                        <p>
                            Prediction location: {detail?.predictionStationName || 'provider-selected station'}
                            {detail?.predictionLocation
                                ? ` · ${detail.predictionLocation.lat.toFixed(3)}, ${detail.predictionLocation.lon.toFixed(3)}`
                                : ''}
                        </p>
                    ) : null}
                    {detail ? (
                        <p>
                            {detail.source} predictions
                            {Number.isFinite(detail.fetchedAtMs)
                                ? ` · fetched ${localTime(detail.fetchedAtMs, zone, true)}`
                                : ''}
                        </p>
                    ) : null}
                    {detail?.copyright ? <p className="tide-station-card__copyright">{detail.copyright}</p> : null}
                    <p className="tide-station-card__safety">Tide height is not water depth or clearance.</p>
                </footer>
            </div>
        </section>
    );
}
