// The own-ship boat on an Obs-sized chart: real Mapbox projection, the
// production marker DOM and its painters, the real status words, the real
// position message chip. Synthetic bases and a fictional boat; no tiles, GPS,
// location permission, credentials or network.
//
// Mapbox draws nothing without its session check (no token here, no
// network), so the bases are painted on a plain canvas UNDER the transparent
// map, placed through the map's own projection; the marker is a real Mapbox
// marker on top, exactly as in the app.
//
// Query: base=plain|relief|sat, theme=dark|light|night, state (see STATES, or
// 'current': the box on Current Location, the phone's mark at the centre;
// phone=last draws it as a last known fix),
// route=1 (the 'Whole route' button and the held-position message under it),
// bearing=<deg>, name=<boat>, wind=<kt>[@<from deg>][~] (her own wind on her
// icon, W1-WC; '~' = the stale tier), unit=kts|kmh|mph|mps, furniture=1 (the
// real right-rail zoom control and Locate row, MapActionFabs).
//
// state=place (126-18): a place chosen in the location box, its production
// gold pin (obsPlacePin.createPlacePinElement) at the chart's centre at z10,
// the boat and the phone drawn where they are. place=<name> names it
// (fictional), overlap=1 puts it 300 m from the boat, notice=1 stands the
// boat's "No position" message, popup=1 opens a weather-bubble-sized popup
// over the place, and with furniture=1 Locate draws the pin and answers a
// tap with the place's label.
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
    createVesselElement,
    OWNSHIP_MARKER_OPTIONS,
    presentOwnshipDirection,
    presentOwnshipStatus,
    presentOwnshipWind,
} from '../../components/map/useVesselTracker';
import { boatWindChipFor } from '../../components/map/boatWindReadout';
import { MapActionFabs } from '../../components/map/MapActionFabs';
import {
    ownshipStatus,
    type OwnshipAnchorSources,
    type OwnshipMarkerIdentity,
} from '../../components/map/ownshipStatus';
import { resolveOwnshipDirection, type DirectionInstruments } from '../../components/map/ownshipDirection';
import { gpsFixState } from '../../components/gpsFixState';
import { ObsCentreNoticeChip } from '../../components/map/ObsCentreNoticeChip';
import { showObsCentreNotice } from '../../components/map/obsCentre';
import { createPhoneMarkerElement } from '../../components/map/phoneMarker';
import { createPlacePinElement, placePinPoint } from '../../components/map/obsPlacePin';

const params = new URLSearchParams(location.search);
const base = params.get('base') ?? 'plain';
const theme = params.get('theme') ?? 'dark';
const stateName = params.get('state') ?? 'stopped';
const route = params.get('route') === '1';
const bearing = Number(params.get('bearing') ?? 0) || 0;
const boatName = params.get('name') ?? 'Kittiwake';
const windParam = params.get('wind');
const windUnit = params.get('unit') ?? 'kts';
const furniture = params.get('furniture') === '1';

/** A fictional boat in a fictional marina, and the skipper's phone far from her. */
const BOAT: [number, number] = [148.72, -20.27];
const HOME: [number, number] = [153.1, -27.2];
const current = stateName === 'current';
const phoneLast = current && params.get('phone') === 'last';
/** A place chosen in the box: ~10 km west of her on the synthetic coast, or 300 m south of her (overlap=1). */
const placeScene = stateName === 'place';
const placeName = params.get('place') ?? 'Port Kittiwake';
const overlap = params.get('overlap') === '1';
const PLACE: [number, number] = overlap ? [BOAT[0], BOAT[1] - 300 / 111_195] : [148.625, -20.3];
const NOW = Date.now();
const HOUR = 3_600_000;
const MS_PER_KT = 1 / 1.94384;

interface Scene {
    lane: OwnshipMarkerIdentity['lane'];
    /** Age of her fix. */
    ageMs: number;
    sogKts: number | null;
    cogDeg?: number;
    headingDeg?: number;
    /** pi-lost: the Pi's watch has lost contact; pi-expiring: its authorisation is running out. */
    anchor?: 'pi' | 'pi-drag' | 'pi-lost' | 'pi-expiring' | 'phone-drift';
}

