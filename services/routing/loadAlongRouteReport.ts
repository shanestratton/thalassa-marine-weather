/** The one explicit, 30-second route-reference operation. Licensed geometry
 * stays in a synchronous leased chart reader; only RAM primitives leave it. */
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from '../authIdentityScope';
import { getVersion, subscribe as subscribeCharts } from '../enc/EncCellMetadata';
import { readAlongRouteBridges } from '../enc/readAlongRouteBridges';
import { loadMarineCells } from '../marineCatalogue/service';
import { catalogueCacheEpoch } from '../marineCatalogue/cache';
import { LICENCES } from '../marineCatalogue/schema';
import { satelliteModeActive } from '../networkPolicy';
import { emptyRouteWeather, type RouteClock } from '../routeMeteogram';
import { loadRouteMeteogram } from '../routeMeteogramWeather';
import { useSettingsStore } from '../../stores/settingsStore';
import { WindStore } from '../../stores/WindStore';
import { publishAlongRouteReport } from '../../stores/alongRouteReportStore';
import { isochroneRoutingContext } from './isochronePolicy';
import { prepareAlongRoute, projectAlongPlaces, publicAlongPlace, type AlongPlace } from './alongRoutePlaces';
import type { AlongRouteReport, AlongRouteSource } from './alongRouteReportTypes';

