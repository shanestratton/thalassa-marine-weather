/** Real existing source adapters for informational passage review. Nothing in
 * this display DTO is navigation authority or an invented extrema curve. */
import { listSavedTideTables, tideDistanceKm, type SavedTideTable } from './offlineTideStore';
import { fetchOfficialTides, type OfficialTideDocument } from './officialTides';
import { fetchNearbyTideStations, fetchTideStationDetails, type TideStationDetails } from './stationDetails';
import { sampleStationPrediction, type SampledTideSeries } from './sampledTideContract';
import { NOAA_HARMONIC_STATION, predictNoaaHarmonic } from './noaaHarmonics';
import { satelliteModeActive } from '../networkPolicy';
export type PassageTideSourceMode = 'aboard' | 'official' | 'nearby';
export interface PassageStationPrediction {
    id: string;
    name: string;
    provider: string;
    kind: 'saved-events' | 'official-events' | 'sampled-prediction' | 'local-harmonic-model';
    distanceKm: number;
    datum: string | null;
    datumEpoch: string | null;
    heightAtEtaM: number | null;
    originalIssueMs: number | null;
    receivedAtMs: number | null;
    publicationAtMs: number | null;
    events: { timeMs: number; heightM: number; type: 'High' | 'Low' }[];
    note: string;
    credit: string;
}
const nearEvents = (events: PassageStationPrediction['events'], atMs: number) =>
    events.filter((e) => Math.abs(e.timeMs - atMs) <= 24 * 3600000).slice(0, 8);
