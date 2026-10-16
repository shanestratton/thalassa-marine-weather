/** Entirely fictional transport/chart data exercises real client adapters.
 * No acquisition, real station proof, navigation permission or source activation. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_VESSEL } from '../../utils/defaultVessel';
import '../../index.css';
if (!import.meta.env.DEV) throw Error('Development fixture only.');
document.documentElement.style.fontSize = '20.8px';
const T = Math.floor(Date.now() / 1000) * 1000,
    HOUR = 3600000;
let calls = 0,
    held = false,
    release: (() => void) | null = null;
const station = {
    provider: 'MSQ',
    stationId: '048002B',
    stationName: 'Synthetic official event station',
    lat: 0,
    lon: 0.01,
    datumId: 'msq:048002B:source-LAT',
    datumLabel: 'Station LAT',
    rawDatum: 'LOWEST ASTRONOMICAL TIDE',
    sourceUrl: 'https://www.data.qld.gov.au/synthetic.csv',
    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'Entirely synthetic official table fixture',
    maxDistanceKm: 10,
};
const events = Array.from({ length: 63 }, (_, i) => ({
    time: new Date(T - 6 * HOUR + i * 6 * HOUR).toISOString(),
    type: i % 2 ? 'High' : 'Low',
    heightM: i % 2 ? 2 : 0.3,
}));
const official = {
    ...station,
    schema: 1,
    generatedAt: new Date(T).toISOString(),
    expiresAt: new Date(T + 24 * HOUR).toISOString(),
    coverageStart: events[0].time,
    coverageEnd: events.at(-1)!.time,
    events,
};
const path = `v1/msq/048002B/${T}.json`;
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });
window.fetch = async (input, init) => {
    calls++;
    const url = String(input);
    if (url.endsWith('/tides/manifest.json'))
        return json({
            schema: 1,
            generatedAt: official.generatedAt,
            expiresAt: official.expiresAt,
            stations: [{ ...station, path }],
        });
    if (url.endsWith(path)) return json(official);
    if (url.includes('/functions/v1/proxy-tides')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.stations) {
            if (held)
                await new Promise<void>((done) => {
                    release = done;
                });
            return json({
                status: 200,
                stations: [0.01, 0.015, 0.02].map((lon, i) => ({
                    id: `synthetic-${i}`,
                    name: `Synthetic station${i + 1}`,
                    lat: 0,
                    lon,
                    distance: i,
                })),
            });
        }
        return json({
            status: 200,
            responseLat: body.lat,
            responseLon: body.lon,
            responseDatum: 'MSL',
            requestDatum: 'LAT',
            station: 'Synthetic nearby prediction',
            timezone: 'UTC',
            copyright: 'Fictional WorldTides response fixture; no real navigation rights.',
            extremes: [],
            heights: [-1800, 0, 1800, 3600].map((s, i) => ({
                dt: T / 1000 + s,
                date: new Date(T + s * 1000).toISOString(),
                height: 0.5 + i * 0.5,
            })),
        });
    }
    return new Response('Synthetic fixture blocks all other network operations.', { status: 503 });
};
const [
    { TraceReportModal },
    { useTraceDraft },
    settings,
    auth,
    metadata,
    store,
    { commitPointOnlyWaitIntent },
    tideDetails,
] = await Promise.all([
    import('../../components/map/TraceReportModal'),
    import('../../components/map/useTraceDraft'),
    import('../../stores/settingsStore'),
    import('../../services/authIdentityScope'),
    import('../../services/enc/EncCellMetadata'),
    import('../../services/enc/EncCellStore'),
    import('../../services/routing/passageTideWaitAcceptance'),
    import('../../services/tides/stationDetails'),
]);
auth.setAuthIdentityScope(null);
await settings.awaitSettingsLoaded();
settings.useSettingsStore.setState({
    activeVesselId: 'synthetic-boat-a',
    settings: {
        ...settings.useSettingsStore.getState().settings,
        satelliteMode: false,
        vessel: { ...DEFAULT_VESSEL, name: 'Synthetic fixture boat', draft: 2, airDraft: 18, cruisingSpeed: 6 },
    },
});
const cell = {
    id: 'AU5FICT1',
    sourceHO: 'AU',
    edition: 1,
    issued: '2026-10-17',
    importedAt: '2026-10-17',
    bbox: [-1, -1, 1, 1] as [number, number, number, number],
    geojsonPath: 'vault',
    hazardCount: 1,
    licence: 'protected' as const,
};
await store.saveCellGeoJSON(
    cell.id,
    {
        cellId: cell.id,
        sourceHO: cell.sourceHO,
        edition: 1,
        issued: cell.issued,
        bbox: cell.bbox,
        extractorSchema: 3,
        soundingDatum: 23,
        verticalDatum: 17,
        layers: {
            M_SDAT: { type: 'FeatureCollection', features: [] },
            DEPARE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        geometry: {
                            type: 'Polygon',
                            coordinates: [
                                [
                                    [-1, -1],
                                    [1, -1],
                                    [1, 1],
                                    [-1, 1],
                                    [-1, -1],
                                ],
                            ],
                        },
                        properties: { DRVAL1: 5 },
                    },
                ],
            },
            SBDARE: {
                type: 'FeatureCollection',
                features: [
                    { type: 'Feature', geometry: { type: 'Point', coordinates: [0.02, 0] }, properties: { NATSUR: 4 } },
                ],
            },
            WEDKLP: { type: 'FeatureCollection', features: [] },
            BRIDGE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        geometry: {
                            type: 'LineString',
                            coordinates: [
                                [0.019, -0.001],
                                [0.019, 0.001],
                            ],
                        },
                        properties: { OBJNAM: 'PRIVATE FICTIONAL BRIDGE', CATBRG: 3, VERCCL: 15, VERCOP: 30 },
                    },
                ],
            },
        },
    },
    undefined,
    'protected',
);
metadata.putCell(cell);
const initial = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.02 },
];
let queuedRefused = false;
function Fixture() {
    const draft = useTraceDraft(),
        [open, setOpen] = React.useState(true);
    const { setCapturedCoords } = draft;
    React.useEffect(() => {
        setCapturedCoords(initial);
    }, [setCapturedCoords]);
    React.useEffect(() => {
        if (draft.capturedCoords.length >= 2) document.body.dataset.ready = 'true';
    }, [draft.capturedCoords]);
    Object.assign(window, {
        __tide138: {
            calls: () => calls,
            hold: () => {
                tideDetails.__resetTideStationDetailsForTests();
                held = true;
                release = null;
            },
            pending: () => release !== null,
            release: () => {
                held = false;
                release?.();
            },
            changeBoat: () => settings.useSettingsStore.setState({ activeVesselId: 'synthetic-boat-b' }),
            changeCharts: () => metadata.putCell({ ...cell, edition: 2 }),
            queueEdit: () => {
                const points = draft.capturedCoords,
                    epoch = draft.getTraceEditEpoch();
                draft.setCapturedCoords([initial[0], { lat: 0, lon: 0.01 }]);
                draft.setCapturedCoords(points);
                queuedRefused = !draft.commitCheckedTracePoints(
                    epoch,
                    points,
                    (p) => [...p, { lat: 0, lon: 0.03, name: 'Wait' }],
                    () => true,
                );
            },
            queuedRefused: () => queuedRefused,
            points: () => draft.capturedCoords,
            localText: () =>
                Object.keys(localStorage)
                    .map((k) => localStorage.getItem(k))
                    .join(' '),
        },
    });
    return (
        <main className="min-h-dvh bg-slate-950 p-2 text-white">
            <TraceReportModal
                open={open}
                onClose={() => setOpen(false)}
                pins={draft.capturedCoords}
                routeName="Synthetic tide/bridge/wait review"
                verdicts={[]}
                tideLabels={{}}
                departureLabel=""
                ackedLegs={new Set()}
                releaseGate={{
                    allowed: false,
                    reason: 'Synthetic reference fixture has no navigation verification.',
                    verification: null,
                }}
                fixBusy={null}
                onAckLeg={() => {}}
                cruisingSpeedKts={6}
                departureMs={T + 23456}
                traceEditEpoch={draft.getTraceEditEpoch()}
                onCommitTideWait={(intent) => commitPointOnlyWaitIntent(intent, draft.commitCheckedTracePoints)}
            />
            <button onClick={() => setOpen(true)}>Open fixture report</button>
            <p>Synthetic browser fixture only.</p>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
