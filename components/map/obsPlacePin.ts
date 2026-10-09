/**
 * obsPlacePin — the place chosen in the location box, marked on Obs, and the
 * locate button going there first (126-18).
 *
 * Shane 2026-10-09: "also in the obs page, if it isnt the vessel location or
 * the phone location, can we have a pin in the location and that is where the
 * locate fab goes to on the obs page".
 *
 *  · The pin: a gold teardrop with a navy rim and a star, named, at a place
 *    the box holds (a search, a saved spot, a map pick) whose point really
 *    belongs to its name (placePinPoint): never at a name still resolving,
 *    never at the previous report's spot. Within PLACE_PIN_SAME_SPOT_M of
 *    the boat's or the phone's current fix it is their location, and their
 *    mark stands for it. Tapped, the weather bubble for that spot.
 *  · Locate: the place, then the boat, then the phone (obsLocateStops). Each
 *    tap goes to the stop after the one the chart is still at, else the first
 *    (chartAtStop, nextLocateStop), and the button draws that next stop. The
 *    box following a receiver keeps its one stop exactly as before, and a
 *    MOB drops the place: Locate never takes a skipper from the casualty to a
 *    weather spot.
 *
 * It imports obsCentre and useLocationDot, never the reverse.
 */
import mapboxgl from 'mapbox-gl';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { calculateDistance } from '../../utils/navigationCalculations';
import {
    obsBoatLabel,
    obsLocateSubject,
    phoneFixNow,
    type LocatePlace,
    type LocateStop,
    type ObsBoatNames,
} from './obsCentre';
import { PHONE_DOT_ABOARD_M, nearBoatMark } from './useLocationDot';
import { OBS_PLACE_ZOOM } from './useObsStartupCamera';

/**
 * Within this of the boat's or the phone's current fix the place is theirs:
 * no pin, no stop. At z14, where Locate shows her, 250 m is 50-60 px at
 * mid latitudes: the closest a pin sits without touching her 48 px icon.
 */
export const PLACE_PIN_SAME_SPOT_M = 250;
/** The pin and the button's glyph re-check this often (the phone mark's cadence). */
export const PLACE_PIN_RECHECK_MS = 5_000;
/**
 * A polar place is drawn and flown to here, just inside Web Mercator's edge
 * (85.0511°), and its weather is asked for at the true point. At the edge
 * itself the pin was lost: Mapbox keeps the world's edge off screen, so no
 * camera centres there, and in the real engine at z10 the pin's tip sat on
 * the canvas's top edge with its body clipped (126-18). 85° lets z10 centre
 * on it on any phone.
 */
const POLAR_DRAW_LAT = 85;
/** The chart is still "at" a stop within this of where it was left... */
const AT_STOP_PX = 32;
/** ...and this far off its zoom. */
const AT_STOP_ZOOM = 0.5;
/** A flight set off less than this ago, still moving, counts as at its stop. */
const IN_FLIGHT_MS = 2_000;

interface LatLon {
    lat: number;
    lon: number;
}

/** The chosen place as Obs marks it. */
export interface PlacePin {
    name: string;
    /** The true point: the weather bubble asks for this. */
    lat: number;
    lon: number;
    /** The latitude the pin and the flight use: clamped to ±85°, just inside Mercator's edge. */
    drawLat: number;
}

const validPoint = (pt?: LatLon | null): pt is LatLon =>
    !!pt &&
    Number.isFinite(pt.lat) &&
    Number.isFinite(pt.lon) &&
    Math.abs(pt.lat) <= 90 &&
    Math.abs(pt.lon) <= 180 &&
    (pt.lat !== 0 || pt.lon !== 0);

/**
 * The place the box holds, with a point that really belongs to its name: the
 * saved coordinates of the pick, else the report's own point once the report
 * carries the same name (trimmed, any case: isShowingAnotherPlace's rule).
 * Null for Current Location, the 0,0 stub, an unusable point, and a name
 * still resolving (the report then is still the previous place's).
 */
export function placePinPoint(box: {
    defaultLocation?: string | null;
    defaultLocationCoords?: LatLon | null;
    weatherCoords?: LatLon | null;
    weatherName?: string | null;
}): PlacePin | null {
    const name = box.defaultLocation?.trim();
    if (!name || name === 'Current Location') return null;
    const sameName = !!box.weatherName && box.weatherName.trim().toLowerCase() === name.toLowerCase();
    const point = validPoint(box.defaultLocationCoords)
        ? box.defaultLocationCoords
        : sameName && validPoint(box.weatherCoords)
          ? box.weatherCoords
          : null;
    if (!point) return null;
    const drawLat = Math.max(-POLAR_DRAW_LAT, Math.min(POLAR_DRAW_LAT, point.lat));
    return { name, lat: point.lat, lon: point.lon, drawLat };
}

