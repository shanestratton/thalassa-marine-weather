import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { WEATHER_FOLLOW_TARGET_EVENT, getWeatherFollowKey } from '../../services/weatherPosition';
import {
    OBS_BROAD_CENTRE,
    clearObsCentreNotice,
    fixNow,
    lookUpFix,
    obsFollowSubject,
    onObsCameraClaim,
    readPhonePermission,
    showObsCentreNotice,
    watchForLiveFix,
    type ObsFix,
} from './obsCentre';

/**
 * The Obs chart's zoom on the vessel: where it opens and where the find-boat
 * button flies (Shane 2026-10-06: "default to the vessel zoomed in at zoom 14
 * in the centre"; the find-boat button since 2026-10-05). Other charts keep
 * the z10 boot.
 */
export const OBS_VESSEL_ZOOM = 14;

/**
 * The Obs chart's zoom on a place chosen in the location box: the z10 golden
 * boot (every nav mark visible, local water filling the screen), the same
 * zoom the recentre-on-location button flies to.
 */
export const OBS_PLACE_ZOOM = 10;

/**
 * The message waits this long for the receivers' answer before saying what
 * the chart holds. On a slow or captive network (a bus, plane Wi-Fi without a
 * plan) the boat's cloud read can take a minute, and an hours-old position
 * must not stand there unexplained meanwhile.
 */
export const OBS_NOTICE_GRACE_MS = 4_000;

interface LatLon {
    lat: number;
    lon: number;
}

/**
 * Where Obs opens: what the location box points at (Shane 2026-10-06: "if i
 * put hawaii in the glass page, when i go to the obs page, it should show me
 * that location from the get go").
 *
 *  · 'follow' — the box follows a receiver (Current Location). Obs opens at
 *    z14 on what it follows (Shane 2026-10-06, testing on a bus): the BOAT
 *    when her row is picked (or the boat crewed on), from her own chain only,
 *    never the phone; the PHONE otherwise, from its GPS only, never the boat.
 *    With no live fix, the last known one and a message; with none ever, the
 *    broad view and a message (obsCentre).
 *  · 'place' — the box holds a chosen place (a search, a saved spot, a map
 *    pick). Obs opens there at z10. `center` is null until a name-only choice
 *    has resolved its coordinates; Obs waits rather than hopping via the boat.
 *
 * A place only ever moves the camera. It is never handed to anything that
 * stands for the vessel (ownship, the boat marker, find-boat).
 */
export type ObsStartTarget = { kind: 'follow' } | { kind: 'place'; key: string; center: LatLon | null };

export const OBS_START_FOLLOW: ObsStartTarget = { kind: 'follow' };

const validPoint = (pt?: LatLon | null): pt is LatLon =>
    !!pt &&
    Number.isFinite(pt.lat) &&
    Number.isFinite(pt.lon) &&
    Math.abs(pt.lat) <= 90 &&
    Math.abs(pt.lon) <= 180 &&
    (pt.lat !== 0 || pt.lon !== 0);

/**
 * Read the location box. `defaultLocation` is the selection itself ('Current
 * Location' while following); its saved coordinates identify a pick exactly,
 * and the displayed report's coordinates fill in for a name-only choice.
 */
export function obsStartTarget(box: {
    defaultLocation?: string | null;
    defaultLocationCoords?: LatLon | null;
    weatherCoords?: LatLon | null;
}): ObsStartTarget {
    const name = box.defaultLocation?.trim();
    if (!name || name === 'Current Location') return OBS_START_FOLLOW;
    const picked = validPoint(box.defaultLocationCoords) ? box.defaultLocationCoords : null;
    const center = picked ?? (validPoint(box.weatherCoords) ? box.weatherCoords : null);
    // The key is the CHOICE, not the report: a forecast refining its
    // coordinates is not the skipper moving the box.
    const key = picked ? `place:${name}@${picked.lat.toFixed(4)},${picked.lon.toFixed(4)}` : `place:${name}`;
    return { kind: 'place', key, center: center ? { lat: center.lat, lon: center.lon } : null };
}

/** What the box points at right now; a follow target counts as a change of box. */
function obsStartKey(target: ObsStartTarget): string {
    return target.kind === 'place' ? target.key : `follow:${getWeatherFollowKey()}`;
}

/**
 * What 'Current Location' follows, re-read whenever it changes: a pick in the
 * box (from a Glass pinned beside Obs too), Switch boat, the crewing ending,
 * or an account change.
 */
function useWeatherFollowKey(): string {
    const [key, setKey] = useState(getWeatherFollowKey);
    useEffect(() => {
        const read = () => setKey(getWeatherFollowKey());
        window.addEventListener(WEATHER_FOLLOW_TARGET_EVENT, read);
        const stopScope = subscribeAuthIdentityScope(read);
        read();
        return () => {
            window.removeEventListener(WEATHER_FOLLOW_TARGET_EVENT, read);
            stopScope();
        };
    }, []);
    return key;
}

