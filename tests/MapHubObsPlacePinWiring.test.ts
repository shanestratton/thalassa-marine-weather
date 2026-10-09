/**
 * MapHub's share of the chosen place's pin (126-18) is wiring only; the
 * decisions live in components/map/obsPlacePin.ts and obsCentre.ts, tested in
 * tests/obsPlacePin.test.ts and tests/obsCentre.test.ts. MapHub is too heavy
 * to render here (as MapHubReverseWiring.test.ts explains), so this pins the
 * wiring that would otherwise drift.
 *
 * Shane 2026-10-09: "also in the obs page, if it isnt the vessel location or
 * the phone location, can we have a pin in the location and that is where the
 * locate fab goes to on the obs page".
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** MapHub without comments, on one line, as written whatever the formatter's line breaks. */
const code = readFileSync('components/map/MapHub.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/([([]) /g, '$1')
    .replace(/ ([)\]])/g, '$1')
    .replace(/,([)\]])/g, '$1');

/** The text between two markers. */
function between(start: string, end: string): string {
    const from = code.indexOf(start);
    expect(from, `${start} exists`).toBeGreaterThan(-1);
    const to = code.indexOf(end, from + start.length);
    expect(to, `${end} follows ${start}`).toBeGreaterThan(-1);
    return code.slice(from, to);
}

describe('MapHub: the chosen place’s pin', () => {
    it('reads the box strictly: the saved point, or the report’s only when it carries the same name', () => {
        const point = between('placePinPoint({', '})');
        expect(point).toContain('defaultLocation: settings.defaultLocation');
        expect(point).toContain('defaultLocationCoords: boxPlace');
        expect(point).toContain('weatherCoords');
        expect(point).toContain('weatherName: weatherData?.locationName');
    });

    it('is drawn only on Obs, off any planning surface, with no MOB marked; its tap opens the weather bubble', () => {
        expect(code).toMatch(/const placePinOnChart = obsShowing && !planningSurface && !mobActive;/);
        expect(code).toMatch(
            /useObsPlacePin\(mapRef, mapReady, placePinOnChart \? placePin : null, showWeatherInspect\)/,
        );
    });

    it('the phone is drawn with a place too, through the one rule (useLocationDot.phoneDotWanted)', () => {
        const dot = between('useLocationDot(', '}));');
        expect(dot).toContain('phoneDotWanted({');
        expect(dot).toContain('obsShowing: obsShowing && !planningSurface');
        expect(dot).toContain("boxFollows: obsStart.kind === 'follow'");
    });
});

describe('MapHub: Locate goes to the place first', () => {
    const handler = () => between('onLocateMe={() => {', 'onRecenter={() => {');

    it('builds the stops from the box, the pin and the MOB, and takes the next one', () => {
        const state = between('const locateStopState', ';');
        expect(state).toContain("boxFollows: obsStart.kind === 'follow'");
        expect(state).toContain('ownBoatNamed: Boolean(ownBoatName)');
        expect(state).toContain('place: placePin');
        expect(state).toContain('mobActive');
        const tap = handler();
        expect(tap).toContain('obsLocateStops(locateStopState)');
        expect(tap).toMatch(
            /nextLocateStop\(stops, chartAtStop\(map, \{ place: placePin, last: lastStopRef\.current \}\)\)/,
        );
        // The whole stop, so a place stop remembers which place it was.
        expect(tap).toContain('const tap = noteLocateStop(map, stop);');
        expect(tap).toContain('lastStopRef.current = tap');
        // Both zooms from MapHub: obsCentre never imports the startup camera.
        expect(tap).toContain('locateOnObs(map, stop, obsBoatNames, LOCATE_BOAT_ZOOM, OBS_PLACE_ZOOM)');
        // A label only with more than one stop: every single-stop (124) flow looks the same.
        expect(tap).toMatch(/stops\.length > 1 \? \{ \.\.\.outcome, label: locateStopLabel\(stop, obsBoatNames\) \}/);
    });

    it('the button draws where the NEXT tap goes, and names the place', () => {
        const reader = between('useNextLocateStop(', '[obsStart.kind');
        expect(reader).toContain('nextLocateStop(obsLocateStops(locateStopState)');
        expect(reader).toContain('chartAtStop(map, { place: placePin, last: lastStopRef.current })');
        const fab = between('<MapActionFabs', '/>');
        expect(fab).toContain('target={locateNext.kind}');
        expect(fab).toContain("placeName={locateNext.kind === 'place' ? locateNext.name : undefined}");
    });
});
