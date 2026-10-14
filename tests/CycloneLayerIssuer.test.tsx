/**
 * The storm layer says who drew what (129-09). The cone is the issuer's own
 * published polygon (NHC's cone, or JTWC's danger area labelled as an
 * advisory), never one generated here; each model's track is a thin labelled
 * line; the card names the issuer, the advisory time and the official centre;
 * and a dead feed says "Cyclone data unavailable since", never "no cyclones".
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCycloneLayer } from '../components/map/useCycloneLayer';
import type { ActiveCyclone, CycloneModelTrack } from '../services/weather/CycloneTrackingService';
import { cycloneCentre, trackIssuerLabel } from '../supabase/functions/_shared/cyclone/centres';

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(),
    models: vi.fn((): CycloneModelTrack[] => []),
    status: vi.fn(() => ({
        unavailableSince: null as number | null,
        forecastUnavailableSince: null as number | null,
        coneUnavailableSince: null as number | null,
    })),
}));
vi.mock('../services/weather/CycloneTrackingService', () => ({
    fetchActiveCyclones: mocks.fetch,
    fetchGfsTrackerPositions: async () => new Map(),
    findClosestCyclone: (storms: ActiveCyclone[]) => storms[0] ?? null,
    modelTracksFor: mocks.models,
    cycloneFeedStatus: mocks.status,
}));
vi.mock('../stores/WindStore', () => ({ WindStore: { subscribe: () => () => undefined } }));
vi.mock('../components/map/cloudOverlay', () => ({ mountCloudOverlay: vi.fn(), removeCloudOverlay: vi.fn() }));
vi.mock('../utils/createLogger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('mapbox-gl', () => ({
    default: {
        Point: class Point {
            constructor(
                public x: number,
                public y: number,
            ) {}
        },
        Marker: class Marker {
            constructor(private options: { element: HTMLElement }) {}
            setLngLat() {
                return this;
            }
            addTo(map: { getContainer: () => HTMLElement }) {
                map.getContainer().append(this.options.element);
                return this;
            }
            remove() {
                this.options.element.remove();
            }
        },
    },
}));

const H = 3_600_000;
const FEED_OK = { unavailableSince: null, forecastUnavailableSince: null, coneUnavailableSince: null };
const CONE: GeoJSON.Polygon = {
    type: 'Polygon',
    coordinates: [
        [
            [-108, 18],
            [-110, 21],
            [-115, 24],
            [-112, 24.5],
            [-107.5, 18.2],
            [-108, 18],
        ],
    ],
};

/** What CycloneTrackingService attaches to every storm: the issuer's label and the warning centre. */
function named(c: ActiveCyclone): ActiveCyclone {
    const centre = cycloneCentre(c.currentPosition.lat, c.currentPosition.lon);
    return {
        ...c,
        centre: { short: centre.short, url: centre.url },
        ...(c.forecastBy ? { issuer: trackIssuerLabel(c.forecastBy.by, centre) } : {}),
    };
}

function storm(over: Partial<ActiveCyclone> = {}): ActiveCyclone {
    const now = Date.now();
    const current = { lat: 18, lon: -108, time: new Date(now - 2 * H).toISOString(), windKts: 80, pressureMb: 960 };
    return named({
        sid: 'ep412026',
        name: 'ZZELLA',
        basin: 'E',
        category: 1,
        categoryLabel: '1',
        currentPosition: current,
        track: [{ ...current, lat: 17.4, time: new Date(now - 8 * H).toISOString() }, current],
        forecastTrack: [
            { ...current, lat: 19.9, lon: -110.6, time: new Date(now + 22 * H).toISOString() },
            { ...current, lat: 23.6, lon: -113.6, time: new Date(now + 70 * H).toISOString() },
        ],
        forecastBy: { by: 'NHC', advisory: '24A', issued: new Date(now - 2 * H).toISOString() },
        cone: CONE,
        maxWindKts: 80,
        minPressureMb: 960,
        nature: 'HU',
        ...over,
    });
}