/** The broad view's zoom: the Aus + NZ fit useMapInit measured for this map, else z3. */
function broadZoom(map: mapboxgl.Map): number {
    const fit = (map as unknown as { __ausNzMinZoom?: unknown }).__ausNzMinZoom;
    return typeof fit === 'number' && Number.isFinite(fit) ? fit : 3;
}

const samePoint = (a: ObsFix | null, b: ObsFix | null) => a === b || (!!a && !!b && a.lat === b.lat && a.lon === b.lon);

/** What a follow centring holds on screen while it has no live fix. */
interface StandIn {
    key: string;
    /** Put on screen yet. */
    placed: boolean;
    /** The last known fix it holds; null for the broad view. */
    point: ObsFix | null;
    /** Its message has been said (and maybe dismissed since): not said again for the same stand-in. */
    said: boolean;
}

/**
 * Centre OBS where the location box points: a chosen place at z10 at once,
 * or what the box follows at z14 (obsCentre). A live fix centres and settles.
 * Without one, the camera holds a stand-in (the last known fix, else the
 * broad view) and takes the first live fix once, until the skipper (or
 * find-boat) takes the camera; the message says what the chart shows, once
 * the receivers have answered or after OBS_NOTICE_GRACE_MS.
 *
 * Once per box: a later visit keeps wherever the skipper left the chart, and
 * only a change of box (a new place, or a new follow target) recentres, the
 * next time Obs shows. Leaving Obs is not the skipper taking the camera: a
 * centring that has not centred carries on at the next visit. Layer toggles
 * never move it (see useLayerFrameSnap). Obs does not keep following once it
 * has centred.
 */