/** The place is not where the boat's or the phone's current mark already stands. */
export function placePinShows(place: PlacePin, now = Date.now()): boolean {
    if (nearBoatMark(place, PLACE_PIN_SAME_SPOT_M, now)) return false;
    const phone = phoneFixNow(now);
    return !(
        phone?.live && calculateDistance(place.lat, place.lon, phone.lat, phone.lon) * 1852 <= PLACE_PIN_SAME_SPOT_M
    );
}

/**
 * Where Locate goes, in order. The box following a receiver: its one stop,
 * exactly as before (obsLocateSubject). A place chosen: the place while its
 * pin shows (never during a MOB), then the boat when the account has one
 * (own, followed, crewed, or a fix of hers on record), then the phone:
 * always when there is no boat, else only with a fix of its own (live or
 * kept) away from her, so no permission prompt comes mid-cycle.
 */
export function obsLocateStops(
    state: { boxFollows: boolean; ownBoatNamed: boolean; place: PlacePin | null; mobActive: boolean },
    now = Date.now(),
): LocateStop[] {
    if (state.boxFollows) return [obsLocateSubject(true, state.ownBoatNamed, now)];
    const stops: LocateStop[] = [];
    if (state.place && !state.mobActive && placePinShows(state.place, now)) {
        stops.push({ kind: 'place', lat: state.place.drawLat, lon: state.place.lon, name: state.place.name });
    }
    const boat = obsLocateSubject(false, state.ownBoatNamed, now);
    stops.push(boat);
    if (boat.kind === 'phone') return stops;
    const phone = phoneFixNow(now);
    if (phone && !nearBoatMark(phone, PHONE_DOT_ABOARD_M, now)) stops.push({ kind: 'phone' });
    return stops;
}

/** The stop a tap goes to: the one after where the chart is (wrapping round), else the first. */
export function nextLocateStop(stops: LocateStop[], at: LocateStop['kind'] | null): LocateStop {
    const index = at === null ? -1 : stops.findIndex((stop) => stop.kind === at);
    return stops[index < 0 ? 0 : (index + 1) % stops.length] ?? { kind: 'phone' };
}

/** Where a Locate tap left the chart (or is flying it). */
export interface LastLocateStop {
    kind: LocateStop['kind'];
    lat: number;
    lon: number;
    zoom: number;
    /** When it was tapped, or when its flight set off. */
    at: number;
    /**
     * A place stop: which place it was (its name and drawn point). The chart
     * is at the place only while the box still holds that one: a new place
     * chosen meanwhile (a Glass beside Obs) is where the next tap goes.
     */
    place?: LocatePlace;
}

/** The remembered place stop is the place the box holds now. */
function isCurrentPlace(stop: LocatePlace | undefined, place: PlacePin | null): boolean {
    return !!stop && !!place && stop.name === place.name && stop.lat === place.drawLat && stop.lon === place.lon;
}

/** The camera is centred within AT_STOP_PX of `point` at `zoom` (on any world copy). */
function centredOn(map: mapboxgl.Map, point: LatLon, zoom: number): boolean {
    const z = map.getZoom();
    if (Math.abs(z - zoom) > AT_STOP_ZOOM) return false;
    const centre = map.getCenter();
    const here = map.project([centre.lng, centre.lat]);
    const there = map.project([point.lon, point.lat]);
    const world = 512 * 2 ** z;
    const dx = there.x - here.x;
    return Math.hypot(dx - Math.round(dx / world) * world, there.y - here.y) <= AT_STOP_PX;
}

/**
 * Which stop the chart is still at: the last tap's while its flight is in
 * the air (under 2 s) or while the chart is where it landed (where the tap
 * found it, if nothing moved: "No position from her yet"); else the place,
 * centred on its pin at z10 as Obs opens it. A hand move, Plan, a 'Show on
 * map', a layer frame or a new box leave the chart elsewhere: null. A last
 * place stop counts only for the place the box still holds: after a new one
 * the chart is not at the place, even where the old pin stood.
 */
export function chartAtStop(
    map: mapboxgl.Map,
    where: { place: PlacePin | null; last: LastLocateStop | null },
    now = Date.now(),
): LocateStop['kind'] | null {
    try {
        const { place } = where;
        const last =
            where.last && (where.last.kind !== 'place' || isCurrentPlace(where.last.place, place)) ? where.last : null;
        if (last && now - last.at < IN_FLIGHT_MS && map.isMoving()) return last.kind;
        if (last && centredOn(map, last, last.zoom)) return last.kind;
        if (place && centredOn(map, { lat: place.drawLat, lon: place.lon }, OBS_PLACE_ZOOM)) return 'place';
    } catch {
        /* the map went away */
    }
    return null;
}