function savedInfo(t: SavedTideTable, point: { lat: number; lon: number }, atMs: number): PassageStationPrediction {
    return {
        id: t.id,
        name: t.predictionStationName ?? t.station.name,
        provider: t.provider,
        kind: 'saved-events',
        distanceKm: tideDistanceKm(point, t.predictionLocation ?? t.station),
        datum: t.datum,
        datumEpoch: null,
        heightAtEtaM: null,
        originalIssueMs: null,
        receivedAtMs: t.fetchedAtMs,
        publicationAtMs: t.generatedAt ? Date.parse(t.generatedAt) : null,
        events: nearEvents(t.extremes, atMs),
        note: 'Saved high/low events only. No any-time height, original issue clock or chart datum transfer is supplied.',
        credit: t.copyright,
    };
}
function officialInfo(
    t: OfficialTideDocument,
    point: { lat: number; lon: number },
    atMs: number,
): PassageStationPrediction {
    return {
        id: `${t.provider}:${t.stationId}`,
        name: t.stationName,
        provider: t.provider,
        kind: 'official-events',
        distanceKm: tideDistanceKm(point, t),
        datum: t.datumLabel,
        datumEpoch: null,
        heightAtEtaM: null,
        originalIssueMs: null,
        receivedAtMs: null,
        publicationAtMs: Date.parse(t.generatedAt),
        events: nearEvents(
            t.events.map((e) => ({ ...e, timeMs: Date.parse(e.time) })),
            atMs,
        ),
        note: 'Official high/low table. Publication time is not an original prediction issue; events are not interpolated into any-time heights.',
        credit: t.attribution,
    };
}
export function passageStationInfo(
    t: TideStationDetails,
    point: { lat: number; lon: number },
    atMs: number,
    nowMs: number,
): PassageStationPrediction {
    const location = t.predictionLocation;
    const sample =
        t.source === 'WorldTides' && location && t.datum
            ? sampleStationPrediction(
                  {
                      schema: 1,
                      kind: 'sampled-prediction',
                      provider: 'WorldTides',
                      productId: 'proxy-original-30m-heights',
                      stationId: t.station.id,
                      stationName: t.predictionStationName ?? t.station.name,
                      ...location,
                      datumId: `WorldTides:${t.datum}`,
                      datumLabel: t.datum,
                      datumEpoch: null,
                      sourceAtMs: null,
                      receivedAtMs: t.fetchedAtMs,
                      expiresAtMs: t.fetchedAtMs + 6 * 3600000,
                      sourceUrl: 'https://www.worldtides.info/',
                      licenceUrl: 'https://www.worldtides.info/terms',
                      units: 'm',
                      samples: t.heights,
                  },
                  atMs,
                  nowMs,
              )
            : null;
    return {
        id: `${t.source}:${t.station.id}`,
        name: t.predictionStationName ?? t.station.name,
        provider: t.source,
        kind: t.source === 'WorldTides' ? 'sampled-prediction' : 'saved-events',
        distanceKm: location ? tideDistanceKm(point, location) : tideDistanceKm(point, t.station),
        datum: t.datum,
        datumEpoch: null,
        heightAtEtaM: sample?.heightM ?? null,
        originalIssueMs: null,
        receivedAtMs: t.fetchedAtMs,
        publicationAtMs: null,
        events: nearEvents(t.extremes, atMs),
        note: [
            'Height applies at the actual provider prediction location, not at the route point.',
            !location ? 'Actual prediction location unknown; any-time height withheld.' : '',
            !sample ? 'No original sampled bracket covers this ETA.' : '',
            t.source === 'WorldTides'
                ? 'WorldTides navigation permission is unverified. No clearance, alarm or holding credit is applied.'
                : 'Saved events provide no navigation-qualified any-time height or chart datum transfer.',
        ]
            .filter(Boolean)
            .join(' '),
        credit: t.copyright,
    };
}
export async function loadPassageTideSources(
    point: { lat: number; lon: number },
    atMs: number,
    mode: PassageTideSourceMode,
    options: { signal: AbortSignal; assertCurrent: () => void },
): Promise<{ stations: PassageStationPrediction[]; notes: string[]; navigationSeries: readonly SampledTideSeries[] }> {
    const check = () => {
        options.signal.throwIfAborted();
        options.assertCurrent();
    };
    check();
    if (!Number.isFinite(atMs) || atMs < 946684800000 || atMs > 4102444800000)
        throw Error('The ETA is outside the supported tide clock.');
    if (mode !== 'aboard' && satelliteModeActive()) throw Error('Satellite Mode: use tide references already aboard.');
    const stations: PassageStationPrediction[] = [],
        notes: string[] = [];
    const saved = await listSavedTideTables();
    check();
    stations.push(
        ...saved
            .filter((t) => tideDistanceKm(point, t.station) <= 100)
            .sort((a, b) => tideDistanceKm(point, a.station) - tideDistanceKm(point, b.station))
            .slice(0, 3)
            .map((t) => savedInfo(t, point, atMs)),
    );
    if (tideDistanceKm(point, NOAA_HARMONIC_STATION) <= 15) {
        const height = predictNoaaHarmonic(NOAA_HARMONIC_STATION.id, atMs);
        stations.push({
            id: `local:${NOAA_HARMONIC_STATION.id}`,
            name: NOAA_HARMONIC_STATION.name,
            provider: 'NOAA constants / local model',
            kind: 'local-harmonic-model',
            distanceKm: tideDistanceKm(point, NOAA_HARMONIC_STATION),
            datum: NOAA_HARMONIC_STATION.datum,
            datumEpoch: NOAA_HARMONIC_STATION.datumEpoch,
            heightAtEtaM: height,
            originalIssueMs: null,
            receivedAtMs: null,
            publicationAtMs: null,
            events: [],
            note: 'Local station harmonic model from constants retrieved 16 Oct 2026. This is not a live observation or an original dense provider product; no transfer to this chart cell is reviewed.',
            credit: 'NOAA CO-OPS harmonic constants; local UTide-derived model.',
        });
    }
    if (mode === 'official') {
        const official = await fetchOfficialTides(point.lat, point.lon);
        check();
        if (official) stations.unshift(officialInfo(official, point, atMs));
        else notes.push('No current official table is published within its declared station coverage here.');
    } else if (mode === 'nearby') {
        const nearby = await fetchNearbyTideStations(point.lat, point.lon, { signal: options.signal });
        check();
        const selected = [...new Map((nearby ?? []).map((s) => [s.id, s])).values()]
            .filter((s) => tideDistanceKm(point, s) <= 100)
            .sort((a, b) => tideDistanceKm(point, a) - tideDistanceKm(point, b))
            .slice(0, 3);
        const details = await Promise.all(
            selected.map((station) => fetchTideStationDetails(station, { signal: options.signal, includeWind: false })),
        );
        check();
        stations.unshift(
            ...details
                .filter((d): d is TideStationDetails => !!d)
                .map((d) => passageStationInfo(d, point, atMs, Date.now())),
        );
        if (!details.some(Boolean))
            notes.push('Nearby sampled predictions are unavailable from the existing tide proxy.');
    }
    check();
    if (!stations.length)
        notes.push(
            'No tide reference is aboard for this point. An explicit official or nearby lookup may provide informational data.',
        );
    notes.push(
        'Nearby stations are shown separately. No averaging across untied datums or extrapolation to this route point.',
    );
    // None of these existing adapters supplies independently acquired,
    // reviewed navigation samples. This list is deliberately separate from
    // display DTOs and can only be populated by a reviewed adapter change.
    return {
        stations: [...new Map(stations.map((s) => [`${s.kind}:${s.id}`, s])).values()].slice(0, 8),
        notes,
        navigationSeries: [],
    };
}