export function useObsStartupCamera(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    enabled: boolean,
    target: ObsStartTarget = OBS_START_FOLLOW,
): void {
    /** The box the camera last settled for (centred, or the skipper took over). */
    const settledKey = useRef<string | null>(null);
    /** The box a centring is in progress for, while Obs shows. */
    const activeKey = useRef<string | null>(null);
    /** The box whose centring Obs was left during: the next visit carries it on. */
    const resumeKey = useRef<string | null>(null);
    /** What the follow centring holds meanwhile. */
    const standIn = useRef<StandIn | null>(null);
    /** Bumped by each centring run, so an older run's late answer defers to the newer run's own. */
    const runSeq = useRef(0);
    /** Obs was showing on the previous run, so this run is not a fresh visit. */
    const showing = useRef(false);
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;
    const targetRef = useRef(target);
    targetRef.current = target;

    const placeKey = target.kind === 'place' ? target.key : null;
    const placeLat = target.kind === 'place' ? (target.center?.lat ?? null) : null;
    const placeLon = target.kind === 'place' ? (target.center?.lon ?? null) : null;
    // A new follow target is a new box. Before the camera settles it takes
    // over at once (as a new place does); after, it waits for the next visit.
    const followKey = useWeatherFollowKey();
    const followDep = target.kind === 'follow' ? followKey : null;

    useEffect(() => {
        if (!enabled) {
            showing.current = false;
            // Leaving (Plan, a picker, a shared pin, another tab) is not the
            // skipper taking the camera. A centring that has not centred, a
            // name-only place still resolving or a follow centring on its
            // stand-in, carries on at the next visit: it takes the live fix
            // once, and its message stands meanwhile. A settled one stays so.
            if (activeKey.current !== null) {
                resumeKey.current = activeKey.current;
                activeKey.current = null;
            }
            return;
        }
        const map = mapRef.current;
        if (!map) return;
        const freshVisit = !showing.current;
        showing.current = true;
        const current = targetRef.current;
        const key = obsStartKey(current);
        let resuming = false;
        if (activeKey.current === null) {
            // Only a visit starts a centring, and only for a box the camera
            // has not already settled for.
            if (!freshVisit || key === settledKey.current) return;
            resuming = key === resumeKey.current;
        }
        resumeKey.current = null;
        // This visit's centring re-run (the map became ready), or one carried
        // on from the last visit; otherwise a new one.
        const carriedOn = resuming || activeKey.current === key;
        // A new centring, or the box moved before the camera settled: the old
        // message no longer describes the chart. A carried-on one keeps its own.
        if (!carriedOn) clearObsCentreNotice();
        // Also covers the box moving before the camera settled (boot order).
        activeKey.current = key;
        const run = ++runSeq.current;

        let disposed = false;
        let handedOver = false;
        let stopWatching: (() => void) | undefined;
        let stopHearingClaims: (() => void) | undefined;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            stopWatching?.();
            stopHearingClaims?.();
            clearTimeout(graceTimer);
            map.off('movestart', onGesture);
            map.off('zoomstart', onGesture);
            map.off('dragstart', onGesture);
        };
        const settle = () => {
            settledKey.current = activeKey.current;
            activeKey.current = null;
            dispose();
        };
        // Camera events carry originalEvent only when a person moved the map.
        const onGesture = (event: unknown) => {
            if (!event || typeof event !== 'object' || !('originalEvent' in event) || !event.originalEvent) return;
            settle();
        };
        /** Listen for the skipper taking the camera: a gesture, or find-boat's flight. */
        const listen = () => {
            map.on('movestart', onGesture);
            map.on('zoomstart', onGesture);
            map.on('dragstart', onGesture);
            stopHearingClaims = onObsCameraClaim((claimed) => {
                if (claimed !== map) return;
                // Find-boat flew elsewhere and speaks for the chart now.
                handedOver = true;
                settle();
            });
        };
        /** Still this centring, on this map, with Obs showing. */
        const ours = () => !disposed && activeKey.current === key && enabledRef.current && mapRef.current === map;
        const jump = (point: LatLon, zoom: number) => {
            if (!ours()) return;
            settle();
            map.jumpTo({ center: [point.lon, point.lat], zoom });
        };

        if (current.kind === 'place') {
            // The camera moves; nothing else learns the place. Ownship is not
            // read, subscribed or refreshed, so no boat hop and no masquerade.
            if (current.center) {
                jump(current.center, OBS_PLACE_ZOOM);
                return dispose;
            }
            // Name-only choice still resolving: wait for it, unless the
            // skipper takes the camera first.
            listen();
            return dispose;
        }

        const subject = obsFollowSubject();
        if (!carriedOn || standIn.current?.key !== key)
            standIn.current = { key, placed: false, point: null, said: false };
        const held = standIn.current;
        /** The box moved on (a new place or follow target), find-boat took over, or a newer run speaks. */
        const superseded = () =>
            handedOver ||
            (runSeq.current !== run && activeKey.current === key) ||
            (activeKey.current !== key && resumeKey.current !== key && settledKey.current !== key);
        /** A live fix: centre on it, settle, and clear the message about it. */
        const centreLive = (fix: ObsFix) => {
            if (!ours()) return;
            clearObsCentreNotice(subject);
            // No stand-in any more: nothing left for a slower answer to say.
            if (standIn.current === held) standIn.current = null;
            jump(fix, OBS_VESSEL_ZOOM);
        };
        /** No live fix yet: hold the last known one, or the broad view, without settling. */
        const hold = (fix: ObsFix | null): boolean => {
            if (!ours()) return false;
            if (fix) map.jumpTo({ center: [fix.lon, fix.lat], zoom: OBS_VESSEL_ZOOM });
            else map.jumpTo({ center: OBS_BROAD_CENTRE, zoom: broadZoom(map) });
            if (!held.placed || !samePoint(fix, held.point)) held.said = false;
            held.placed = true;
            held.point = fix;
            return true;
        };
        /**
         * Say what the chart holds. Said even after the skipper took the
         * camera or left Obs, since it opened there; not while a live fix
         * stands, and only once for the same stand-in.
         */
        const say = async () => {
            if (held.said || standIn.current !== held) return;
            const point = held.point;
            const permission = subject.kind === 'phone' && !point ? await readPhonePermission() : undefined;
            // A live fix may have landed while the permission was read, or a
            // better stand-in (whose own say follows).
            if (
                held.said ||
                held.point !== point ||
                standIn.current !== held ||
                superseded() ||
                fixNow(subject, Date.now(), { lastKnown: false })
            )
                return;
            held.said = true;
            showObsCentreNotice({
                subject,
                state: point ? 'held' : 'none',
                at: point?.timestamp ?? null,
                permission,
            });
        };

        // Listen while the style loads, so a gesture before mapReady also
        // prevents a late fix from undoing the skipper's view.
        listen();
        if (mapReady) {
            const first = fixNow(subject, Date.now());
            if (first?.live) {
                centreLive(first);
                return dispose;
            }
            // A carried-on centring keeps the stand-in already on screen
            // (a layer's zoom frame included); a new one puts it there.
            if (!held.placed || !samePoint(first, held.point)) hold(first);
            stopWatching = watchForLiveFix(subject, centreLive);
            if (!held.said) graceTimer = setTimeout(() => void say(), OBS_NOTICE_GRACE_MS);
            void lookUpFix(subject).then((fix) => {
                if (superseded()) return;
                if (fix?.live) {
                    centreLive(fix);
                    return;
                }
                // Still no live fix: a better stand-in if one came (on screen
                // only while this centring has the camera), then the message.
                const shown = fix ?? fixNow(subject, Date.now());
                if (!samePoint(shown, held.point)) hold(shown);
                void say();
            });
        }
        return dispose;
    }, [enabled, mapReady, mapRef, placeKey, placeLat, placeLon, followDep]);
}