/** Where the chart is as Locate is tapped: the stop's spot until its flight lands (and which place, for a place). */
export function noteLocateStop(map: mapboxgl.Map, stop: LocateStop, now = Date.now()): LastLocateStop {
    const centre = map.getCenter();
    const noted: LastLocateStop = { kind: stop.kind, lat: centre.lat, lon: centre.lng, zoom: map.getZoom(), at: now };
    if (stop.kind === 'place') noted.place = { name: stop.name, lat: stop.lat, lon: stop.lon };
    return noted;
}

/**
 * After a tap that flew: the flight is timed from now, and where the camera
 * really stops (Mapbox's own limits included) becomes the stop's spot. A
 * jump (Reduce Motion) has already stopped. `landed` runs once it has.
 */
export function followLocateFlight(map: mapboxgl.Map, stop: LastLocateStop, landed?: () => void): void {
    const land = () => {
        try {
            const centre = map.getCenter();
            stop.lat = centre.lat;
            stop.lon = centre.lng;
            stop.zoom = map.getZoom();
        } catch {
            /* the map went away */
        }
        landed?.();
    };
    try {
        if (map.isMoving()) {
            stop.at = Date.now();
            map.once('moveend', land);
            return;
        }
    } catch {
        return;
    }
    land();
}

/** The label beside the button after a tap: the place, the boat's name, or the phone. */
export function locateStopLabel(stop: LocateStop, names: ObsBoatNames): string {
    if (stop.kind === 'place') return stop.name;
    if (stop.kind === 'phone') return 'Your phone';
    const label = obsBoatLabel(stop.crewOwnerId, names);
    return label.charAt(0).toUpperCase() + label.slice(1);
}

function sameStop(a: LocateStop, b: LocateStop): boolean {
    if (a.kind === 'place' && b.kind === 'place') return a.name === b.name && a.lat === b.lat && a.lon === b.lon;
    if (a.kind === 'boat' && b.kind === 'boat') return a.crewOwnerId === b.crewOwnerId;
    return a.kind === b.kind;
}

/**
 * Where the next Locate tap goes, as state for the button: read now, when
 * `deps` change, and while `enabled` on each camera stop and every
 * PLACE_PIN_RECHECK_MS; set only when the stop changes. The refresh it
 * returns reads it again at once (a tap that did not move the chart).
 */
export function useNextLocateStop(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    enabled: boolean,
    read: () => LocateStop,
    deps: readonly unknown[],
): [LocateStop, () => void] {
    const readRef = useRef(read);
    readRef.current = read;
    const [next, setNext] = useState<LocateStop>(() => read());
    const refresh = useCallback(() => {
        const stop = readRef.current();
        setNext((previous) => (sameStop(previous, stop) ? previous : stop));
    }, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(refresh, deps);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !enabled) return undefined;
        map.on('moveend', refresh);
        const timer = window.setInterval(refresh, PLACE_PIN_RECHECK_MS);
        refresh();
        return () => {
            map.off('moveend', refresh);
            window.clearInterval(timer);
        };
    }, [mapRef, mapReady, enabled, refresh]);
    return [next, refresh];
}

// ── The pin ─────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The teardrop in a 26 × 34 box: head centred (13, 12), radius 9.5; the tip at (13, 33.5), on the place. */
const PIN_PATH = 'M13 33.5C9.5 28.6 3.5 20.5 3.5 12a9.5 9.5 0 0 1 19 0c0 8.5-6 16.6-9.5 21.5z';
/** A five-point star in the head. */
const STAR_PATH = 'M13 7l1.23 3.3 3.53.16L15 12.65l.94 3.4L13 14.1l-2.94 1.95.94-3.4-2.76-2.19 3.53-.16z';

function svgPath(d: string, attributes: Record<string, string>): SVGPathElement {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    for (const [name, value] of Object.entries(attributes)) path.setAttribute(name, value);
    return path;
}

/** Name the pin: its chip and its VoiceOver words. The name is the skipper's text: textContent only. */
export function labelPlacePin(el: HTMLElement, name: string): void {
    const spoken = `${name}, the place you chose. Show its weather`;
    if (el.getAttribute('aria-label') !== spoken) el.setAttribute('aria-label', spoken);
    const chip = el.querySelector('.obs-place-pin__label');
    if (chip && chip.textContent !== name) chip.textContent = name;
}

/**
 * The pin's element: a 44 × 44 button (the marker root, anchored at its foot,
 * where the teardrop's tip is), the gold teardrop with its navy rim, white
 * halo and star, and the name in a chip above it. Dependency-free: the e2e
 * fixtures draw this very element. A tap goes to `onTap` and never reaches
 * the map (whose own click would close the bubble it opens, or open a second
 * one in inspect mode).
 */
