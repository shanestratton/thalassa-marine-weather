/**
 * The anchor radar, drawn: where the canvas actually puts the boat and the
 * anchors, through the component, not just the offset helper.
 *
 * jsdom cannot paint a canvas, so the 2D context here is a recorder: every
 * arc and fillText is kept with its coordinates (and the alpha it was drawn
 * at), and one animation frame is run by hand.
 *
 *  - Across 180° (Fiji): an anchor at 179.9999°E and a boat at 179.9999°W are
 *    about 21 m apart. The boat must be drawn beside the anchor, not a whole
 *    world away off the edge of the screen.
 *  - Move anchor's preview: the view centres on the proposed anchor, and the
 *    anchor as it stands now is drawn faint at its offset from it.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AnchorWatchSnapshot } from '../services/AnchorWatchService';
import { radarRose, SwingCircleCanvas, type SwingCanvasModel } from '../components/anchor-watch/SwingCircleCanvas';
import { destinationPoint } from '../utils/navigationCalculations';

type Call = { name: string; args: unknown[]; alpha: number };

const SIZE = 300;
const CENTRE = SIZE / 2;
/** displayRadius = min(W, H) × 0.35 */
const DISPLAY_RADIUS = SIZE * 0.35;

let calls: Call[] = [];
let frames: FrameRequestCallback[] = [];
/** The canvas's laid-out size; SIZE square unless a test says otherwise. */
let box = { width: SIZE, height: SIZE };

function recordingContext(): CanvasRenderingContext2D {
    const state: Record<string, unknown> = { globalAlpha: 1 };
    return new Proxy(state, {
        get(target, prop) {
            if (typeof prop !== 'string') return undefined;
            if (prop in target) return target[prop];
            if (prop === 'createRadialGradient' || prop === 'createLinearGradient')
                return () => ({ addColorStop: () => undefined });
            if (prop === 'measureText') return () => ({ width: 10 });
            return (...args: unknown[]) => {
                calls.push({ name: prop, args, alpha: Number(target.globalAlpha) });
            };
        },
        set(target, prop, value) {
            if (typeof prop === 'string') target[prop] = value;
            return true;
        },
    }) as unknown as CanvasRenderingContext2D;
}

function snapshot(
    anchor: { latitude: number; longitude: number },
    vessel: { latitude: number; longitude: number },
    swingRadius = 40,
): AnchorWatchSnapshot {
    return {
        state: 'watching',
        anchorPosition: { ...anchor, timestamp: 0 },
        vesselPosition: { ...vessel, accuracy: 0, heading: 0, speed: 0, timestamp: 0 },
        swingRadius,
        distanceFromAnchor: 0,
        maxDistanceRecorded: 0,
        bearingToAnchor: 0,
        config: { rodeLength: 40, waterDepth: 8, scopeRatio: 5, rodeType: 'chain', safetyMargin: 10 },
        positionHistory: [],
        alarmTriggeredAt: null,
        alarmCause: null,
        watchStartedAt: 0,
        gpsAccuracy: 0,
        gpsQuality: 'standard',
        gpsQualityLabel: 'Standard GPS',
        guardianStatus: 'idle',
        setupError: null,
    } as AnchorWatchSnapshot;
}

/** Render once and run the first animation frame. */
function draw(element: React.ReactElement) {
    render(element);
    const frame = frames.shift();
    expect(frame).toBeDefined();
    frame!(0);
}

/** The boat's core dot: the 4 px arc. */
function vesselDot(): [number, number] {
    const dot = calls.find((call) => call.name === 'arc' && call.args[2] === 4);
    expect(dot).toBeDefined();
    return [dot!.args[0] as number, dot!.args[1] as number];
}

const anchorsDrawn = () =>
    calls
        .filter((call) => call.name === 'fillText' && call.args[0] === '⚓')
        .map((call) => ({ x: call.args[1] as number, y: call.args[2] as number, alpha: call.alpha }));

