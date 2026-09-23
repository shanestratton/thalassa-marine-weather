import { describe, expect, it } from 'vitest';
import {
    constrainFramePadding,
    passageFrameGeometry,
    passageFrameIsVisible,
    passageFramePadding,
} from '../components/map/passageRouteFrame';

describe('passage overview geometry', () => {
    it('includes every bend, the actual off-route boat, and the forecast boat', () => {
        const route = [
            { lat: -25, lon: 150 },
            { lat: -24, lon: 153 },
            { lat: -22, lon: 152 },
        ];
        const before = JSON.stringify(route);
        const geometry = passageFrameGeometry(route, { lat: -26, lon: 155 }, { lat: -21, lon: 154 });
        expect(geometry?.bounds).toEqual([
            [150, -26],
            [155, -21],
        ]);
        expect(geometry?.points).toHaveLength(5);
        expect(JSON.stringify(route)).toBe(before);
    });

    it('does not turn a date-line passage into a whole-world fit', () => {
        const geometry = passageFrameGeometry(
            [
                { lat: -20, lon: 179 },
                { lat: -21, lon: -179 },
            ],
            { lat: -20.5, lon: -178 },
            null,
            180,
        );
        expect(geometry?.bounds).toEqual([
            [179, -21],
            [182, -20],
        ]);
        expect(geometry?.points).toEqual([
            [179, -20],
            [181, -21],
            [182, -20.5],
        ]);
    });

    it('aligns the date-line bounds to the map world copy already on screen', () => {
        expect(
            passageFrameGeometry(
                [
                    { lat: 2, lon: 179 },
                    { lat: 3, lon: -179 },
                ],
                null,
                null,
                -180,
            )?.bounds,
        ).toEqual([
            [-181, 2],
            [-179, 3],
        ]);
    });

    it('does not invent a position from invalid GPS or a malformed route', () => {
        expect(passageFrameGeometry([{ lat: 1, lon: 2 }], null, null)).toBeNull();
        expect(
            passageFrameGeometry(
                [
                    { lat: 1, lon: 2 },
                    { lat: NaN, lon: 3 },
                ],
                null,
                null,
            ),
        ).toBeNull();
        expect(
            passageFrameGeometry(
                [
                    { lat: 1, lon: 2 },
                    { lat: 2, lon: 3 },
                ],
                { lat: 100, lon: 3 },
                null,
            )?.points,
        ).toHaveLength(2);
    });

    it('checks projected interior vertices as well as endpoints with a small jitter tolerance', () => {
        const padding = { top: 100, right: 80, bottom: 100, left: 50 };
        const project = ([x, y]: [number, number]) => ({ x, y });
        expect(
            passageFrameIsVisible(
                [
                    [50, 100],
                    [320, 700],
                ],
                project,
                400,
                800,
                padding,
            ),
        ).toBe(true);
        expect(
            passageFrameIsVisible(
                [
                    [45, 95],
                    [325, 705],
                ],
                project,
                400,
                800,
                padding,
            ),
        ).toBe(true);
        expect(
            passageFrameIsVisible(
                [
                    [50, 100],
                    [390, 300],
                    [320, 700],
                ],
                project,
                400,
                800,
                padding,
            ),
        ).toBe(false);
    });

    it('retains a usable 64px viewport even in tiny split-screen panes', () => {
        const padding = constrainFramePadding({ top: 180, right: 100, bottom: 400, left: 180 }, 250, 360);
        expect(padding.left + padding.right).toBeCloseTo(186);
        expect(padding.top + padding.bottom).toBeCloseTo(296);
    });

    it('measures HUD and scrubber furniture rather than framing a route underneath them', () => {
        const root = document.createElement('main');
        const container = document.createElement('div');
        const hud = document.createElement('aside');
        hud.className = 'thalassa-passage-hud';
        const scrubber = document.createElement('div');
        scrubber.className = 'thalassa-route-scrubber';
        root.append(container, hud, scrubber);
        document.body.append(root);
        const bounds = (x: number, y: number, width: number, height: number) => ({
            x,
            y,
            width,
            height,
            left: x,
            right: x + width,
            top: y,
            bottom: y + height,
            toJSON: () => ({}),
        });
        container.getBoundingClientRect = () => bounds(0, 0, 430, 900);
        hud.getBoundingClientRect = () => bounds(0, 160, 162, 480);
        scrubber.getBoundingClientRect = () => bounds(12, 685, 300, 115);
        expect(passageFramePadding(container)).toEqual({ top: 112, right: 88, bottom: 235, left: 182 });
        hud.hidden = true;
        expect(passageFramePadding(container).left).toBe(24);
        root.remove();
    });
});