const coralSea = (over: Partial<ActiveCyclone> = {}) =>
    storm({
        sid: 'sh382027',
        name: 'ZZDORA',
        basin: 'P',
        currentPosition: { lat: -15, lon: 153, time: new Date().toISOString(), windKts: 55, pressureMb: 995 },
        track: [],
        forecastTrack: [
            {
                lat: -16.7,
                lon: 151.5,
                time: new Date(Date.now() + 24 * H).toISOString(),
                windKts: 65,
                pressureMb: null,
            },
            {
                lat: -18.4,
                lon: 150.6,
                time: new Date(Date.now() + 48 * H).toISOString(),
                windKts: 60,
                pressureMb: null,
            },
        ],
        forecastBy: { by: 'JTWC', advisory: 'x', issued: new Date(Date.now() - 3 * H).toISOString() },
        cone: undefined,
        ...over,
    });

function makeMap() {
    const container = document.createElement('div');
    const sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
    const layers = new Map<string, Record<string, unknown> & { id: string }>();
    const listeners = new Map<string, Set<() => void>>();
    const map = {
        getContainer: () => container,
        getStyle: () => ({ layers: [...layers.values()], sources: Object.fromEntries(sources) }),
        isStyleLoaded: () => true,
        getSource: (id: string) => sources.get(id),
        addSource: (id: string, spec: { data: unknown }) => {
            const entry = {
                data: spec.data,
                setData: (d: unknown) => {
                    entry.data = d;
                },
            };
            sources.set(id, entry);
        },
        removeSource: (id: string) => sources.delete(id),
        getLayer: (id: string) => layers.get(id),
        addLayer: (layer: Record<string, unknown> & { id: string }) => layers.set(layer.id, layer),
        removeLayer: (id: string) => layers.delete(id),
        getZoom: () => 3,
        getMaxZoom: () => 22,
        setMinZoom: () => undefined,
        setMaxZoom: () => undefined,
        getCenter: () => ({ lat: 18, lng: -108 }),
        project: ([lon, lat]: number[]) => ({ x: lon, y: lat }),
        setLayoutProperty: (id: string, name: string, value: unknown) => {
            const layer = layers.get(id) as { layout?: Record<string, unknown> } | undefined;
            if (layer) layer.layout = { ...layer.layout, [name]: value };
        },
        flyTo: vi.fn(),
        easeTo: vi.fn(),
        on: (event: string, handler: () => void) => {
            const set = listeners.get(event) ?? new Set();
            set.add(handler);
            listeners.set(event, set);
        },
        off: (event: string, handler: () => void) => listeners.get(event)?.delete(handler),
    };
    return { map, container, sources, layers };
}

type Fc = GeoJSON.FeatureCollection;

