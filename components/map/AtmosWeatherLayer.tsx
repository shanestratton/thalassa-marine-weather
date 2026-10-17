import React, { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { ATMOS_DATASETS, type AtmosDataset } from '../../services/weather/api/atmosContract';
import { atmosDewpointSpread } from '../../services/weather/api/atmosSession';
import { sampleScalarGrid, type ScalarColourStop } from '../../services/weather/scalarGridImage';
import { useAtmosView } from './useAtmosView';
import { useScalarGridOverlay } from './useScalarGridOverlay';
import { usePressureSymbolOverlay } from './usePressureSymbolOverlay';
import type { AtmosCredit, AtmosPresentation } from './atmosPresentation';

const HOUR = 3_600_000;
const GUST: readonly ScalarColourStop[] = [
    [0, 0, 90, 120, 0],
    [5, 24, 180, 160, 80],
    [10, 70, 180, 240, 110],
    [15, 250, 200, 50, 130],
    [25, 245, 90, 40, 150],
    [40, 210, 40, 170, 170],
    [150, 150, 20, 170, 180],
];
const VISIBILITY: readonly ScalarColourStop[] = [
    [0, 180, 70, 190, 180],
    [500, 170, 100, 200, 160],
    [1000, 130, 150, 220, 140],
    [5000, 100, 190, 220, 80],
    [10000, 100, 190, 220, 0],
    [300000, 100, 190, 220, 0],
];
const PRESSURE: readonly ScalarColourStop[] = [
    [75000, 110, 30, 180, 110],
    [98000, 100, 80, 210, 95],
    [100000, 80, 170, 230, 70],
    [101300, 170, 210, 220, 15],
    [103000, 210, 225, 230, 60],
    [115000, 250, 240, 220, 100],
];
const utc = (ms: number | null) =>
    ms !== null && Number.isFinite(ms)
        ? `${new Date(ms).toISOString().slice(5, 16).replace('T', ' ')} UTC`
        : 'UTC unknown';

interface Props {
    mapRef: MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    gust: boolean;
    visibility: boolean;
    pressure: boolean;
    pressureModel: string;
    /** null means independent; an active wind with an unknown clock uses NaN, never now. */
    followWindMs: number | null;
    standalonePressure: boolean;
    point?: { lat: number; lon: number } | null;
    onPresentation: (presentation: AtmosPresentation) => void;
}

/** A flag-gated lazy owner: selected frame only, never a precomputed week of images. */
export default function AtmosWeatherLayer({
    mapRef,
    mapReady,
    gust,
    visibility,
    pressure,
    pressureModel,
    followWindMs,
    standalonePressure,
    point,
    onPresentation,
}: Props) {
    const [now, setNow] = useState(() => Math.floor(Date.now() / 60_000) * 60_000);
    const [manualMs, setManualMs] = useState<number | null>(null);
    const [retry, setRetry] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [details, setDetails] = useState(false);
    const pressureDataset: AtmosDataset | null = pressure
        ? pressureModel === 'gfs'
            ? 'gfs-atmos'
            : pressureModel === 'ecmwf'
              ? 'ifs-pressure'
              : null
        : null;
    const validMs = followWindMs !== null ? (Number.isFinite(followWindMs) ? followWindMs : null) : (manualMs ?? now);
    const gfsNeeded = gust || visibility || pressureDataset === 'gfs-atmos';
    const gfs = useAtmosView(gfsNeeded ? 'gfs-atmos' : null, validMs, retry);
    const ifs = useAtmosView(pressureDataset === 'ifs-pressure' ? 'ifs-pressure' : null, validMs, retry);
    const pressureRead = pressureDataset === 'ifs-pressure' ? ifs : gfs;
    const pressureView = pressureDataset ? pressureRead.view : null;
    const gfsCredit = ATMOS_DATASETS['gfs-atmos'].attribution;
    const pressureCredit = pressureDataset
        ? ATMOS_DATASETS[pressureDataset].attribution
        : 'Selected-model pressure unavailable';
    const gustStatus = useScalarGridOverlay(mapRef, mapReady, {
        id: 'atmos-gust',
        label: 'GFS gusts',
        credit: gfsCredit,
        enabled: gust,
        grid: gust ? (gfs.view?.fields.gust ?? null) : null,
        stops: GUST,
        revision: `${gfs.view?.generation}:${validMs}:gust`,
        sourceCurrent: () => !!gfs.view?.isCurrent(),
    });
    const visibilityStatus = useScalarGridOverlay(mapRef, mapReady, {
        id: 'atmos-visibility',
        label: 'GFS model visibility',
        credit: gfsCredit,
        enabled: visibility,
        grid: visibility ? (gfs.view?.fields.visibility ?? null) : null,
        stops: VISIBILITY,
        revision: `${gfs.view?.generation}:${validMs}:visibility`,
        sourceCurrent: () => !!gfs.view?.isCurrent(),
    });
    const pressureImageStatus = useScalarGridOverlay(mapRef, mapReady, {
        id: 'atmos-pressure',
        label: 'Model pressure wash',
        credit: pressureCredit,
        enabled: pressure && standalonePressure,
        grid: pressure && standalonePressure ? (pressureView?.fields.pressure ?? null) : null,
        stops: PRESSURE,
        revision: `${pressureView?.generation}:${validMs}:pressure`,
        sourceCurrent: () => !!pressureView?.isCurrent(),
    });
    const pressureLineStatus = usePressureSymbolOverlay(mapRef, mapReady, pressure, pressureView, pressureCredit);
    const stuck = [gustStatus, visibilityStatus, pressureImageStatus, pressureLineStatus].includes('stuck-visible');
    const active = gust || visibility || pressure || stuck;

    useEffect(() => {
        const timer = setInterval(() => setNow(Math.floor(Date.now() / 60_000) * 60_000), 60_000);
        return () => clearInterval(timer);
    }, []);
    useEffect(() => {
        if (!active || followWindMs !== null) setPlaying(false);
        if (!active) {
            setManualMs(null);
            setDetails(false);
        }
    }, [active, followWindMs]);
    const sources = [gfsNeeded ? gfs.session : null, pressureDataset === 'ifs-pressure' ? ifs.session : null].filter(
        (session) => session !== null,
    );
    const start = sources.length ? Math.max(...sources.map((session) => session.manifest.runMs)) : null;
    const end = sources.length
        ? Math.min(...sources.map((session) => session.manifest.runMs + (session.manifest.files.length - 1) * 6 * HOUR))
        : null;
    const max = start !== null && end !== null && end >= start ? Math.floor((end - start) / HOUR) : 0;
    const position = start !== null && validMs !== null ? (validMs - start) / HOUR : null;
    const ready =
        (!gust || gustStatus === 'ready') &&
        (!visibility || visibilityStatus === 'ready') &&
        (!pressure || (pressureLineStatus === 'ready' && (!standalonePressure || pressureImageStatus === 'ready')));
    const loading =
        gfs.loading ||
        ifs.loading ||
        [gustStatus, visibilityStatus, pressureImageStatus, pressureLineStatus].includes('loading');
    useEffect(() => {
        if (
            !playing ||
            !ready ||
            loading ||
            followWindMs !== null ||
            start === null ||
            end === null ||
            validMs === null
        )
            return;
        const timer = setTimeout(() => {
            const next = validMs + HOUR;
            if (next > end) {
                setPlaying(false);
                return;
            }
            setManualMs(next);
        }, 750);
        return () => clearTimeout(timer);
    }, [playing, ready, loading, followWindMs, start, end, validMs]);

    const pointLat = point?.lat,
        pointLon = point?.lon;
    const pointGust =
        point && gfs.view?.fields.gust ? sampleScalarGrid(gfs.view.fields.gust, point.lon, point.lat) : null;
    const pointVisibility =
        point && gfs.view?.fields.visibility
            ? sampleScalarGrid(gfs.view.fields.visibility, point.lon, point.lat)
            : null;
    const spread = point && gfs.view ? atmosDewpointSpread(gfs.view, point.lon, point.lat) : null;
    const credits = useMemo(() => {
        const rows: AtmosCredit[] = [];
        if (gfsNeeded || gustStatus === 'stuck-visible' || visibilityStatus === 'stuck-visible')
            rows.push({
                key: 'gfs-atmos',
                title: 'GFS atmospheric fields',
                warning: !ready || !!gfs.error,
                text: `${gfsCredit}. ${ATMOS_DATASETS['gfs-atmos'].licence}. Model forecast; 1° display sampling. Run ${utc(gfs.view?.runMs ?? gfs.session?.manifest.runMs ?? null)}; valid ${utc(validMs)}. ${visibility ? 'Model visibility, low skill; T−Td is a point saturation proxy, not a fog forecast.' : ''} ${gfs.error ?? ''}`,
            });
        if (pressureDataset === 'ifs-pressure')
            rows.push({
                key: 'ifs-pressure',
                title: 'ECMWF IFS mean sea-level pressure',
                warning: !ready || !!ifs.error,
                text: `${ATMOS_DATASETS['ifs-pressure'].attribution}. ${ATMOS_DATASETS['ifs-pressure'].licence}. Public 0.25° source sampled to 1°; up to ten days from eligible 00/12 UTC runs. Run ${utc(ifs.view?.runMs ?? ifs.session?.manifest.runMs ?? null)}; valid ${utc(validMs)}. ${ifs.error ?? ''}`,
            });
        if (pressure && !pressureDataset)
            rows.push({
                key: 'pressure-unavailable',
                title: 'Selected-model pressure held',
                warning: true,
                text: `${pressureModel.toUpperCase()} has no verified long-range pressure cohort. No other model has been substituted.`,
            });
        if (stuck)
            rows.push({
                key: 'atmos-retirement',
                title: 'Atmospheric layer may still be visible',
                warning: true,
                text: `Removal or hiding could not be proven. Do not rely on the retained layer. Possible pressure source credit: ${ATMOS_DATASETS['gfs-atmos'].attribution}; ${ATMOS_DATASETS['ifs-pressure'].attribution}, CC-BY-4.0 / ECMWF Terms of Use. Retry after the chart style settles.`,
            });
        return rows;
    }, [
        gfsNeeded,
        gustStatus,
        visibilityStatus,
        ready,
        gfs.error,
        gfsCredit,
        gfs.view,
        gfs.session,
        validMs,
        visibility,
        pressureDataset,
        ifs.error,
        ifs.view,
        ifs.session,
        pressure,
        pressureModel,
        stuck,
    ]);
    const legend = useMemo(
        () =>
            active ? (
                <section
                    aria-label="Atmospheric model controls"
                    className="min-w-0 space-y-2 rounded-xl border border-white/10 p-2 text-xs"
                >
                    <div className="flex min-w-0 items-center gap-2">
                        <strong className="min-w-0 flex-1 break-words">
                            {gust ? 'GFS gusts' : ''}
                            {gust && visibility ? ' · ' : ''}
                            {visibility ? 'Model visibility · low skill' : ''}
                            {pressure
                                ? `${gust || visibility ? ' · ' : ''}${pressureModel === 'ecmwf' ? 'Public IFS' : pressureModel.toUpperCase()} pressure`
                                : ''}
                        </strong>
                        <button
                            type="button"
                            className="min-h-11 min-w-11 shrink-0 rounded-lg border border-white/15 px-2"
                            aria-expanded={details}
                            onClick={() => setDetails((value) => !value)}
                        >
                            Info
                        </button>
                    </div>
                    <p role="status" className={stuck || (!ready && !loading) ? 'text-amber-200' : 'text-slate-300'}>
                        {stuck
                            ? 'Removal uncertain; layer may remain visible'
                            : loading
                              ? `Loading ${utc(validMs)}`
                              : ready
                                ? `Model forecast · ${utc(validMs)}`
                                : [
                                      pressure && !pressureDataset
                                          ? `${pressureModel.toUpperCase()} long-range pressure unavailable`
                                          : null,
                                      gfs.error,
                                      ifs.error,
                                  ]
                                      .filter(Boolean)
                                      .join(' · ') || 'Atmospheric field unavailable'}
                    </p>
                    {gust && (
                        <p aria-label="Gust colour scale" className="text-slate-400">
                            Gusts: cyan 10 · blue 20 · amber 30 · red 50 · purple 80+ kt
                        </p>
                    )}
                    {visibility && (
                        <p aria-label="Visibility colour scale" className="text-slate-400">
                            Visibility: purple &lt;1 km · blue 1–5 km · faint 5–10 km. Transparent: ≥10 km or unknown.
                        </p>
                    )}
                    {pressure && <p className="text-slate-400">Mean sea-level pressure lines: hPa.</p>}
                    {followWindMs !== null ? (
                        <p className="text-slate-400">Follows the wind valid UTC where each source has coverage.</p>
                    ) : max > 0 && start !== null ? (
                        <>
                            <label className="block">
                                Forecast UTC{' '}
                                <span className="text-slate-400">
                                    {utc(start)} to {utc(end)}
                                </span>
                                <input
                                    type="range"
                                    aria-label="Atmospheric forecast time"
                                    className="mt-1 block h-11 w-full min-w-0"
                                    min={0}
                                    max={max}
                                    step={1}
                                    value={position !== null && position >= 0 && position <= max ? position : 0}
                                    onChange={(event) => {
                                        setPlaying(false);
                                        setManualMs(start + Number(event.target.value) * HOUR);
                                    }}
                                />
                            </label>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    className="min-h-11 min-w-11 rounded-lg border border-white/15 px-3"
                                    disabled={!ready}
                                    aria-pressed={playing}
                                    onClick={() => setPlaying((value) => !value)}
                                >
                                    {playing ? 'Pause' : 'Play'}
                                </button>
                                <button
                                    type="button"
                                    className="min-h-11 rounded-lg border border-white/15 px-3"
                                    onClick={() => {
                                        setPlaying(false);
                                        setManualMs(null);
                                    }}
                                >
                                    Now
                                </button>
                            </div>
                        </>
                    ) : null}
                    {pointLat !== undefined && pointLon !== undefined && (gust || visibility) && (
                        <p className="text-slate-300">
                            Weather point {pointLat.toFixed(2)}°, {pointLon.toFixed(2)}°:{' '}
                            {gust
                                ? `gust ${pointGust === null ? 'unknown' : `${(pointGust * 1.943844).toFixed(0)} kt`}`
                                : ''}
                            {gust && visibility ? '; ' : ''}
                            {visibility
                                ? `visibility ${pointVisibility === null ? 'unknown' : `${(pointVisibility / 1852).toFixed(1)} NM`}; T−Td ${spread === null ? 'unknown' : `${spread.toFixed(1)}°C`}`
                                : ''}
                        </p>
                    )}
                    {!ready && !loading && (
                        <button
                            type="button"
                            className="min-h-11 rounded-lg border border-white/15 px-3"
                            onClick={() => {
                                setPlaying(false);
                                setRetry((value) => value + 1);
                            }}
                        >
                            Retry atmospheric source
                        </button>
                    )}
                    {details && (
                        <div className="space-y-2 break-words text-slate-400">
                            {credits.map((row) => (
                                <p key={row.key}>{row.text}</p>
                            ))}
                            <p>
                                Missing cells remain unknown. Gusts and visibility are model estimates. Low T−Td
                                indicates near-saturation at this point; it is not proof of fog, clear visibility or
                                safe passage. Pressure symbols do not imply measured winds or movement tracks.
                            </p>
                        </div>
                    )}
                </section>
            ) : null,
        [
            active,
            gust,
            visibility,
            pressure,
            pressureModel,
            details,
            stuck,
            ready,
            loading,
            validMs,
            pressureDataset,
            gfs.error,
            ifs.error,
            followWindMs,
            max,
            start,
            end,
            position,
            playing,
            pointLat,
            pointLon,
            pointGust,
            pointVisibility,
            spread,
            credits,
        ],
    );
    const callback = useRef(onPresentation);
    callback.current = onPresentation;
    useEffect(() => {
        callback.current({ legend, credits });
    }, [legend, credits]);
    useEffect(() => () => callback.current({ legend: null, credits: [] }), []);
    return null;
}
