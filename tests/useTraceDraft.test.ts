import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTraceDraft } from '../components/map/useTraceDraft';

const keys = {
    pins: 'thalassa_trace_wip_pins',
    departureMs: 'thalassa_trace_departure_ms',
    name: 'thalassa_trace_wip_name',
    autoName: 'thalassa_trace_wip_auto_name',
    legAnchor: 'thalassa_trace_wip_leg_anchor',
    origin: 'thalassa_trace_wip_origin',
    destination: 'thalassa_trace_wip_dest',
};

describe('useTraceDraft', () => {
    beforeEach(() => sessionStorage.clear());

    it('recovers only valid session-backed trace state', () => {
        sessionStorage.setItem(
            keys.pins,
            JSON.stringify([
                { lat: -26.8, lon: 153.1 },
                { lat: 91, lon: 153.2 },
            ]),
        );
        sessionStorage.setItem(keys.departureMs, String(Date.now() + 60_000));
        sessionStorage.setItem(keys.name, 'Mooloolaba - Noosa');
        sessionStorage.setItem(keys.autoName, 'Mooloolaba - Noosa');
        sessionStorage.setItem(
            keys.legAnchor,
            JSON.stringify({
                tripId: 'trip-1',
                ordinal: 2,
                fromName: 'Mooloolaba',
                anchor: { lat: -26.7, lon: 153.1 },
            }),
        );
        sessionStorage.setItem(keys.origin, JSON.stringify({ lat: -26.8, lon: 153.1, name: 'Mooloolaba' }));
        sessionStorage.setItem(keys.destination, JSON.stringify({ lat: -26.7, lon: 153.2 }));

        const { result } = renderHook(() => useTraceDraft());

        expect(result.current.capturedCoords).toEqual([{ lat: -26.8, lon: 153.1 }]);
        expect(result.current.departureMs).toBeGreaterThan(Date.now());
        expect(result.current.traceName).toBe('Mooloolaba - Noosa');
        expect(result.current.lastAutoNameRef.current).toBe('Mooloolaba - Noosa');
        expect(result.current.legAnchor?.ordinal).toBe(2);
        expect(result.current.traceOrigin?.name).toBe('Mooloolaba');
        expect(result.current.traceDest).toBeNull();
    });

    it('persists changes as a single per-tab draft', () => {
        const { result } = renderHook(() => useTraceDraft());
        const anchor = { tripId: 'trip-2', ordinal: 3, fromName: 'Noosa', anchor: { lat: -26.4, lon: 153.1 } };

        act(() => {
            result.current.setCapturedCoords([{ lat: -26.5, lon: 153.1 }]);
            result.current.setDepartureMs(1_900_000_000_000);
            result.current.setTraceName('Noosa - Hervey Bay');
            result.current.lastAutoNameRef.current = 'Noosa - Hervey Bay';
            result.current.setLegAnchor(anchor);
            result.current.setTraceOrigin({ lat: -26.5, lon: 153.1, name: 'Noosa' });
            result.current.setTraceDest({ lat: -25.3, lon: 152.9, name: 'Hervey Bay' });
        });

        expect(JSON.parse(sessionStorage.getItem(keys.pins) ?? 'null')).toEqual([{ lat: -26.5, lon: 153.1 }]);
        expect(sessionStorage.getItem(keys.departureMs)).toBe('1900000000000');
        expect(sessionStorage.getItem(keys.name)).toBe('Noosa - Hervey Bay');
        expect(JSON.parse(sessionStorage.getItem(keys.legAnchor) ?? 'null')).toEqual(anchor);
        expect(JSON.parse(sessionStorage.getItem(keys.origin) ?? 'null')).toMatchObject({ name: 'Noosa' });
        expect(JSON.parse(sessionStorage.getItem(keys.destination) ?? 'null')).toMatchObject({ name: 'Hervey Bay' });
    });
});