describe('the cone is the issuer’s own polygon', () => {
    beforeEach(() => {
        mocks.fetch.mockReset();
        mocks.models.mockReset().mockReturnValue([]);
        mocks.status.mockReset().mockReturnValue(FEED_OK);
    });
    afterEach(() => vi.restoreAllMocks());

    it('draws NHC’s published cone exactly as published', async () => {
        const s = storm();
        mocks.fetch.mockResolvedValue([s]);
        const h = makeMap();
        const hook = renderHook(() =>
            useCycloneLayer({ current: h.map as never }, true, true, 20, -105, vi.fn(), undefined, s),
        );
        await waitFor(() => expect(h.layers.has('cyclone-sleeve-core')).toBe(true));
        const data = h.sources.get('cyclone-sleeve-src')!.data as Fc;
        const cone = data.features.find((f) => f.geometry.type === 'Polygon')!;
        expect(cone.geometry).toEqual(CONE);
        expect(cone.properties).toMatchObject({ official: true });
        hook.unmount();
        expect(h.layers.size).toBe(0);
        expect(h.sources.size).toBe(0);
    });

    it('generates no cone where the issuer published none', async () => {
        const s = coralSea();
        mocks.fetch.mockResolvedValue([s]);
        const h = makeMap();
        const hook = renderHook(() =>
            useCycloneLayer({ current: h.map as never }, true, true, -27, 153, vi.fn(), undefined, s),
        );
        await waitFor(() => expect(h.container.querySelector('#cyclone-hud-badges')).not.toBeNull());
        await waitFor(() =>
            expect(h.layers.has('past-track-sh382027-line') || h.container.querySelector('svg')).toBeTruthy(),
        );
        expect(h.layers.has('cyclone-sleeve-core')).toBe(false);
        expect(h.container.querySelector('.thalassa-cone')).toBeNull();
        hook.unmount();
    });

    it('JTWC’s danger area is amber, an advisory, and its track is dashed; NHC’s is white and solid', async () => {
        const area: GeoJSON.Polygon = {
            type: 'Polygon',
            coordinates: [
                [
                    [153, -15],
                    [151, -18],
                    [150, -19],
                    [152.5, -19.5],
                    [153.6, -15.2],
                    [153, -15],
                ],
            ],
        };
        const past = {
            lat: -14.2,
            lon: 154,
            time: new Date(Date.now() - 6 * H).toISOString(),
            windKts: 50,
            pressureMb: 998,
        };
        const s = coralSea({ cone: area });
        const withTrack = { ...s, track: [past, s.currentPosition] };
        mocks.fetch.mockResolvedValue([withTrack]);
        const h = makeMap();
        const hook = renderHook(() =>
            useCycloneLayer({ current: h.map as never }, true, true, -27, 153, vi.fn(), undefined, withTrack),
        );
        await waitFor(() => expect(h.layers.has('cyclone-sleeve-core')).toBe(true));
        const cone = (h.sources.get('cyclone-sleeve-src')!.data as Fc).features[0];
        expect(cone.properties).toMatchObject({ official: false });
        const fill = (h.layers.get('cyclone-sleeve-core') as unknown as { paint: Record<string, unknown[]> }).paint;
        // ['case', official, white, amber]: an advisory's area is amber.
        expect(fill['fill-color']).toEqual(['case', ['get', 'official'], '#ffffff', '#f59e0b']);
        await waitFor(() => expect(h.container.querySelector('path.thalassa-spine')).not.toBeNull());
        expect(h.container.querySelector('path.thalassa-spine')!.getAttribute('stroke-dasharray')).toBe('6 5');
        hook.unmount();

        const n = storm();
        mocks.fetch.mockResolvedValue([n]);
        const h2 = makeMap();
        const hook2 = renderHook(() =>
            useCycloneLayer({ current: h2.map as never }, true, true, 20, -105, vi.fn(), undefined, n),
        );
        await waitFor(() => expect(h2.container.querySelector('path.thalassa-spine')).not.toBeNull());
        expect(h2.container.querySelector('path.thalassa-spine')!.hasAttribute('stroke-dasharray')).toBe(false);
        hook2.unmount();
    });

    it('a cone across the antimeridian is drawn the short way, its longitudes continuous', async () => {
        const fijiCone: GeoJSON.Polygon = {
            type: 'Polygon',
            coordinates: [
                [
                    [178.5, -16.8],
                    [179.9, -17.6],
                    [-179.8, -18.4],
                    [-176, -20.5],
                    [-177.4, -21.6],
                    [-179.3, -19.4],
                    [178.2, -17.4],
                    [178.5, -16.8],
                ],
            ],
        };
        const s = storm({
            sid: 'sh372027',
            name: 'ZZCORA',
            basin: 'P',
            currentPosition: { lat: -17, lon: 178.5, time: new Date().toISOString(), windKts: 60, pressureMb: 985 },
            track: [],
            forecastTrack: [
                {
                    lat: -18.6,
                    lon: 179.6,
                    time: new Date(Date.now() + 24 * H).toISOString(),
                    windKts: 65,
                    pressureMb: null,
                },
                {
                    lat: -20.6,
                    lon: -177.4,
                    time: new Date(Date.now() + 48 * H).toISOString(),
                    windKts: 60,
                    pressureMb: null,
                },
            ],
            forecastBy: { by: 'JTWC', advisory: 'x', issued: new Date(Date.now() - 2 * H).toISOString() },
            cone: fijiCone,
        });
        mocks.fetch.mockResolvedValue([s]);
        const h = makeMap();
        const hook = renderHook(() =>
            useCycloneLayer({ current: h.map as never }, true, true, -18, 178.4, vi.fn(), undefined, s),
        );
        await waitFor(() => expect(h.sources.has('cyclone-sleeve-src')).toBe(true));
        const ring = ((h.sources.get('cyclone-sleeve-src')!.data as Fc).features[0].geometry as GeoJSON.Polygon)
            .coordinates[0];
        expect(ring).toHaveLength(fijiCone.coordinates[0].length);
        for (let i = 1; i < ring.length; i++) expect(Math.abs(ring[i][0] - ring[i - 1][0])).toBeLessThan(10);
        // Spelt east of 180 (no vertex cut), latitudes untouched.
        expect(ring.map((p) => p[1])).toEqual(fijiCone.coordinates[0].map((p) => p[1]));
        expect(ring[3][0]).toBeCloseTo(184, 6);
        // The published polygon itself is not changed.
        expect(fijiCone.coordinates[0][3][0]).toBe(-176);
        hook.unmount();
    });
});

