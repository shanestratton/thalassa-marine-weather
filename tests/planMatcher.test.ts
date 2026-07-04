/**
 * planMatcher — the departure-time plan suggester behind the "Sailing
 * <plan>?" one-tap link prompt. Suggestion only, never a silent link —
 * these tests pin the qualification gates (±7 days, start within 10 NM)
 * and the best-candidate ordering (date first, distance tiebreak).
 */
import { describe, it, expect } from 'vitest';
import { suggestPlanForDeparture } from '../services/shiplog/planMatcher';
import type { RouteOrTrack } from '../services/shiplog/RoutesAndTracks';

const NEWPORT = { lat: -27.2088, lon: 153.0952 };
const MOOLOOLABA = { lat: -26.6832, lon: 153.1239 };
const AIRLIE = { lat: -20.267, lon: 148.717 };

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-10T00:00:00Z');

let seq = 0;
const plan = (startAt: { lat: number; lon: number }, departureMs: number, label = `plan-${++seq}`): RouteOrTrack => ({
    id: `planned_${label}`,
    label,
    sublabel: '',
    points: [startAt, AIRLIE].map((p) => ({ lat: p.lat, lon: p.lon })),
    bbox: [0, 0, 1, 1],
    timestamp: departureMs,
    distanceNm: 500,
    isLocal: false,
});

describe('suggestPlanForDeparture', () => {
    it('suggests a plan departing today from right here', () => {
        const p = plan(NEWPORT, NOW);
        expect(suggestPlanForDeparture([p], NOW, NEWPORT)?.id).toBe(p.id);
    });

    it('rejects plans departing from the wrong port', () => {
        const p = plan(MOOLOOLABA, NOW); // ~58 NM from Newport
        expect(suggestPlanForDeparture([p], NOW, NEWPORT)).toBeNull();
    });

    it('rejects plans more than a week out', () => {
        const p = plan(NEWPORT, NOW + 8 * DAY);
        expect(suggestPlanForDeparture([p], NOW, NEWPORT)).toBeNull();
    });

    it('accepts a plan made for 3 days ago (late departure)', () => {
        const p = plan(NEWPORT, NOW - 3 * DAY);
        expect(suggestPlanForDeparture([p], NOW, NEWPORT)?.id).toBe(p.id);
    });

    it('prefers the plan with the nearest departure date', () => {
        const near = plan(NEWPORT, NOW - 1 * DAY, 'near');
        const far = plan(NEWPORT, NOW - 5 * DAY, 'far');
        expect(suggestPlanForDeparture([far, near], NOW, NEWPORT)?.label).toBe('near');
    });

    it('breaks date ties by start-point proximity', () => {
        const here = plan(NEWPORT, NOW - 1 * DAY, 'here');
        const nearby = plan({ lat: NEWPORT.lat + 0.05, lon: NEWPORT.lon }, NOW - 1 * DAY, 'nearby');
        expect(suggestPlanForDeparture([nearby, here], NOW, NEWPORT)?.label).toBe('here');
    });

    it('ignores degenerate plans (fewer than 2 points)', () => {
        const p = { ...plan(NEWPORT, NOW), points: [{ lat: NEWPORT.lat, lon: NEWPORT.lon }] };
        expect(suggestPlanForDeparture([p], NOW, NEWPORT)).toBeNull();
    });

    it('returns null with no plans at all', () => {
        expect(suggestPlanForDeparture([], NOW, NEWPORT)).toBeNull();
    });
});