describe('SwingCircleCanvas, drawn', () => {
    beforeEach(() => {
        calls = [];
        frames = [];
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() =>
            recordingContext()) as unknown as HTMLCanvasElement['getContext']);
        box = { width: SIZE, height: SIZE };
        vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(
            () =>
                ({
                    x: 0,
                    y: 0,
                    top: 0,
                    left: 0,
                    right: box.width,
                    bottom: box.height,
                    width: box.width,
                    height: box.height,
                    toJSON: () => ({}),
                }) as DOMRect,
        );
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        vi.stubGlobal('cancelAnimationFrame', () => undefined);
        // ResizeObserver comes from tests/setup.ts.
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('Fiji: a boat across 180° from her anchor is drawn beside it, east of it', () => {
        const anchor = { latitude: -16.8, longitude: 179.9999 };
        const boat = { latitude: -16.8, longitude: -179.9999 };
        draw(<SwingCircleCanvas snapshot={snapshot(anchor, boat)} />);

        const [x, y] = vesselDot();
        // 0.0002° of longitude at 16.8°S is about 21.3 m; at 40 m to 105 px, 56 px east.
        const expected = 0.0002 * 111320 * Math.cos((16.8 * Math.PI) / 180) * (DISPLAY_RADIUS / 40);
        expect(x - CENTRE).toBeCloseTo(expected, 0);
        expect(y).toBeCloseTo(CENTRE, 5);
        // The anchor is at the centre, at full strength.
        expect(anchorsDrawn()).toEqual([{ x: CENTRE, y: CENTRE, alpha: 1 }]);
    });

    it('Move anchor: centres on the proposed anchor and draws the one standing now, faint, at its offset', () => {
        const anchorNow = { latitude: 60.394, longitude: 5.32 };
        // The proposal is 20 m north of where the anchor stands now; the boat
        // lies 10 m east of the proposal.
        const proposed = destinationPoint(anchorNow.latitude, anchorNow.longitude, 0, 20 / 1852);
        const boat = destinationPoint(proposed.lat, proposed.lon, 90, 10 / 1852);
        draw(
            <SwingCircleCanvas
                snapshot={snapshot(anchorNow, { latitude: boat.lat, longitude: boat.lon })}
                previewAnchor={{ latitude: proposed.lat, longitude: proposed.lon }}
            />,
        );
        const scale = DISPLAY_RADIUS / 40;

        const [proposal, standing] = anchorsDrawn();
        expect(proposal).toEqual({ x: CENTRE, y: CENTRE, alpha: 1 });
        // 20 m south of the centre on screen, at reduced strength.
        expect(standing.x).toBeCloseTo(CENTRE, 1);
        expect(standing.y - CENTRE).toBeCloseTo(20 * scale, 0);
        expect(standing.alpha).toBeLessThan(1);

        // The boat is drawn against the proposal, not the anchor standing now.
        const [x, y] = vesselDot();
        expect(x - CENTRE).toBeCloseTo(10 * scale, 0);
        expect(y).toBeCloseTo(CENTRE, 0);
    });

    // 126-03a: Shore Watch draws the same radar from a broadcast and her trail,
    // through a model narrowed to what the canvas reads. The callers that
    // pass a whole AnchorWatchSnapshot change nothing.
    it('compile-level: a whole snapshot is still a canvas model, under the snapshot prop', () => {
        expectTypeOf<AnchorWatchSnapshot>().toMatchTypeOf<SwingCanvasModel>();
        const whole: AnchorWatchSnapshot = snapshot(
            { latitude: 38.53, longitude: -28.62 },
            { latitude: 38.53, longitude: -28.62 },
        );
        const element = <SwingCircleCanvas snapshot={whole} ariaLabel="Anchor watch radar display" />;
        expect(element.props.snapshot).toBe(whole);
    });

    it('Shore Watch: draws a model with no full snapshot, her trail across 180° beside the anchor', () => {
        const model: SwingCanvasModel = {
            state: 'watching',
            anchorPosition: { latitude: -16.8, longitude: 179.9998 },
            vesselPosition: { latitude: -16.8, longitude: -179.9997 },
            swingRadius: 60,
            gpsAccuracy: 0,
            positionHistory: [
                { latitude: -16.8, longitude: 179.9999 },
                { latitude: -16.8, longitude: -179.9999 },
                { latitude: -16.8, longitude: -179.9998 },
            ],
        };
        draw(<SwingCircleCanvas model={model} />);
        const scale = DISPLAY_RADIUS / 60;
        const metresEast = (lon: number) =>
            (((((lon - 179.9998) % 360) + 540) % 360) - 180) * 111320 * Math.cos((16.8 * Math.PI) / 180);
        // Each trail segment starts at a history point, metres east of the
        // centre: on screen, not a world away.
        const starts = calls
            .filter((call) => call.name === 'moveTo')
            .map((call) => call.args as [number, number])
            .filter(([sx, sy]) => Math.abs(sy - CENTRE) < 0.5 && sx > CENTRE);
        for (const lon of [179.9999, -179.9999]) {
            const expected = CENTRE + metresEast(lon) * scale;
            expect(starts.some(([sx]) => Math.abs(sx - expected) < 0.5)).toBe(true);
        }
        const [x] = vesselDot();
        expect(x - CENTRE).toBeCloseTo(metresEast(-179.9997) * scale, 0);
        expect(x).toBeLessThan(SIZE);
        // No accuracy ring for a Pi that sent none (the ring is the [2, 3] dash).
        const dashes = calls.filter((call) => call.name === 'setLineDash').map((call) => call.args[0]);
        expect(dashes).not.toContainEqual([2, 3]);
    });

    // Review 126-03a: the rose's letters sit 32 px past a circle at 35% of the
    // short side, so they need a canvas of about 267 px. Shore Watch's radar is
    // 128-256 px (wide and short in portrait, a small square in landscape), so
    // N was clipped or gone: a north-up radar with no N. `fitRose` keeps them on.
    describe('fitRose: N, E, S and W stay on a small canvas', () => {
        const model: SwingCanvasModel = {
            state: 'watching',
            anchorPosition: { latitude: 38.53, longitude: -28.62 },
            vesselPosition: { latitude: 38.5301, longitude: -28.6201 },
            swingRadius: 50,
            gpsAccuracy: 0,
            positionHistory: [],
        };
        const letters = () =>
            Object.fromEntries(
                calls
                    .filter((call) => call.name === 'fillText' && /^[NESW]$/.test(String(call.args[0])))
                    .map((call) => [call.args[0], [call.args[1] as number, call.args[2] as number]]),
            ) as Record<'N' | 'E' | 'S' | 'W', [number, number]>;
        /** A 13 px bold letter's centre at least 7 px inside every edge. */
        const inside = ([x, y]: [number, number]) => x >= 7 && x <= box.width - 7 && y >= 7 && y <= box.height - 7;

        it.each([
            ['a short phone in portrait', 343, 145],
            ['the smallest phone', 288, 128],
            ['compact landscape', 172, 172],
            ['a 160 px radar', 160, 160],
        ])('on %s (%i x %i), every letter and every tick is drawn on the canvas', (_label, width, height) => {
            box = { width, height };
            draw(<SwingCircleCanvas model={model} fitRose />);
            const drawn = letters();
            expect(Object.keys(drawn).sort()).toEqual(['E', 'N', 'S', 'W']);
            for (const letter of ['N', 'E', 'S', 'W'] as const) expect(inside(drawn[letter]), letter).toBe(true);
            // The 36 ticks: no trail or preview here, so every lineTo is a tick's outer end.
            const ends = calls.filter((call) => call.name === 'lineTo').map((call) => call.args as [number, number]);
            expect(ends).toHaveLength(36);
            for (const [x, y] of ends) {
                expect(x).toBeGreaterThanOrEqual(0);
                expect(x).toBeLessThanOrEqual(width);
                expect(y).toBeGreaterThanOrEqual(0);
                expect(y).toBeLessThanOrEqual(height);
            }
            // The circle gives up only what the letters need.
            const { displayRadius } = radarRose(width, height, true);
            expect(displayRadius).toBeGreaterThan(Math.min(width, height) * 0.29);
            expect(displayRadius).toBeLessThanOrEqual(Math.min(width, height) * 0.35);
        });

        it("without it (the boat's own radar) nothing changes: the same 160 px canvas puts N off the top", () => {
            box = { width: 160, height: 160 };
            draw(<SwingCircleCanvas model={model} />);
            expect(letters().N[1]).toBeLessThan(0);
        });

        it('on a canvas big enough for the full rose, fitRose draws it exactly as before', () => {
            expect(radarRose(300, 300, true)).toEqual(radarRose(300, 300, false));
            expect(radarRose(300, 300, false).displayRadius).toBeCloseTo(DISPLAY_RADIUS, 9);
            box = { width: 300, height: 300 };
            draw(<SwingCircleCanvas model={model} fitRose />);
            // N at displayRadius + 32 above the centre, as the boat's radar has it.
            expect(letters().N[1]).toBeCloseTo(CENTRE - DISPLAY_RADIUS - 32, 9);
        });
    });
});