describe('each model is a thin labelled line', () => {
    beforeEach(() => {
        mocks.fetch.mockReset();
        mocks.status.mockReset().mockReturnValue(FEED_OK);
    });

    it('draws every model the tracker sent, each with its label, and credits ECMWF', async () => {
        const s = storm();
        mocks.models.mockReset().mockReturnValue([
            {
                label: 'GFS',
                by: 'NOAA NCEP',
                cycle: '2026-10-13T06:00:00.000Z',
                line: [
                    [-108, 18],
                    [-111, 21],
                    [-114, 24],
                ],
            },
            {
                label: 'ECMWF',
                by: 'ECMWF',
                cycle: '2026-10-13T00:00:00.000Z',
                line: [
                    [-108, 18],
                    [-110, 22],
                    [-112, 25],
                ],
            },
        ]);
        mocks.fetch.mockResolvedValue([s]);
        const h = makeMap();
        const hook = renderHook(() =>
            useCycloneLayer({ current: h.map as never }, true, true, 20, -105, vi.fn(), undefined, s),
        );
        await waitFor(() => expect(h.sources.has('cyclone-models-src')).toBe(true));
        const fc = h.sources.get('cyclone-models-src')!.data as Fc;
        const lines = fc.features.filter((f) => f.geometry.type === 'LineString');
        expect(lines.map((f) => f.properties?.label).sort()).toEqual(['ECMWF', 'GFS']);
        const labels = fc.features.filter((f) => f.geometry.type === 'Point').map((f) => f.properties?.label);
        expect(labels).toEqual(['NHC official forecast']);
        const labelLayer = h.layers.get('cyclone-models-label') as unknown as { layout: Record<string, unknown> };
        expect(labelLayer.layout['text-field']).toEqual(['get', 'text']);
        // Along each line, so a crowded end cannot leave a line unnamed, each with its run time.
        expect(labelLayer.layout['symbol-placement']).toBe('line');
        expect(labelLayer.layout['symbol-sort-key']).toBeDefined();
        expect(lines.map((f) => f.properties?.text).sort()).toEqual(['ECMWF 13/00Z', 'GFS 13/06Z']);
        // The issuer's label has its own layer, placed first so the chart's own
        // labels yield to it. It no longer overlaps (129-13: it printed over a
        // place's name at zoom 2); it takes the first free of eight spots round
        // the track's end instead (tests/StormIssuerLabel.test.ts).
        const issuerLayer = h.layers.get('cyclone-issuer-label') as unknown as {
            layout: Record<string, unknown>;
            filter: unknown;
        };
        expect(issuerLayer.layout['text-allow-overlap']).not.toBe(true);
        expect(issuerLayer.layout['text-ignore-placement']).not.toBe(true);
        expect(issuerLayer.layout['text-variable-anchor']).toHaveLength(8);
        expect(issuerLayer.layout['text-radial-offset']).toBeGreaterThan(0);
        const ids = [...h.layers.keys()];
        expect(ids.indexOf('cyclone-issuer-label')).toBeGreaterThan(ids.indexOf('cyclone-models-label'));
        const issuerPoints = fc.features.filter((f) => f.properties?.issuer === true);
        expect(issuerPoints.map((f) => f.properties?.label)).toEqual(['NHC official forecast']);
        // With its advisory time on the chart, as every track carries.
        expect(issuerPoints[0].properties?.text).toMatch(/^NHC official forecast\n\d{1,2} \w{3} \d\d:\d\d UTC$/);
        const lineLayer = h.layers.get('cyclone-models-line') as unknown as { paint: Record<string, unknown> };
        expect(lineLayer.paint['line-width']).toBeLessThanOrEqual(1.5);
        await waitFor(() => expect(h.container.textContent).toContain('Forecast data: ECMWF'));
        // Direct from NOAA (129-09b): public domain, and still credited.
        expect(h.container.textContent).toContain('Track and cone: NHC (NOAA)');
        expect(h.container.textContent).not.toMatch(/Esri/);
        hook.unmount();
        expect(h.sources.has('cyclone-models-src')).toBe(false);
    });
});

