import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only.');
const offline = new URLSearchParams(location.search).has('offline');
const requests: string[] = [];
Object.assign(window, { catalogueFixtureRequests: requests });
const localFetch = window.fetch.bind(window);
window.fetch = async (input) => {
    const url = String(input);
    if (url === '/data/noaa-enc-user-agreement.txt') return localFetch(input);
    if (!url.startsWith('https://tiles.thalassatiles.com/marine-catalogue/v1/'))
        return new Response('Synthetic fixture: no provider access', { status: 503 });
    requests.push(url);
    if (offline) throw new Error('Fixture offline; unexpected WAN attempt');
    const parts = url.split('/v1/')[1].split('/'),
        dataset = parts[0] as 'places' | 'osm' | 'noaa';
    const licence =
        dataset === 'places'
            ? 'https://creativecommons.org/licenses/by/4.0/'
            : dataset === 'osm'
              ? 'https://opendatacommons.org/licenses/odbl/1-0/'
              : 'https://charts.noaa.gov/ENCs/ENC_Agreement.shtml';
    let body: unknown;
    if (parts[1] === 'manifest.json')
        body = {
            schema: 1,
            dataset,
            generation: '202610-fixture',
            builtAt: new Date().toISOString(),
            sourceAt: new Date().toISOString(),
            count: 30,
            shards: ['names/63-6f-72', 'areas/36_179'],
            ...(dataset === 'noaa' ? { agreementSha256: '175f625ba0ae7b8656bf41010d6e5226b70f66a5a5c00ceff450c2eba2411c24' } : {}),
            coverage: 'Generated Fiji fixture only; no real catalogue publication',
            licence,
            sourceUrl:
                dataset === 'places'
                    ? 'https://download.geonames.org/export/dump/allCountries.zip'
                    : dataset === 'osm'
                      ? 'https://download.geofabrik.de/australia-oceania.html'
                      : 'https://www.charts.noaa.gov/ENCs/ENCs.shtml',
        };
    else {
        const key = parts
            .slice(2)
            .join('/')
            .replace(/\.json$/, '');
        if (!['names/63-6f-72', 'areas/36_179'].includes(key)) return new Response('', { status: 404 });
        const records =
            dataset === 'places'
                ? Array.from({ length: key.startsWith('names') ? 30 : 1 }, (_, i) => ({
                      id: `geonames:${i + 1}`,
                      name: `Coral Bay ${i + 1} — Fictional long place name for narrow-screen proof`,
                      kind: 'bay',
                      lat: -17,
                      lon: 179.5,
                      country: 'FJ',
                      aliases: [],
                      approximate: true,
                  }))
                : [
                      {
                          id: dataset === 'osm' ? 'osm-node42' : 'noaa:0226000000001234',
                          name:
                              dataset === 'osm'
                                  ? 'Fictional public mooring with unknown permission'
                                  : 'Fictional anchorage reference',
                          kind: dataset === 'osm' ? 'mooring' : 'anchorage',
                          lat: -17,
                          lon: 179.5,
                          country: '',
                          aliases: [],
                          approximate: true,
                      },
                  ];
        body = { schema: 1, dataset, generation: '202610-fixture', key, records };
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
};
const [{ MarinePlacesView }, settings] = await Promise.all([
    import('../../components/weather/MarinePlacesSheet'),
    import('../../stores/settingsStore'),
]);
await settings.awaitSettingsLoaded();
settings.useSettingsStore.setState({
    settings: { ...settings.useSettingsStore.getState().settings, satelliteMode: offline },
});
function Fixture() {
    const [open, setOpen] = React.useState(true);
    const close = React.useCallback(() => setOpen(false), []);
    return (
        <main className="h-dvh bg-slate-950 text-white" style={{ fontFamily: 'Verdana, sans-serif' }}>
            <button onClick={() => setOpen(true)}>Open marine places</button>
            {open && (
                <MarinePlacesView
                    near={{ lat: -17, lon: 179.5 }}
                    satelliteMode={offline}
                    onClose={close}
                    onSave={() => 'Saved fictional spot'}
                    onForecast={() => undefined}
                />
            )}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
