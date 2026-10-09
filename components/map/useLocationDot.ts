import mapboxgl from 'mapbox-gl';
import { useEffect, type MutableRefObject } from 'react';
import { GpsService } from '../../services/GpsService';
import type { WeatherFollowTarget } from '../../services/weatherPosition';
import { calculateDistance } from '../../utils/navigationCalculations';
import { phoneFixNow, humanFixAge, type ObsFix } from './obsCentre';
import { ownshipMarkerSubject, vesselMarkerFixNow } from './ownshipBoatFix';
import { createPhoneMarkerElement } from './phoneMarker';

/**
 * The phone's own dot — "you are here" for the PHONE, never the boat.
 *
 * Shane 2026-10-06, the location box rules: Current Location is "the punters
 * phone as centre on the screen regardless of where they are", and the boat
 * is the vessel's GPS only. The own-ship marker (useVesselTracker) now always
 * draws the boat when the account has one, so while the box is on Current
 * Location the phone needs a mark of its own where the chart centres: a
 * little phone in a blue badge (phoneMarker.ts; build 124, Shane: "a little
 * picture of a mobile phone"), still .loc-dot. It never wears the boat's
 * name, her status or her chip.
 *
 * Shown only while the boat marker is a boat (a punter whose phone is all the
 * boat has sees the phone AS the own-ship marker, one pin, as always), and
 * hidden while the phone is aboard her (within PHONE_DOT_ABOARD_M of her live
 * fix): one marker on the boat, not two pins one on top of the other.
 *
 * With a place chosen in the box it shows too (126-18): Locate goes to the
 * place, the boat and the phone in turn, and every mark it goes to is drawn.
 */

/** The phone counts as aboard within this of the boat's live fix, and draws no second pin on her. */
export const PHONE_DOT_ABOARD_M = 100;
/** The dot re-checks its fix age and the boat's position this often. */
const PHONE_DOT_RECHECK_MS = 5_000;

/** Whether the phone's own dot belongs on the chart. */
export function phoneDotWanted(state: {
    /** Obs is on screen. */
    obsShowing: boolean;
    /** The location box follows a receiver (not a chosen place). */
    boxFollows: boolean;
    followTarget: WeatherFollowTarget;
    /** What the own-ship marker draws (useVesselTracker's subject). */
    markerSubject: 'phone' | 'boat';
}): boolean {
    if (!state.obsShowing || state.markerSubject !== 'boat') return false;
    // Following a receiver: Current Location only. A chosen place: always.
    return state.boxFollows ? state.followTarget === 'phone' : true;
}

/**
 * Where the boat the marker draws (her own or a crewed one) is now, from a
 * current fix only: her held fix is history, and she may have moved since.
 */
export function boatMarkLiveFix(now = Date.now()): { lat: number; lon: number } | null {
    try {
        const subject = ownshipMarkerSubject(now);
        if (subject.kind !== 'boat') return null;
        const boat = vesselMarkerFixNow(subject.crewOwnerId, now);
        return boat && boat.lane !== 'held' ? { lat: boat.lat, lon: boat.lon } : null;
    } catch {
        return null;
    }
}

/** Within `metres` of the boat the marker draws, by her current fix (great circle: safe across 180°). */
export function nearBoatMark(point: { lat: number; lon: number }, metres: number, now = Date.now()): boolean {
    const boat = boatMarkLiveFix(now);
    return !!boat && calculateDistance(point.lat, point.lon, boat.lat, boat.lon) * 1852 <= metres;
}

/** The phone is aboard the boat the marker draws: within PHONE_DOT_ABOARD_M of her current fix. */
function nearBoat(fix: ObsFix, now: number): boolean {
    return nearBoatMark(fix, PHONE_DOT_ABOARD_M, now);
}

export function useLocationDot(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    locationDotRef: MutableRefObject<mapboxgl.Marker | null>,
    mapReady: boolean,
    enabled = true,
) {
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !enabled) return;

        const remove = () => {
            if (!locationDotRef.current) return;
            locationDotRef.current.remove();
            locationDotRef.current = null;
        };

        const update = () => {
            const now = Date.now();
            // The phone's own newest fix only: its watch, then the fix it kept
            // across a relaunch (the same one the camera centres on, with its
            // message). Never the ownship arbiter, which would hand it the boat.
            const fix = phoneFixNow(now);
            if (!fix || nearBoat(fix, now)) {
                remove();
                return;
            }
            if (!locationDotRef.current) {
                const el = createPhoneMarkerElement();
                locationDotRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
                    .setLngLat([fix.lon, fix.lat])
                    .addTo(map);
            } else {
                locationDotRef.current.setLngLat([fix.lon, fix.lat]);
            }
            const el = locationDotRef.current.getElement();
            // A last known position is drawn as one: grey and still, with its age in its name.
            el.classList.toggle('loc-dot--last', !fix.live);
            el.dataset.live = fix.live ? 'true' : 'false';
            const label = fix.live ? 'Your phone' : `Your phone, last fix ${humanFixAge(fix.timestamp, now)}`;
            if (el.getAttribute('aria-label') !== label) {
                el.setAttribute('aria-label', label);
                el.title = label;
            }
        };

        // Passive: it consumes an existing Location grant, never prompts.
        const unsubGps = GpsService.watchPosition(() => update());
        const timer = window.setInterval(update, PHONE_DOT_RECHECK_MS);
        update();

        return () => {
            unsubGps();
            window.clearInterval(timer);
            remove();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapReady, enabled]);
}