const STATES: Record<string, Scene> = {
    stopped: { lane: 'cloud', ageMs: 5_000, sogKts: 0.1 },
    underway: { lane: 'cloud', ageMs: 4_000, sogKts: 6.2, cogDeg: 135 },
    heading: { lane: 'cloud', ageMs: 4_000, sogKts: 0, headingDeg: 212 },
    anchored: { lane: 'cloud', ageMs: 5_000, sogKts: 0, anchor: 'pi' },
    'anchored-stale': { lane: 'cloud', ageMs: 75_000, sogKts: 0, anchor: 'pi' },
    'anchored-nodata': { lane: 'cloud', ageMs: 5_000, sogKts: 0, anchor: 'pi-lost' },
    'anchored-expiring': { lane: 'cloud', ageMs: 5_000, sogKts: 0, anchor: 'pi-expiring' },
    alarm: { lane: 'cloud', ageMs: 5_000, sogKts: 0.8, anchor: 'pi-drag' },
    drifting: { lane: 'bus', ageMs: 1_000, sogKts: 0.6, anchor: 'phone-drift' },
    held: { lane: 'held', ageMs: 3 * HOUR, sogKts: null },
};
const scene = STATES[stateName] ?? STATES.stopped;
const pinPoint = placeScene
    ? placePinPoint({ defaultLocation: placeName, defaultLocationCoords: { lat: PLACE[1], lon: PLACE[0] } })
    : null;

// ── The page, as the app paints it ──
if (theme === 'light') document.documentElement.classList.add('display-light');
document.body.style.cssText = `margin:0;overflow:hidden;background:${theme === 'light' ? '#e2e8f0' : '#020617'};`;
const root = document.getElementById('root')!;
// Obs is the full screen; the tab bar floats over its foot (measured on the real app).
root.style.cssText = 'position:fixed;inset:0;';
root.innerHTML =
    '<div id="pane" class="relative w-full h-full"><canvas id="base" style="position:absolute;inset:0;width:100%;height:100%"></canvas><div id="map" style="position:absolute;inset:0"></div><div id="overlay" style="position:absolute;inset:0;pointer-events:none"></div></div>';