export function createPlacePinElement(name: string, onTap?: () => void): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    // Said outright: Mapbox's Marker gives any element without a role
    // role="img", and VoiceOver would then read the pin as a picture.
    el.setAttribute('role', 'button');
    el.className = 'obs-place-pin';
    el.dataset.glyph = 'place';
    // Mapbox owns position and transform on a marker root: never set them
    // here. Its size and the layout that puts the tip at its foot (the
    // anchor) are the element's own, so no stylesheet can move the tip.
    el.style.width = '44px';
    el.style.height = '44px';
    el.style.display = 'flex';
    el.style.alignItems = 'flex-end';
    el.style.justifyContent = 'center';
    el.style.padding = '0';
    el.style.border = '0';
    el.style.background = 'transparent';
    const chip = document.createElement('span');
    chip.className = 'obs-place-pin__label';
    chip.setAttribute('dir', 'auto');
    chip.setAttribute('aria-hidden', 'true');
    // Centred above the head, out of the button's flow (index.css dresses it).
    chip.style.position = 'absolute';
    chip.style.left = '50%';
    chip.style.bottom = '37px';
    chip.style.transform = 'translateX(-50%)';
    el.appendChild(chip);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'obs-place-pin__pin');
    svg.setAttribute('viewBox', '0 0 26 34');
    svg.setAttribute('width', '26');
    svg.setAttribute('height', '34');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.display = 'block';
    svg.style.overflow = 'visible';
    svg.style.flex = 'none';
    // The white halo carries the edge on dark and satellite bases, the navy rim on light ones.
    svg.appendChild(
        svgPath(PIN_PATH, { fill: 'none', stroke: '#fff', 'stroke-width': '5', 'stroke-linejoin': 'round' }),
    );
    svg.appendChild(
        svgPath(PIN_PATH, {
            fill: '#facc15',
            stroke: '#0f172a',
            'stroke-width': '2',
            'stroke-linejoin': 'round',
            'data-part': 'fill',
        }),
    );
    svg.appendChild(svgPath(STAR_PATH, { fill: '#0f172a' }));
    el.appendChild(svg);
    labelPlacePin(el, name);
    if (onTap) {
        el.addEventListener('click', (event) => {
            event.stopPropagation();
            onTap();
        });
    }
    return el;
}

/**
 * One gold pin at `place` while it is given (MapHub gives none off Obs, on a
 * planning surface, during a MOB, or with the box following a receiver), and
 * while the boat's and the phone's current marks are not on it (re-checked
 * every PLACE_PIN_RECHECK_MS). A new place moves and renames the same pin at
 * once. Its tap: `onTap` with the TRUE point (a polar place's weather is
 * asked for where it is, not where the chart can draw it) and the drawn one,
 * where the bubble and its spot go: on the pin, never off the world's edge.
 */
export function useObsPlacePin(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    place: PlacePin | null,
    onTap: (lat: number, lon: number, drawn: { lat: number; lon: number }) => void,
): void {
    const markerRef = useRef<mapboxgl.Marker | null>(null);
    const placeRef = useRef(place);
    placeRef.current = place;
    const onTapRef = useRef(onTap);
    onTapRef.current = onTap;
    const updateRef = useRef<() => void>(() => {});
    const enabled = place !== null;
    const placeKey = place ? `${place.name}\u0000${place.drawLat}\u0000${place.lon}` : null;

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !enabled) return undefined;
        const remove = () => {
            markerRef.current?.remove();
            markerRef.current = null;
        };
        const update = () => {
            const current = placeRef.current;
            if (!current || !placePinShows(current)) {
                remove();
                return;
            }
            if (!markerRef.current) {
                const el = createPlacePinElement(current.name, () => {
                    const shown = placeRef.current;
                    if (shown) onTapRef.current(shown.lat, shown.lon, { lat: shown.drawLat, lon: shown.lon });
                });
                markerRef.current = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
                    .setLngLat([current.lon, current.drawLat])
                    .addTo(map);
                return;
            }
            markerRef.current.setLngLat([current.lon, current.drawLat]);
            labelPlacePin(markerRef.current.getElement(), current.name);
        };
        updateRef.current = update;
        update();
        const timer = window.setInterval(update, PLACE_PIN_RECHECK_MS);
        return () => {
            window.clearInterval(timer);
            updateRef.current = () => {};
            remove();
        };
    }, [mapRef, mapReady, enabled]);

    // The box changed beside Obs (a Glass pinned beside it): the same pin, moved and renamed.
    useEffect(() => updateRef.current(), [placeKey]);
}
