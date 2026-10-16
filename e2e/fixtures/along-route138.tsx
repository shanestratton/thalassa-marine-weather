/** Entirely invented local chart/catalogue fixture, never acquired data. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw Error('Development fixture only.');
document.documentElement.style.fontSize = '20.8px';
let remoteAttempts = 0;
window.fetch = async () => {
    remoteAttempts++;
    return new Response('Synthetic fixture: network disabled.', { status: 503 });
};
const [{ TraceReportModal }, { AlongRouteNextUp }, settings, auth, cache, metadata, store, { WindStore }, reportStore] =
    await Promise.all([
        import('../../components/map/TraceReportModal'),
        import('../../components/passage/AlongRouteNextUp'),
        import('../../stores/settingsStore'),
        import('../../services/authIdentityScope'),
        import('../../services/marineCatalogue/cache'),
        import('../../services/enc/EncCellMetadata'),
        import('../../services/enc/EncCellStore'),
        import('../../stores/WindStore'),
        import('../../stores/alongRouteReportStore'),
    ]);
auth.setAuthIdentityScope(null);
await settings.awaitSettingsLoaded();
settings.useSettingsStore.setState({
    activeVesselId: 'fictional-boat-a',
    settings: {
        ...settings.useSettingsStore.getState().settings,
        satelliteMode: true,
        vessel: {
            ...settings.useSettingsStore.getState().settings.vessel,
            name: 'Fictional fixture boat',
            type: 'sail',
            draft: 6,
            airDraft: 60,
            cruisingSpeed: 6,
        },
    },
});
const T = Date.parse('2026-10-17T06:00:00Z'),
    pins = [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 0.02 },
    ];
for (const dataset of ['osm', 'facilities'] as const) {
    const manifest = {
        schema: 1,
        dataset,
        generation: '202610-synthetic138',
        builtAt: '2026-10-16T00:00:00Z',
        sourceAt: '2026-10-15T00:00:00Z',
        coverage: 'Invented local fixture points only; no real-world coverage',
        count: 1,
        licence: 'https://opendatacommons.org/licenses/odbl/1-0/',
        sourceUrl: 'https://download.geofabrik.de/australia-oceania/fiji-latest.osm.pbf',
        shards: ['areas/45_90'],
        ...(dataset === 'facilities'
            ? {
                  cohorts: [
                      {
                          id: 'https://download.geofabrik.de/australia-oceania/fiji',
                          sourceAt: '2026-10-15T00:00:00Z',
                          sha256: 'a'.repeat(64),
                      },
                  ],
              }
            : {}),
    };
    const row = {
        id: dataset === 'osm' ? 'osm-node13801' : 'osm-node13802',
        name:
            dataset === 'osm'
                ? 'Fictional anchorage with a long unfamiliar place name'
                : 'Fictional marina and marine fuel reference',
        kind: dataset === 'osm' ? 'anchorage' : 'marina',
        lat: 0,
        lon: dataset === 'osm' ? 0.005 : 0.01,
        country: '',
        aliases: [],
        approximate: false,
        ...(dataset === 'facilities' ? { facilityKinds: ['marina', 'fuel'] } : {}),
    };
    await cache.writeCatalogueCache(`${dataset}/manifest.json`, JSON.stringify(manifest), cache.catalogueCacheEpoch());
    await cache.writeCatalogueCache(
        `${dataset}/${manifest.generation}/areas/45_90.json`,
        JSON.stringify({ schema: 1, dataset, generation: manifest.generation, key: 'areas/45_90', records: [row] }),
        cache.catalogueCacheEpoch(),
    );
}
await store.saveCellGeoJSON(
    'AU5FICT1',
    {
        cellId: 'AU5FICT1',
        sourceHO: 'AU',
        edition: 1,
        issued: '2026-10-15',
        bbox: [-1, -1, 1, 1],
        extractorSchema: 3,
        verticalDatum: 17,
        layers: {
            BRIDGE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        geometry: {
                            type: 'LineString',
                            coordinates: [
                                [0.015, -0.1],
                                [0.015, 0.1],
                            ],
                        },
                        properties: {
                            LNAM: '0001000000013801',
                            OBJNAM: 'Entirely fictional chart bridge',
                            CATBRG: 1,
                            VERCLR: 25,
                        },
                    },
                ],
            },
        },
    },
    undefined,
    'protected',
);
const cell = {
    id: 'AU5FICT1',
    sourceHO: 'AU',
    edition: 1,
    issued: '2026-10-15',
    importedAt: '2026-10-16',
    bbox: [-1, -1, 1, 1] as [number, number, number, number],
    geojsonPath: 'vault',
    hazardCount: 1,
    licence: 'protected' as const,
};
metadata.putCell(cell);
WindStore.setState({
    model: 'icon',
    field: 'wind',
    isGlobalMode: true,
    grid: {
        width: 2,
        height: 2,
        north: 1,
        south: -1,
        west: -1,
        east: 1,
        lats: [-1, 1],
        lons: [-1, 1],
        totalHours: 2,
        refTime: new Date(T).toISOString(),
        stepHours: [0, 1],
        u: [new Float32Array(4).fill(-5), new Float32Array(4).fill(-5)],
        v: [new Float32Array(4), new Float32Array(4)],
        speed: [new Float32Array(4).fill(5), new Float32Array(4).fill(5)],
    },
});
Object.assign(window, {
    __along138: {
        remote: () => remoteAttempts,
        report: () => reportStore.getAlongRouteReport(),
        changeCharts: () => metadata.putCell({ ...cell, edition: 2 }),
        changeBoat: () => settings.useSettingsStore.setState({ activeVesselId: 'fictional-boat-b' }),
        changeAccount: () => auth.setAuthIdentityScope('fictional-other-owner'),
        localText: () =>
            Object.keys(localStorage)
                .map((key) => localStorage.getItem(key))
                .join(' '),
    },
});
function Fixture() {
    const [open, setOpen] = React.useState(true);
    React.useEffect(() => {
        document.body.dataset.ready = 'true';
    }, []);
    return (
        <main className="min-h-dvh bg-slate-950 p-2 text-white">
            <TraceReportModal
                open={open}
                onClose={() => setOpen(false)}
                pins={pins}
                routeName="Fictional along-route report"
                verdicts={[]}
                tideLabels={{}}
                departureLabel=""
                ackedLegs={new Set()}
                releaseGate={{ allowed: false, reason: 'Synthetic reference fixture has no navigation verification.' }}
                fixBusy={null}
                onAckLeg={() => {}}
                cruisingSpeedKts={6}
                departureMs={T}
            />
            <button className="min-h-11 px-2" onClick={() => setOpen(true)}>
                Open fixture report
            </button>
            <div className="w-40 rounded border border-white/20">
                <AlongRouteNextUp points={pins} alongNm={0} />
            </div>
            <p className="text-xs">Synthetic test only. No live chart, provider or equipment connection.</p>
        </main>
    );
}
remoteAttempts = 0;
createRoot(document.getElementById('root')!).render(<Fixture />);