// ── Synthetic bases: a dark plain chart, a light relief, and satellite-like imagery ──
const ring = (points: Array<[number, number]>) => [...points, points[0]];
const land = ring([
    [148.6, -20.2],
    [148.7105, -20.2],
    [148.7108, -20.2655],
    [148.7128, -20.2745],
    [148.74, -20.279],
    [148.74, -20.36],
    [148.6, -20.36],
]);
const hill = ring([
    [148.68, -20.24],
    [148.703, -20.245],
    [148.705, -20.268],
    [148.69, -20.28],
    [148.675, -20.262],
]);
const breakwater = ring([
    [148.7112, -20.2652],
    [148.7215, -20.2625],
    [148.7218, -20.2632],
    [148.7115, -20.266],
]);
/** Paint the synthetic base under the map, in screen space, through the map's projection. */
function paintBase(map: mapboxgl.Map): void {
    const canvas = document.getElementById('base') as HTMLCanvasElement;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const path = (points: Array<[number, number]>) => {
        ctx.beginPath();
        points.forEach((lngLat, i) => {
            const { x, y } = map.project(lngLat);
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
        });
        ctx.closePath();
    };
    const palette =
        base === 'relief'
            ? { sea: '#b9d6e8', land: '#efe8d4', hill: '#dccfae', wall: '#9aa3a8' }
            : { sea: '#0d2741', land: '#1f2a37', hill: '#273444', wall: '#475569' };
    if (base !== 'sat') {
        ctx.fillStyle = palette.sea;
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = palette.land;
        path(land);
        ctx.fill();
        ctx.fillStyle = palette.hill;
        path(hill);
        ctx.fill();
        ctx.fillStyle = palette.wall;
        path(breakwater);
        ctx.fill();
        if (base === 'relief') {
            // Contour hairlines and soft hill shading, as a relief base draws them.
            ctx.strokeStyle = 'rgba(140, 120, 80, 0.35)';
            ctx.lineWidth = 1;
            for (let i = 1; i <= 4; i++) {
                const k = 1 - i * 0.18;
                const c = map.project([148.69, -20.262]);
                ctx.beginPath();
                ctx.ellipse(c.x, c.y, 150 * k, 110 * k, -0.4, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        return;
    }
    // Satellite-like: textured water, reef flats, scrubby land, surf, moored hulls.
    ctx.fillStyle = '#123f52';
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 2600; i++) {
        const shade = 40 + rand() * 50;
        ctx.fillStyle = `rgba(${shade * 0.3}, ${shade + 30}, ${shade + 60}, 0.18)`;
        ctx.fillRect(rand() * width, rand() * height, 4 + rand() * 20, 3 + rand() * 12);
    }
    ctx.fillStyle = 'rgba(64, 196, 190, 0.45)';
    const reef = map.project([148.735, -20.258]);
    ctx.beginPath();
    ctx.ellipse(reef.x, reef.y, 90, 30, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    path(land);
    ctx.clip();
    ctx.fillStyle = '#4b5d33';
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 2400; i++) {
        ctx.fillStyle = rand() > 0.5 ? 'rgba(122, 108, 66, 0.55)' : 'rgba(46, 74, 34, 0.6)';
        ctx.fillRect(rand() * width, rand() * height, 2 + rand() * 9, 2 + rand() * 7);
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(236, 240, 228, 0.8)';
    ctx.lineWidth = 2;
    path(land);
    ctx.stroke();
    ctx.fillStyle = '#8f9496';
    path(breakwater);
    ctx.fill();
    // Moored hulls: bright specks, the hardest company for a white edge.
    const marina = map.project([148.7118, -20.2662]);
    for (let i = 0; i < 70; i++) {
        ctx.fillStyle = 'rgba(245, 248, 250, 0.92)';
        ctx.fillRect(marina.x + rand() * 60, marina.y + rand() * 50, 4, 2);
    }
}

const map = new mapboxgl.Map({
    container: 'map',
    center: placeScene ? PLACE : current ? HOME : BOAT,
    // Obs opens a chosen place at z10 (OBS_PLACE_ZOOM).
    zoom: placeScene ? 10 : 15,
    bearing,
    attributionControl: false,
    testMode: true,
    fadeDuration: 0,
    style: { version: 8, sources: {}, layers: [] },
});

// ── The boat, painted by the production painters from the real words ──
const fixAt = NOW - scene.ageMs;
const reading = (value: number | undefined | null, at: number) =>
    value === undefined || value === null ? undefined : { value, lastUpdated: at, freshness: 'live' };
const instruments: DirectionInstruments = {
    headingTrue: reading(scene.headingDeg, fixAt),
    sog: reading(scene.sogKts, fixAt),
    cog: reading(scene.cogDeg, fixAt),
};
const position = {
    latitude: BOAT[1],
    longitude: BOAT[0],
    speed: scene.sogKts === null ? null : scene.sogKts * MS_PER_KT,
    timestamp: fixAt,
    heading: null,
};
const identity: OwnshipMarkerIdentity = { owner: 'own', lane: scene.lane };
const watchReport = {
    type: 'position' as const,
    vessel: { latitude: BOAT[1], longitude: BOAT[0], accuracy: 5, heading: 0, speed: 0, timestamp: NOW - 2_000 },
    anchor: { latitude: BOAT[1] + 0.0002, longitude: BOAT[0], timestamp: NOW - HOUR },
    distance: scene.anchor === 'pi-drag' ? 72 : 21,
    swingRadius: 40,
    isAlarm: scene.anchor === 'pi-drag',
    timestamp: NOW - 2_000,
};
const piWatch = scene.anchor !== undefined && scene.anchor.startsWith('pi');
const anchor: OwnshipAnchorSources = {
    local:
        scene.anchor === 'phone-drift'
            ? {
                  state: 'watching',
                  gpsSource: 'nmea',
                  distanceFromAnchor: 52,
                  swingRadius: 40,
                  alarmTriggeredAt: null,
                  alarmCause: null,
                  vesselPosition: { latitude: BOAT[1], longitude: BOAT[0] },
              }
            : {
                  state: 'idle',
                  gpsSource: null,
                  distanceFromAnchor: 0,
                  swingRadius: 0,
                  alarmTriggeredAt: null,
                  alarmCause: null,
              },
    shore: piWatch
        ? {
              sessionCode: 'PI-WATCH',
              position: watchReport,
              stale: false,
              cause:
                  scene.anchor === 'pi-drag'
                      ? 'drag'
                      : scene.anchor === 'pi-lost'
                        ? 'contact-lost'
                        : scene.anchor === 'pi-expiring'
                          ? 'session-expiring'
                          : null,
              lastContactAt: NOW - 2_000,
          }
        : { sessionCode: null, position: null, stale: true, cause: null, lastContactAt: null },
    piSessionCode: piWatch ? 'PI-WATCH' : null,
};
const gate = scene.lane === 'held' ? -1 : scene.lane === 'bus' ? 13_000 : 60_000;
const fix = gpsFixState(fixAt, gate, NOW);
const status = ownshipStatus(position, identity, anchor, NOW, fix);
const direction =
    scene.lane === 'held'
        ? ({ degrees: null, source: 'unknown' } as const)
        : resolveOwnshipDirection(position, true, instruments, NOW, gate);

const el = createVesselElement();
el.dataset.source = 'vessel';
el.dataset.lane = scene.lane;
const spokenStatus = presentOwnshipStatus(el, status, fix);
const spokenDirection = presentOwnshipDirection(el, direction, map.getBearing());
// Her own wind, as the overlay publishes it while the field shows the model.
let spokenWind = '';
if (windParam) {
    const [kt, from] = windParam.replace(/~$/, '').split('@');
    const wind = { kt: Number(kt), fromDeg: from === undefined ? null : Number(from), stale: windParam.endsWith('~') };
    spokenWind = presentOwnshipWind(
        el,
        boatWindChipFor(
            { wind, boat: { crewOwnerId: null }, fieldShowsHers: false },
            { kind: 'boat', crewOwnerId: null },
            windUnit,
        ),
        map.getBearing(),
    );
}
el.setAttribute('role', 'img');
el.setAttribute('aria-label', `${boatName}, ${spokenStatus}; ${spokenDirection}${spokenWind ? `; ${spokenWind}` : ''}`);
// The production marker's own options: upright on screen however the chart is turned (127-11a).
new mapboxgl.Marker({ element: el, ...OWNSHIP_MARKER_OPTIONS }).setLngLat(BOAT).addTo(map);

// ── Current Location: the phone's own dot where the chart centres (useLocationDot) ──
// With a place chosen it is drawn too, where the phone is (126-18).
if (current || placeScene) {
    const dot = createPhoneMarkerElement();
    dot.classList.toggle('loc-dot--last', phoneLast);
    dot.setAttribute('aria-label', phoneLast ? 'Your phone, last fix 2 h ago' : 'Your phone');
    new mapboxgl.Marker({ element: dot, anchor: 'center' }).setLngLat(HOME).addTo(map);
}

// ── A chosen place: its gold pin, tip on the place (useObsPlacePin) ──
if (pinPoint) {
    const pinEl = createPlacePinElement(pinPoint.name);
    new mapboxgl.Marker({ element: pinEl, anchor: 'bottom' }).setLngLat([pinPoint.lon, pinPoint.drawLat]).addTo(map);
    if (params.get('popup') === '1') {
        // A weather bubble's stacking (.weather-inspect-popup), solid so a pixel says whose it is.
        const card = document.createElement('div');
        card.style.cssText = 'width:160px;height:110px;background:#ff00c8;';
        new mapboxgl.Popup({
            closeButton: false,
            closeOnClick: false,
            className: 'weather-inspect-popup',
            anchor: 'center',
        })
            .setLngLat([pinPoint.lon, pinPoint.drawLat])
            .setDOMContent(card)
            .addTo(map);
    }
}
(window as unknown as { __ownship: unknown }).__ownship = {
    /** Where the place projects on the canvas, in viewport pixels (the map fills the viewport). */
    placePx: () => (pinPoint ? map.project([pinPoint.lon, pinPoint.drawLat]) : null),
    boatPx: () => map.project(BOAT),
};

// ── The held position's message, under the 'Whole route' button ──
const overlay = document.getElementById('overlay')!;
if (route) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
        'thalassa-passage-overview absolute z-700 min-h-11 rounded-xl border border-purple-300/40 bg-slate-950/95 px-3 py-2 text-xs font-bold text-purple-100 shadow-lg backdrop-blur-xl';
    button.style.cssText = 'top: calc(env(safe-area-inset-top) + 112px); left: 12px; max-width: calc(100% - 100px);';
    button.textContent = 'Whole route';
    overlay.appendChild(button);
}
if (route || scene.lane === 'held') {
    showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'held', at: fixAt });
}
if (placeScene && params.get('notice') === '1') {
    showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'none', at: null });
}
if (furniture) {
    // The real right-rail zoom control and Locate row, where Obs puts them.
    const fabHost = document.createElement('div');
    fabHost.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    overlay.appendChild(fabHost);
    createRoot(fabHost).render(
        placeScene ? (
            // Locate's next stop is the place; a tap answers as locatePlace does, with its label.
            <MapActionFabs
                onLocateMe={async () => ({
                    centred: true,
                    announcement: `Chart centred on ${placeName}.`,
                    label: placeName,
                })}
                onRecenter={() => {}}
                recenterDisabled
                target="place"
                placeName={placeName}
            />
        ) : (
            <MapActionFabs
                onLocateMe={() => {}}
                onRecenter={() => {}}
                recenterDisabled
                target={current ? 'phone' : 'boat'}
            />
        ),
    );
}
const chipHost = document.createElement('div');
chipHost.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
overlay.appendChild(chipHost);
createRoot(chipHost).render(
    <ObsCentreNoticeChip visible names={{ own: boatName, crew: null }} belowRouteButton={route} />,
);

if (theme === 'night') {
    // App.tsx's night scrim, over everything.
    const scrim = document.createElement('div');
    scrim.style.cssText =
        'position:fixed;inset:0;pointer-events:none;background-color:rgba(69, 10, 10, 0.25);z-index:2147482000;';
    document.body.appendChild(scrim);
}

map.once('idle', () => {
    paintBase(map);
    document.body.dataset.ready = 'true';
});