export const ALONG_ROUTE_DEADLINE_MS = 30000;
const policyKey = () => {
    const settings = useSettingsStore.getState().settings;
    return JSON.stringify([isochroneRoutingContext('', settings), settings.vessel]);
};
export async function loadAlongRouteReport(
    input: {
        points: readonly { lat: number; lon: number }[];
        identity: string;
        departureMs: number | null;
        speedKts: number | null;
        /** Default: no WAN. Explicit public catalogue download still never downloads weather/charts. */
        downloadPublic?: boolean;
    },
    options: { signal: AbortSignal; isCurrent: () => boolean },
): Promise<AlongRouteReport> {
    const controller = new AbortController(),
        scope = getAuthIdentityScope(),
        boatId = useSettingsStore.getState().activeVesselId,
        policy = policyKey(),
        chartVersion = getVersion(),
        cacheEpoch = catalogueCacheEpoch(),
        wind = WindStore.getState(),
        deadline = Date.now() + ALONG_ROUTE_DEADLINE_MS;
    const windCurrent = () => {
        const now = WindStore.getState();
        return (
            now.grid === wind.grid &&
            now.model === wind.model &&
            now.field === wind.field &&
            now.localGribPath === wind.localGribPath &&
            now.isGlobalMode === wind.isGlobalMode
        );
    };
    const contextCurrent = () =>
        isAuthIdentityScopeCurrent(scope) &&
        useSettingsStore.getState().activeVesselId === boatId &&
        policyKey() === policy &&
        getVersion() === chartVersion &&
        catalogueCacheEpoch() === cacheEpoch &&
        windCurrent();
    const abort = () => controller.abort();
    const onContext = () => {
        if (!contextCurrent()) abort();
    };
    const guard = () => {
        if (controller.signal.aborted || Date.now() >= deadline || !contextCurrent() || !options.isCurrent())
            throw new DOMException(
                'Route references stopped; load again for the current route and boat.',
                'AbortError',
            );
    };
    const off = [
        subscribeAuthIdentityScope(abort),
        subscribeCharts(onContext),
        useSettingsStore.subscribe(onContext),
        WindStore.subscribe(onContext),
    ];
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    const timer = setTimeout(abort, ALONG_ROUTE_DEADLINE_MS);
    let abortListener: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
        abortListener = () =>
            reject(new DOMException('Route references stopped or exceeded 30 seconds.', 'AbortError'));
        controller.signal.addEventListener('abort', abortListener, { once: true });
        if (controller.signal.aborted) abortListener();
    });
    const work = async (): Promise<AlongRouteReport> => {
        guard();
        const geometry = prepareAlongRoute(input.points);
        if (
            input.speedKts !== null &&
            (!Number.isFinite(input.speedKts) || input.speedKts <= 0 || input.speedKts > 100)
        )
            throw Error('Set a planned speed between 0 and 100 knots, or leave it unknown.');
        if (
            input.departureMs !== null &&
            (!Number.isFinite(input.departureMs) || Math.abs(input.departureMs) > 8.64e15)
        )
            throw Error('The planned departure is outside the supported clock.');
        if (input.downloadPublic && satelliteModeActive())
            throw Error('Satellite Mode: use references already aboard.');
        const records: AlongPlace[] = [],
            sources: AlongRouteSource[] = [];
        for (const dataset of ['osm', 'facilities'] as const) {
            const result = await loadMarineCells(geometry.keys, [dataset], controller.signal, !input.downloadPublic);
            guard();
            const manifest = result.manifests[0];
            sources.push({
                name: dataset === 'osm' ? 'Mapped anchorages' : 'Mapped marinas and marine fuel',
                sourceAt: manifest?.sourceAt ?? null,
                coverage:
                    manifest?.coverage ?? 'Catalogue not published here or not available aboard; coverage unknown.',
                partial: result.partial || !manifest,
            });
            if (manifest)
                for (const p of result.records) {
                    const point = publicAlongPlace(p, {
                        label: LICENCES[dataset].label,
                        url: LICENCES[dataset].url,
                        at: manifest.sourceAt,
                    });
                    if (point) records.push({ ...point, id: `${dataset}:${point.id}` });
                    if (records.length > 10000)
                        throw Error(
                            'The combined reference inventory exceeds 10,000 records. Choose an individual leg.',
                        );
                }
        }
        const bridges = await readAlongRouteBridges(geometry, guard);
        guard();
        sources.push({
            name: 'Installed chart bridges',
            sourceAt: null,
            coverage: bridges.note,
            partial: !bridges.complete,
        });
        records.push(...bridges.records);
        const projected = await projectAlongPlaces(geometry, records, input, controller.signal, guard);
        guard();
        // Exact row positions and exact reference ETAs go only to the already
        // aboard sampler. downloadModel is deliberately impossible here.
        const timed = projected.rows.filter((row) => row.etaMs !== null);
        const clock: RouteClock = {
            positions: timed.map((row) => ({
                lat: row.lat,
                lon: row.lon,
                atMs: row.etaMs!,
                distanceNM: row.alongNm,
                courseDeg: null,
                gapBeforeHours: 0,
            })),
            totalDistanceNM: geometry.totalNm,
            arrivalMs:
                input.departureMs !== null && input.speedKts !== null
                    ? input.departureMs + (geometry.totalNm / input.speedKts) * 3600000
                    : 0,
            departureMs: input.departureMs ?? 0,
            speedKts: input.speedKts ?? 0,
            limited: projected.limited,
        };
        const weather = timed.length
            ? await loadRouteMeteogram(
                  { clock, identity: input.identity, performance: null },
                  {
                      signal: controller.signal,
                      isCurrent: () => {
                          try {
                              guard();
                              return true;
                          } catch {
                              return false;
                          }
                      },
                  },
              )
            : null;
        guard();
        const byId = new Map(
            timed.map((row, i) => {
                const sample = weather?.rows[i];
                return [
                    row.id,
                    sample
                        ? {
                              windKts: sample.windKts,
                              windDeg: sample.windDeg,
                              gustKts: sample.gustKts,
                              pressureHpa: sample.pressureHpa,
                          }
                        : emptyRouteWeather(),
                ] as const;
            }),
        );
        const report: AlongRouteReport = {
            ownerScope: scope,
            boatId,
            identity: input.identity,
            routeIdentity: geometry.identity,
            departureMs: input.departureMs,
            speedKts: input.speedKts,
            loadedAtMs: Date.now(),
            totalNm: geometry.totalNm,
            chartVersion,
            rows: projected.rows.map((row) => ({ ...row, weather: byId.get(row.id) ?? emptyRouteWeather() })),
            limited: projected.limited,
            cachedOnly: !input.downloadPublic || satelliteModeActive(),
            sources,
            weatherSource: weather?.source ?? 'Weather at ETA unknown',
            weatherCredit: weather?.credit ?? '',
            weatherRun: weather?.sourceRun ?? null,
            weatherNote: weather?.note ?? null,
        };
        guard();
        publishAlongRouteReport(report, contextCurrent);
        return report;
    };
    try {
        return await Promise.race([work(), stopped]);
    } finally {
        clearTimeout(timer);
        controller.abort();
        off.forEach((unsubscribe) => unsubscribe());
        options.signal.removeEventListener('abort', abort);
        if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    }
}