describe('the card names the issuer, the advisory time and the official centre', () => {
    beforeEach(() => {
        mocks.fetch.mockReset();
        mocks.models.mockReset().mockReturnValue([]);
        mocks.status.mockReset().mockReturnValue(FEED_OK);
    });

    it('NHC: official, with its advisory number', async () => {
        const s = storm();
        mocks.fetch.mockResolvedValue([s]);
        const h = makeMap();
        const hook = renderHook(() =>
            useCycloneLayer({ current: h.map as never }, true, true, 20, -105, vi.fn(), undefined, s),
        );
        await waitFor(() => expect(h.container.querySelector('#cyclone-hud-badges')).not.toBeNull());
        const card = h.container.querySelector('#cyclone-hud-badges')!.textContent!;
        expect(card).toContain('NHC official forecast');
        expect(card).toContain('advisory 24A');
        hook.unmount();
    });

    it('JTWC in the Coral Sea: an advisory, with a link to the Bureau', async () => {
        const s = coralSea();
        mocks.fetch.mockResolvedValue([s]);
        const h = makeMap();
        const hook = renderHook(() =>
            useCycloneLayer({ current: h.map as never }, true, true, -27, 153, vi.fn(), undefined, s),
        );
        await waitFor(() => expect(h.container.querySelector('#cyclone-hud-badges')).not.toBeNull());
        const card = h.container.querySelector('#cyclone-hud-badges')!;
        expect(card.textContent).toContain('JTWC: US military advisory, not the official warning here');
        expect(card.textContent).toContain('Track: JTWC (US Navy)');
        expect(card.textContent).not.toMatch(/Esri/);
        const link = card.querySelector('a')!;
        expect(link.textContent).toContain('Bureau of Meteorology');
        expect(link.getAttribute('href')).toMatch(/^https:\/\/www\.bom\.gov\.au\//);
        expect(link.getAttribute('target')).toBe('_blank');
        hook.unmount();
    });

    it('an advisory more than 12 h old says when it was', async () => {
        const old = new Date(Date.now() - 14 * H).toISOString();
        const s = coralSea({ forecastBy: { by: 'JTWC', advisory: 'x', issued: old } });
        mocks.fetch.mockResolvedValue([s]);
        const h = makeMap();
        const hook = renderHook(() =>
            useCycloneLayer({ current: h.map as never }, true, true, -27, 153, vi.fn(), undefined, s),
        );
        await waitFor(() => expect(h.container.querySelector('#cyclone-hud-badges')).not.toBeNull());
        expect(h.container.querySelector('#cyclone-hud-badges')!.textContent).toMatch(
            /Last advisory \d{1,2} \w{3} \d\d:\d\d UTC/,
        );
        hook.unmount();
    });
});

describe('a dead feed is never an all-clear', () => {
    beforeEach(() => {
        mocks.fetch.mockReset();
        mocks.models.mockReset().mockReturnValue([]);
    });

    it('says "Cyclone data unavailable since" with no storms to show', async () => {
        mocks.status.mockReset().mockReturnValue({ ...FEED_OK, unavailableSince: Date.parse('2026-10-14T03:10:00Z') });
        mocks.fetch.mockResolvedValue([]);
        const h = makeMap();
        const hook = renderHook(() => useCycloneLayer({ current: h.map as never }, true, true, -27, 153, vi.fn()));
        await waitFor(() =>
            expect(h.container.querySelector('#cyclone-feed-status')?.textContent).toBe(
                'Cyclone data unavailable since 14 Oct 03:10 UTC',
            ),
        );
        expect(h.container.textContent).not.toMatch(/no (active )?(cyclones|storms)|all clear/i);
        hook.unmount();
        expect(h.container.querySelector('#cyclone-feed-status')).toBeNull();
    });

    it('a forecast feed that failed is said, never "no forecast track from the warning centre"', async () => {
        mocks.status.mockReset().mockReturnValue({
            unavailableSince: null,
            forecastUnavailableSince: Date.parse('2026-10-14T03:10:00Z'),
            coneUnavailableSince: null,
        });
        const s = storm({ forecastBy: undefined, issuer: undefined, forecastTrack: [], cone: undefined });
        delete (s as Partial<ActiveCyclone>).issuer;
        mocks.fetch.mockResolvedValue([s]);
        const h = makeMap();
        const hook = renderHook(() =>
            useCycloneLayer({ current: h.map as never }, true, true, 20, -105, vi.fn(), undefined, s),
        );
        await waitFor(() => expect(h.container.querySelector('#cyclone-hud-badges')).not.toBeNull());
        const card = h.container.querySelector('#cyclone-hud-badges')!.textContent!;
        expect(card).toContain('Forecast track unavailable since 14 Oct 03:10 UTC');
        expect(card).not.toContain('No forecast track from the warning centre');
        expect(h.container.querySelector('#cyclone-feed-status')?.textContent).toBe(
            'Forecast track unavailable since 14 Oct 03:10 UTC',
        );
        hook.unmount();
    });

    it('shows nothing extra when the feed answered', async () => {
        mocks.status.mockReset().mockReturnValue(FEED_OK);
        mocks.fetch.mockResolvedValue([]);
        const h = makeMap();
        const closest = vi.fn();
        const hook = renderHook(() => useCycloneLayer({ current: h.map as never }, true, true, -27, 153, closest));
        await waitFor(() => expect(closest).toHaveBeenCalledWith(null));
        expect(h.container.querySelector('#cyclone-feed-status')).toBeNull();
        hook.unmount();
    });

    it('credits each centre as its own: CPHC’s cone, JTWC’s danger area, and a bare position’s source', async () => {
        const cases: [ActiveCyclone, string][] = [
            [
                storm({
                    sid: 'cp032026',
                    name: 'ZZNOA',
                    basin: 'C',
                    currentPosition: {
                        lat: 16.5,
                        lon: -155,
                        time: new Date().toISOString(),
                        windKts: 70,
                        pressureMb: 975,
                    },
                    forecastBy: { by: 'CPHC', advisory: '12', issued: new Date().toISOString() },
                }),
                'Track and cone: CPHC (NOAA)',
            ],
            [
                coralSea({
                    cone: {
                        type: 'Polygon',
                        coordinates: [
                            [
                                [153, -15],
                                [151, -18],
                                [152.5, -19.5],
                                [153, -15],
                            ],
                        ],
                    },
                }),
                'Track and danger area: JTWC (US Navy)',
            ],
            [coralSea({ forecastBy: undefined, forecastTrack: [], positionBy: 'JTWC' }), 'Position: JTWC (US Navy)'],
        ];
        for (const [s, credit] of cases) {
            if (!s.forecastBy) delete (s as Partial<ActiveCyclone>).issuer;
            mocks.fetch.mockResolvedValue([s]);
            const h = makeMap();
            const hook = renderHook(() =>
                useCycloneLayer({ current: h.map as never }, true, true, -27, 153, vi.fn(), undefined, s),
            );
            await waitFor(() => expect(h.container.querySelector('#cyclone-hud-badges')).not.toBeNull());
            expect(h.container.querySelector('#cyclone-hud-badges')!.textContent).toContain(credit);
            hook.unmount();
        }
    });

    it('a storm list that did not answer is said by name, with the others still drawn', async () => {
        mocks.status.mockReset().mockReturnValue({
            ...FEED_OK,
            sourcesUnavailable: [
                { source: 'JTWC', since: Date.parse('2026-10-14T03:10:00Z') },
                { source: 'NCEP storm vitals', since: Date.parse('2026-10-14T04:00:00Z') },
            ],
        } as never);
        mocks.fetch.mockResolvedValue([storm()]);
        const h = makeMap();
        const hook = renderHook(() => useCycloneLayer({ current: h.map as never }, true, true, 20, -105, vi.fn()));
        await waitFor(() =>
            expect(h.container.querySelector('#cyclone-feed-status')?.textContent).toBe(
                'Partial cyclone data: JTWC, NCEP storm vitals unavailable since 14 Oct 03:10 UTC',
            ),
        );
        hook.unmount();
    });

    it('a missing storm list is said first, and a failed cone under it, never hidden by it', async () => {
        mocks.status.mockReset().mockReturnValue({
            unavailableSince: null,
            forecastUnavailableSince: null,
            coneUnavailableSince: Date.parse('2026-10-14T04:00:00Z'),
            sourcesUnavailable: [
                { source: 'JTWC', since: Date.parse('2026-10-14T03:10:00Z') },
                { source: 'NCEP storm vitals', since: Date.parse('2026-10-14T03:10:00Z') },
            ],
        } as never);
        mocks.fetch.mockResolvedValue([storm()]);
        const h = makeMap();
        const hook = renderHook(() => useCycloneLayer({ current: h.map as never }, true, true, -17, 150, vi.fn()));
        await waitFor(() =>
            expect(h.container.querySelector('#cyclone-feed-status')?.textContent).toBe(
                'Partial cyclone data: JTWC, NCEP storm vitals unavailable since 14 Oct 03:10 UTC\n' +
                    'Forecast cone unavailable since 14 Oct 04:00 UTC',
            ),
        );
        // Two lines that fit a phone: wrapped inside the chart, never cut off its edges.
        const el = h.container.querySelector<HTMLElement>('#cyclone-feed-status')!;
        expect(el.style.whiteSpace).toBe('pre-line');
        expect(el.style.maxWidth).toBe('calc(100% - 32px)');
        hook.unmount();
    });
});

describe('the issuer label keeps clear of the place pin’s name (129-13)', () => {
    it('orders its spots so the first is off the HTML pin Mapbox cannot see', async () => {
        mocks.status.mockReturnValue(FEED_OK);
        mocks.models.mockReset().mockReturnValue([]);
        const s = storm();
        mocks.fetch.mockResolvedValue([s]);
        const h = makeMap();
        // The chosen place's pin and its name, just right of the track's end
        // (this mock projects a point to x = lon, y = lat: the end is at -113.6, 23.6).
        const pin = document.createElement('button');
        pin.className = 'obs-place-pin';
        const chip = document.createElement('span');
        chip.className = 'obs-place-pin__label';
        chip.textContent = 'Puerto Ficticio';
        pin.append(chip);
        h.container.append(pin);
        const rect = (left: number, top: number, right: number, bottom: number) =>
            ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top }) as DOMRect;
        h.container.getBoundingClientRect = () => rect(0, 0, 0, 0);
        pin.getBoundingClientRect = () => rect(-100, 26, -80, 60);
        chip.getBoundingClientRect = () => rect(-110, 15, -40, 35);
        const hook = renderHook(() =>
            useCycloneLayer({ current: h.map as never }, true, true, 20, -105, vi.fn(), undefined, s),
        );
        await waitFor(() => expect(h.layers.has('cyclone-issuer-label')).toBe(true));
        const layout = (h.layers.get('cyclone-issuer-label') as unknown as { layout: Record<string, unknown> }).layout;
        await waitFor(() => expect((layout['text-variable-anchor'] as string[])[0]).toBe('right'));
        expect(layout['text-variable-anchor']).toHaveLength(8);
        hook.unmount();
    });
});
