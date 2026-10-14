/**
 * The clear view's gesture (129-13): two fingers held still on Obs's chart,
 * decided as they lift. Not a two-finger tap, which is Mapbox GL's zoom-out
 * (TapZoomHandler, mapbox-gl 3.19.0: two touches, one tap, the touch ended
 * within 500 ms of its start by the events' timeStamps, under 30 px).
 * components/map/clearView/twoFingerHold.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TWO_FINGER_HOLD, TwoFingerHold, type HoldPoint } from '../components/map/clearView/twoFingerHold';

const A = (x: number, y: number): HoldPoint => ({ id: 1, x, y });
const B = (x: number, y: number): HoldPoint => ({ id: 2, x, y });

/**
 * Two fingers 120 px apart, the second down `gap` ms after the first, both
 * creeping `drift` px down-right and apart by `spread` px in all over 500 ms,
 * lifted at `lift` ms (the first finger, then the second). How many times it toggled.
 */
function hold({ gap = 20, lift = 650, drift = 0, spread = 0 }: Partial<Record<string, number>> = {}) {
    const h = new TwoFingerHold();
    let fired = 0;
    const feed = (points: HoldPoint[], t: number) => {
        if (h.touches(points, t)) fired += 1;
    };
    feed([A(100, 300)], 0);
    feed([A(100, 300), B(220, 300)], gap);
    let last = { a: A(100, 300), b: B(220, 300) };
    for (let t = gap + 50; t < lift; t += 50) {
        const k = Math.min(1, (t - gap) / 500);
        const out = (spread / 2) * k;
        last = { a: A(100 - out + drift * k, 300 + drift * k), b: B(220 + out + drift * k, 300 + drift * k) };
        feed([last.a, last.b], t);
    }
    feed([last.b], lift);
    feed([], lift + 10);
    return { h, fired };
}

describe('two fingers held on the chart', () => {
    it('toggle once, as they lift, past Mapbox’s 500 ms two-finger tap', () => {
        expect(TWO_FINGER_HOLD.holdMs).toBeGreaterThan(500);
        expect(hold().fired).toBe(1);
        // Held three seconds: still once.
        expect(hold({ lift: 3_000 }).fired).toBe(1);
        // Every finger up, the next hold toggles again.
        const h = new TwoFingerHold();
        h.touches([A(50, 50), B(150, 50)], 0);
        expect(h.touches([], 700)).toBe(true);
        h.touches([A(50, 50), B(150, 50)], 1_000);
        expect(h.touches([], 1_700)).toBe(true);
    });

    it('still toggle when the fingers creep 4–6 px on a moving boat (Mapbox pans 3 px in)', () => {
        for (const drift of [4, 5, 6]) expect(hold({ drift }).fired).toBe(1);
    });

    it('never fire for a two-finger tap (Mapbox’s zoom-out), however late its events are handled', () => {
        // The events' own times decide: lifted at 90 ms is a tap, even if it is handled a second later.
        expect(hold({ lift: 90 }).fired).toBe(0);
        // Lifted before the hold's 600 ms, after Mapbox's 500: neither a tap nor a hold.
        expect(hold({ lift: 550 }).fired).toBe(0);
        const h = new TwoFingerHold();
        h.touches([A(100, 300), B(220, 300)], 0);
        expect(h.touches([], 180)).toBe(false);
    });

    it('never fire for a pinch, a two-finger pan, a slow second finger, three fingers or one finger', () => {
        // A pinch: each finger 5 px out, the spacing 8 % wider (Mapbox's own zoom threshold is ~7 %).
        expect(hold({ spread: 10 }).fired).toBe(0);
        // …while 6 px of spread is a still hand, not a pinch.
        expect(hold({ spread: 6 }).fired).toBe(1);
        // A pan: both fingers travel 30 px.
        expect(hold({ drift: 30 }).fired).toBe(0);
        // The second finger 300 ms after the first: two presses, not a gesture.
        expect(hold({ gap: 300, lift: 1_200 }).fired).toBe(0);
        const three = new TwoFingerHold();
        three.touches([A(0, 0), B(80, 0)], 0);
        three.touches([A(0, 0), B(80, 0), { id: 3, x: 40, y: 60 }], 30);
        expect(three.touches([], 1_000)).toBe(false);
        // One finger held: the long press's pin, not this.
        const one = new TwoFingerHold();
        one.touches([A(0, 0)], 0);
        expect(one.touches([], 1_000)).toBe(false);
    });

    it('stand down when Mapbox begins a pinch, turn or tilt, or the touch is cancelled', () => {
        const h = new TwoFingerHold();
        h.touches([A(100, 300), B(220, 300)], 0);
        h.cancel();
        expect(h.touches([], 1_000)).toBe(false);
        h.touches([A(100, 300), B(220, 300)], 1_200);
        expect(h.touches([], 1_200 + TWO_FINGER_HOLD.holdMs)).toBe(true);
    });

    it('is wired to the chart: on the events’ own times; Mapbox’s user gestures cancel it, the camera’s own moves do not', () => {
        const hook = readFileSync('components/map/mapHub/useObsClearView.ts', 'utf8');
        expect(hook).toContain("map.on('zoomstart', gesture)");
        expect(hook).toContain("map.on('rotatestart', gesture)");
        expect(hook).toContain("map.on('pitchstart', gesture)");
        expect(hook).toContain('?.originalEvent) hold.cancel();');
        expect(hook).not.toContain("map.on('dragstart'");
        expect(hook).toContain("addEventListener('touchstart', touch, { passive: true })");
        expect(hook).toContain('hold.touches(points(event.touches), at(event))');
        expect(hook).toContain('event.timeStamp');
    });
});
