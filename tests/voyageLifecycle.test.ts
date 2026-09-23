import { describe, expect, it } from 'vitest';
import { departureCaptureState, voyageLifecycleOperationId } from '../services/shiplog/voyageLifecycle';
import type { TrackingState } from '../services/shiplog/TrackingStateStore';

const previous: TrackingState = { isTracking: false, isPaused: false, isRapidMode: false };

describe('voyage lifecycle identity', () => {
    it('only creates pending work for a genuine departure and preserves prior work for the same voyage', () => {
        expect(departureCaptureState(previous, 'new', true)).toBe('pending');
        expect(departureCaptureState(previous, 'existing', false)).toBeUndefined();
        const captured = { ...previous, currentVoyageId: 'existing', voyageStartCapture: 'captured' as const };
        expect(departureCaptureState(captured, 'existing', true)).toBe('captured');
        expect(departureCaptureState(captured, 'new', true)).toBe('pending');
        expect(departureCaptureState({ ...captured, voyageStartCapture: 'pending' }, 'existing', false)).toBe(
            'pending',
        );
    });

    it('separates voyages, start/end events, arbitrary legacy IDs and custom waypoints', () => {
        const start = voyageLifecycleOperationId('voyage_123_abc', 'Voyage Start');
        expect(start).toBe(voyageLifecycleOperationId('voyage_123_abc', 'Voyage Start'));
        expect(start).not.toBe(voyageLifecycleOperationId('voyage_456_def', 'Voyage Start'));
        expect(voyageLifecycleOperationId('voyage_123_abc', 'Voyage End')).toBeUndefined();
        const longId = voyageLifecycleOperationId('old/旅'.repeat(100), 'Voyage Start');
        expect(longId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
        expect(longId).not.toBe(voyageLifecycleOperationId('old/旅'.repeat(99), 'Voyage Start'));
        expect(voyageLifecycleOperationId('voyage_123_abc', 'Custom waypoint')).toBeUndefined();
    });
});
