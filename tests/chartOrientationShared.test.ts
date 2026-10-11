/**
 * What every chart layer reads of the orientation (127-11a). The modes and
 * their controller are 127-11b; nothing in 11a turns the chart, so with no
 * mode set every answer is today's north-up one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    chartBearing,
    chartFitBearing,
    chartTurning,
    isOrientationEvent,
    setChartOrientation,
    subscribeChartTurning,
} from '../components/map/chartOrientation';

afterEach(() => setChartOrientation({ turning: false, target: null }));

describe('chart orientation, the shared part', () => {
    it('no mode: not turning, and a fit keeps the chart’s own bearing (0 north up)', () => {
        expect(chartTurning()).toBe(false);
        expect(chartFitBearing({ getBearing: () => 0 } as never)).toBe(0);
        expect(chartFitBearing({ getBearing: () => 12 } as never)).toBe(12);
    });

    it('a map that cannot say its bearing is north up, never NaN', () => {
        expect(chartBearing({} as never)).toBe(0);
        expect(chartBearing({ getBearing: () => Number.NaN } as never)).toBe(0);
        expect(
            chartBearing({
                getBearing: () => {
                    throw new Error('removed');
                },
            } as never),
        ).toBe(0);
    });

    it('a mode’s target wins over the bearing mid-turn, so a fit and the mode agree', () => {
        setChartOrientation({ turning: true, target: 47 });
        expect(chartTurning()).toBe(true);
        expect(chartFitBearing({ getBearing: () => 20 } as never)).toBe(47);
    });

    it('tells its listeners only when turning starts or stops', () => {
        const listener = vi.fn();
        const stop = subscribeChartTurning(listener);
        setChartOrientation({ turning: true, target: 10 });
        setChartOrientation({ turning: true, target: 30 });
        setChartOrientation({ turning: false, target: null });
        expect(listener).toHaveBeenCalledTimes(2);
        stop();
        setChartOrientation({ turning: true, target: 5 });
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('an orientation turn is marked in its eventData; a gesture or a plain flight is not', () => {
        expect(isOrientationEvent({ type: 'rotatestart', thalassaOrientation: true })).toBe(true);
        expect(isOrientationEvent({ type: 'rotatestart', originalEvent: {} })).toBe(false);
        expect(isOrientationEvent({})).toBe(false);
        expect(isOrientationEvent(undefined)).toBe(false);
    });
});
