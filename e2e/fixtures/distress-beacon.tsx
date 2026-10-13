/**
 * Distress beacons, rendered for real (build 125, package 125-02):
 *
 *  - (default) the app-wide card stack (components/map/AisGuardAlert.tsx): a
 *    sounding AIS-SART, a man-overboard beacon with no position yet, an
 *    internet-relayed EPIRB-AIS, a caution, and a collision card under them;
 *  - ?view=goto (&fix=none, &mob=off): Go to it, the Man Overboard page's
 *    beacon view (components/vessel/DistressGoToView.tsx), with her own MOB
 *    mark also active (Back to your MOB) or not (MOB, mark position); with or
 *    without a fix of our own;
 *  - ?view=map: the IEC 62288 symbol drawn by the chart's own canvas code
 *    (components/map/aisDistressSymbol.ts) and placed by the real Mapbox
 *    engine with the chart's own icon expressions, the features dressed by
 *    the chart's own targetPresentation. window.__distress.read() reports
 *    placement and pixels.
 *
 * The app's CSS and the real stores; the tab bar's real geometry. No network
 * but the map engine's own. Fictional MMSIs only, in the Bay of Biscay.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV)
    throw new Error('The distress-beacon fixture is available only through the development server.');

class FixtureStorage implements Storage {
    private entries = new Map<string, string>();
    get length() {
        return this.entries.size;
    }
    clear() {
        this.entries.clear();
    }
    getItem(key: string) {
        return this.entries.get(String(key)) ?? null;
    }
    key(index: number) {
        return [...this.entries.keys()][index] ?? null;
    }
    removeItem(key: string) {
        this.entries.delete(String(key));
    }
    setItem(key: string, value: string) {
        this.entries.set(String(key), String(value));
    }
}
Object.defineProperty(window, 'localStorage', { configurable: true, value: new FixtureStorage() });
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: new FixtureStorage() });

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'cards';
if (view !== 'map') {
    window.fetch = async () =>
        new Response(JSON.stringify({ error: 'Distress fixture: network disabled.' }), { status: 503 });
}
// Verdana on a Mac, DejaVu Sans on the Linux runner: the same wraps on both.
if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent =
        ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; } body, button { font-family: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}

const now = Date.now();
const OWN = { lat: 45.5, lon: -5.2 };

function TabBar() {
    // The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row above
    // the home-indicator inset, opaque.
    return (
        <nav
            aria-label="Main"
            className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
            style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
        >
            <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
                <span>THE GLASS</span>
                <span className="text-sky-300">OBS</span>
                <span>PLAN</span>
                <span>VESSEL</span>
            </div>
        </nav>
    );
}

async function cards() {
    const [{ AisGuardAlert }, { AisGuardAlertStore }] = await Promise.all([
        import('../../components/map/AisGuardAlert'),
        import('../../services/aisGuardAlertStore'),
    ]);
    AisGuardAlertStore.setCollision(
        [
            {
                mmsi: 123_400_610,
                name: 'FICTIONAL TRADER',
                distanceNm: 1.4,
                bearing: 44,
                sog: 11.5,
                cog: 230,
                shipType: '70',
                timestamp: now,
                collision: { cpaNm: 0.2, tcpaMin: 7.5, closeQuarters: false, reportAgeSec: 12, source: 'local' },
            },
        ],
        now,
    );
    AisGuardAlertStore.setDistress(
        [
            {
                mmsi: 970_000_611,
                name: '',
                kind: 'sart',
                state: 'active',
                source: 'local',
                sounds: true,
                lat: 45.52,
                lon: -5.17,
                heardAt: now - 12_000,
                rangeNm: 1.83,
                bearingDeg: 44,
            },
            {
                mmsi: 972_000_612,
                name: '',
                kind: 'mob',
                state: 'active',
                source: 'local',
                sounds: true,
                lat: null,
                lon: null,
                heardAt: now - 4_000,
                rangeNm: null,
                bearingDeg: null,
            },
            {
                mmsi: 974_000_613,
                name: 'FICTIONAL EPIRB OF A LONG-NAMED YACHT',
                kind: 'epirb',
                state: 'active',
                source: 'cloud',
                sounds: false,
                lat: 46.1,
                lon: -5.0,
                heardAt: now - 6 * 60_000,
                rangeNm: 37.1,
                bearingDeg: 13,
            },
            {
                mmsi: 972_000_614,
                name: '',
                kind: 'mob',
                state: 'caution',
                source: 'local',
                sounds: false,
                lat: 45.49,
                lon: -5.21,
                heardAt: now - 95 * 60_000,
                rangeNm: 0.73,
                bearingDeg: 214,
            },
        ],
        now,
    );
    createRoot(document.getElementById('root')!).render(
        <main className="min-h-screen bg-slate-950 p-4 text-white">
            <h1 className="text-lg font-bold">Chart</h1>
            <AisGuardAlert />
            <TabBar />
        </main>,
    );
}

async function goto() {
    const [{ DistressGoToView }, { AisGuardAlertStore }] = await Promise.all([
        import('../../components/vessel/DistressGoToView'),
        import('../../services/aisGuardAlertStore'),
    ]);
    AisGuardAlertStore.setDistress(
        [
            {
                mmsi: 972_000_621,
                name: 'FICTIONAL CREW BEACON',
                kind: 'mob',
                state: 'active',
                source: 'local',
                sounds: true,
                lat: 45.507,
                lon: -5.188,
                heardAt: now - 7_000,
                rangeNm: 0.65,
                bearingDeg: 50,
            },
        ],
        now,
    );
    AisGuardAlertStore.goToDistress(972_000_621);
    const fix = params.get('fix') !== 'none';
    const radio = {
        position: fix
            ? {
                  latitude: OWN.lat,
                  longitude: OWN.lon,
                  timestamp: now,
                  source: 'bus' as const,
                  sourceLabel: 'Boat GPS',
                  isVessel: true,
                  speed: null,
                  heading: null,
                  accuracy: null,
              }
            : null,
        ageMs: fix ? 1_000 : null,
        isLive: fix,
        isFresh: fix,
        acquiring: false,
        refreshing: false,
        error: false,
        refresh: async () => undefined,
        requestGpsAccess: async () => undefined,
    };
    createRoot(document.getElementById('root')!).render(
        <div className="fixed inset-0 bg-slate-950 text-white">
            <DistressGoToView
                mmsi={972_000_621}
                radio={radio}
                mobActive={params.get('mob') !== 'off'}
                onOwnMob={() => undefined}
                onBack={() => undefined}
                breadcrumbs={['Obs', 'Man Overboard']}
            />
            <TabBar />
        </div>,
    );
}

async function map() {
    const [{ default: mapboxgl }, symbol, palette, { targetPresentation }] = await Promise.all([
        import('mapbox-gl'),
        import('../../components/map/aisDistressSymbol'),
        import('../../components/map/aisPresentationPalette'),
        import('../../components/map/useAisStreamLayer'),
    ]);
    await import('mapbox-gl/dist/mapbox-gl.css');
    const container = document.createElement('div');
    container.id = 'map';
    document.body.append(container);
    const token = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
        ?.VITE_MAPBOX_ACCESS_TOKEN;
    if (token) mapboxgl.accessToken = token;
    const ZOOM = 14;
    const m = new mapboxgl.Map({
        container,
        style: {
            version: 8,
            sources: {},
            layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1220' } }],
        },
        center: [OWN.lon, OWN.lat],
        zoom: ZOOM,
        fadeDuration: 0,
        attributionControl: false,
        preserveDrawingBuffer: true,
        testMode: true,
    } as mapboxgl.MapOptions);

    // Screen offsets (CSS px from the centre) of each beacon.
    const BEACONS = [
        { mmsi: 970_000_601, dx: 0, props: { navStatus: 14, safetyText: 'SART ACTIVE' } },
        { mmsi: 970_000_602, dx: -110, props: { navStatus: 15, safetyText: 'SART TEST' } },
        { mmsi: 972_000_603, dx: 110, props: { navStatus: 0 } },
    ];

    /** The pixel `dy` CSS px from a beacon's centre on the map canvas. */
    function probe(dx: number, dy: number): [number, number, number, number] {
        const c = m.project(m.getCenter());
        const dpr = window.devicePixelRatio || 1;
        const src = m.getCanvas();
        const copy = document.createElement('canvas');
        copy.width = src.width;
        copy.height = src.height;
        const ctx = copy.getContext('2d')!;
        ctx.drawImage(src, 0, 0);
        const d = ctx.getImageData(Math.round((c.x + dx) * dpr), Math.round((c.y + dy) * dpr), 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
    }

    /** The registered image, tinted the way the chart tints it, on a plain canvas. */
    function canvasProbes(): Record<string, [number, number, number, number]> {
        const px = symbol.AIS_DISTRESS_ICON_PX;
        const canvas = document.createElement('canvas');
        canvas.width = px;
        canvas.height = px;
        const ctx = canvas.getContext('2d')!;
        symbol.drawAisDistressSymbol(ctx, px);
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = palette.AIS_DISTRESS_COLOR;
        ctx.fillRect(0, 0, px, px);
        const g = symbol.AIS_DISTRESS_GEOMETRY;
        const at = (x: number, y: number) => {
            const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
            return [d[0], d[1], d[2], d[3]] as [number, number, number, number];
        };
        const c = px / 2;
        return {
            centre: at(c, c),
            ringTop: at(c, c - g.ringRadius * px),
            armNe: at(c + g.armReach * px * 0.6, c - g.armReach * px * 0.6),
            betweenArms: at(c, c - g.ringRadius * px * 0.5),
            outside: at(1, 1),
        };
    }

    const idle = () =>
        new Promise<void>((resolve) => {
            m.once('idle', () => resolve());
            m.triggerRepaint();
        });

    let loaded = false;
    m.on('load', () => {
        symbol.registerAisDistressSymbol(m);
        const c = m.project(m.getCenter());
        const features = BEACONS.map(({ mmsi, dx, props }) => {
            const ll = m.unproject([c.x + dx, c.y]);
            const properties: Record<string, unknown> = {
                mmsi,
                ...props,
                source: 'local',
                lastUpdated: now - 5_000,
                safetyTextAt: now - 4_000,
                staleMinutes: 0.1,
            };
            Object.assign(properties, targetPresentation(properties));
            return {
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: [ll.lng, ll.lat] },
                properties,
            };
        });
        m.addSource('ais-targets', { type: 'geojson', data: { type: 'FeatureCollection', features } });
        // The chart's own AIS target layers (components/map/aisDistressSymbol.ts, as useMapInit adds them).
        for (const layer of symbol.AIS_TARGET_ICON_LAYERS) m.addLayer(layer as unknown as mapboxgl.AnyLayer);
        loaded = true;
    });

    async function read() {
        for (let i = 0; i < 150 && !loaded; i++) await new Promise((r) => setTimeout(r, 100));
        await idle();
        await idle();
        // The icon at z14 is the image at icon-size 0.8: CSS px from the centre.
        const scale = 0.8 * symbol.AIS_DISTRESS_ICON_PX;
        const g = symbol.AIS_DISTRESS_GEOMETRY;
        const background = probe(0, -200);
        return {
            placed: m
                .queryRenderedFeatures(undefined as unknown as mapboxgl.PointLike, {
                    layers: ['ais-targets-circle', symbol.AIS_SART_LAYER],
                })
                .map((f) => ({ mmsi: Number(f.properties?.mmsi), iconKind: String(f.properties?.iconKind) })),
            hasImage: m.hasImage(symbol.AIS_DISTRESS_ICON),
            painted: background[3] > 0,
            map: {
                centre: probe(0, 0),
                ringTop: probe(0, -g.ringRadius * scale),
                betweenArms: probe(0, -g.ringRadius * scale * 0.5),
                testCentre: probe(-110, 0),
            },
            canvas: canvasProbes(),
        };
    }
    (window as unknown as { __distress: { read: typeof read } }).__distress = { read };
}

if (view === 'goto') void goto();
else if (view === 'map') void map();
else void cards();
