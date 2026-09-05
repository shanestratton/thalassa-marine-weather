/**
 * "My location" on a boat is the BOAT's.
 *
 * Shane, 2026-09-05: "it is using the phones gps, and not the boat gps. so can
 * we make it that a: it looks at the garmin gps, (primary gps) then the 2ndary
 * gps (the blox one hanging off the pi on the vessel) and lastly it uses the
 * punters phone gps as a last resort?? reason being, is this is how the other
 * gps services go."
 *
 * That order already existed. services/boatPositionChain.ts was written on
 * 2026-09-03 — bus, then Pi, then null — and had NO CALLERS. It was built and
 * never wired to a surface, so every "where am I" in Scuttlebutt went straight
 * to GpsService: the receiver in a pocket below decks, the one that leaves the
 * boat, and the only one that can be somewhere the vessel is not.
 *
 * Two things this file pins beyond the order itself:
 *
 * THE STORE MUST BE CLAIMED FIRST. NmeaStore only ingests after something
 * calls start(). A surface that reads NmeaGpsProvider without doing so gets an
 * honest null and falls to the phone — arbitration as theatre, which is
 * exactly how the OBS screen ended up disagreeing with the instrument panel
 * (593cbfc4).
 *
 * AND IT MUST SAY WHICH ONE ANSWERED. The Garmin, the Pi's u-blox and the
 * phone can be kilometres apart. A shared position that does not name its
 * receiver is a position nobody can check.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const hook = strip(read('hooks/chat/usePinDrop.ts'));
const sheet = read('components/chat/ChatAttachmentSheets.tsx');
const chain = strip(read('services/boatPositionChain.ts'));

describe('Share my location — the boat GPS chain', () => {
    it('asks the boat before the phone', () => {
        const fn = hook.slice(hook.indexOf('const requestCurrentLocation'));
        const body = fn.slice(0, fn.indexOf('const retryCurrentLocation'));
        const boat = body.indexOf('await boatFix()');
        const phone = body.indexOf('GpsService.requestCurrentForegroundPosition');
        expect(boat, 'boatFix must be called').toBeGreaterThan(-1);
        expect(phone, 'the phone is still the last resort').toBeGreaterThan(-1);
        expect(boat, 'the boat must be asked FIRST').toBeLessThan(phone);
    });

    it('keeps the phone as a real fallback, not a removed one', () => {
        // Deleting the phone rung would strand every punter without a boat.
        const fn = hook.slice(hook.indexOf('const requestCurrentLocation'));
        expect(fn).toContain('rungLabel: describeRung(null)');
    });

    it('claims the NMEA store before reading the bus, or the bus is always null', () => {
        const fn = hook.slice(hook.indexOf('const requestCurrentLocation'));
        const start = fn.indexOf('NmeaStore.start()');
        const boat = fn.indexOf('await boatFix()');
        expect(start, 'must start the store').toBeGreaterThan(-1);
        expect(start, 'must start it BEFORE asking the bus').toBeLessThan(boat);
        // Config-gated: a phone that has never met a gateway opens no sockets.
        expect(fn).toMatch(/if \(NmeaListenerService\.getSavedConfig\(\)\) NmeaStore\.start\(\);/);
    });

    it('names the receiver that answered', () => {
        expect(hook).toContain('setPinRungLabel');
        expect(hook).toContain('describeRung(boat)');
        expect(sheet).toContain('pinRungLabel');
        // The old hardcoded caption is only a fallback now.
        expect(sheet).toMatch(/\{pinRungLabel \?\? 'Current GPS fix'\}/);
    });

    it('the chain itself is still Garmin, then Pi, then nothing', () => {
        const fn = chain.slice(chain.indexOf('export async function boatFix'));
        const bus = fn.indexOf('busFix()');
        const pi = fn.indexOf('await piFix()');
        expect(bus).toBeGreaterThan(-1);
        expect(pi).toBeGreaterThan(bus);
        // boatFix must NEVER reach for the phone itself — the caller decides,
        // because whether a phone stand-in is acceptable depends on what the
        // position is FOR.
        expect(fn).not.toContain('GpsService');
    });
});

describe('Share my location — one pin, not two', () => {
    it('does not draw a marker over the one the map already baked in', () => {
        // getStaticMapUrl puts `pin-l+ff4466(lng,lat)` on the Mapbox URL and
        // `markers=…,ol-marker` on the OSM fallback. The sheet drew its own SVG
        // pin centred on the same coordinate, so both landed on the same spot
        // (Shane 2026-09-05: "it shows two pins one on top of the other").
        const preview = sheet.slice(sheet.indexOf('getStaticMapUrl(pinLat, pinLng)'));
        const untilCaption = preview.slice(0, preview.indexOf('formatCoordinates(pinLat, pinLng)'));
        expect(untilCaption).not.toContain('<svg');
        expect(untilCaption).not.toContain('Pin marker overlay');
    });

    it('still relies on a builder that draws one', () => {
        const utils = read('components/chat/chatUtils.ts');
        const fn = utils.slice(utils.indexOf('export function getStaticMapUrl'));
        expect(fn.slice(0, 600)).toContain('pin-l+');
        expect(fn.slice(0, 600)).toContain('ol-marker');
    });
});

describe('the pin-view Get Directions CTA is gone', () => {
    it('leaves no button, no handler, and no component', () => {
        // Shane 2026-09-05: "that is totally not necessary and it does not work
        // anyway". It built a DRIVING route from the phone to a pin that is
        // usually on the water.
        expect(() => read('components/map/PinDirectionsCta.tsx')).toThrow();
        const hub = strip(read('components/map/MapHub.tsx'));
        expect(hub).not.toContain('PinDirectionsCta');
        expect(hub).not.toContain('handlePinDirections');
        const mode = strip(read('components/map/usePinViewMode.ts'));
        expect(mode).not.toContain('handlePinDirections');
        expect(mode).not.toContain('buildDirectionsVoyagePlan');
        // And it no longer asks for a location it has no use for.
        expect(mode).not.toContain('GpsService');
    });
});
