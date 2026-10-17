import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (select: (value: unknown) => unknown) =>
        select({ settings: { vessel: { type: 'sail', name: 'Fictional boat', length: 12 } } }),
}));
vi.mock('../hooks/useRoutingPolar', () => ({
    useRoutingPolar: () => ({
        polar: {
            windSpeeds: [10, 20],
            angles: [45, 90, 135, 180],
            matrix: [
                [4, 8],
                [4, 8],
                [4, 8],
                [4, 8],
            ],
        },
        source: 'manual',
        label: 'Fictional chosen polar',
        reason: 'Fixture',
        signature: 'fixture',
    }),
}));
import { useInstrumentDerivations } from '../hooks/useInstrumentDerivations';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { confirmUnderSail } from '../services/instruments/underSail';
import type { NmeaStoreState } from '../services/NmeaStore';
const NOW = Date.parse('2026-10-16T10:00:00Z');
function fixture(): NmeaStoreState {
    return {
        instrumentEvidence: {
            identity: 'fictional-feed',
            via: 'lan',
            readings: {
                tws: { value: 15, at: NOW, unit: 'knots', source: 'wind' },
                twaSigned: { value: 60, at: NOW, unit: 'degrees', reference: 'relative', source: 'wind' },
                stw: { value: 5, at: NOW, unit: 'knots', reference: 'water', source: 'log' },
                rpm: { value: 0, at: NOW, unit: 'rpm', source: 'engine' },
            },
        },
    } as NmeaStoreState;
}
beforeEach(() => {
    setAuthIdentityScope('fictional-hook-a');
    confirmUnderSail(null);
});
afterEach(cleanup);
it('unknown propulsion keeps model targets but only explicit sail confirmation enables the observed ratio', () => {
    const state = fixture();
    const { result } = renderHook(() => useInstrumentDerivations(state, NOW));
    expect(result.current.performance).toMatchObject({
        kind: 'available',
        performancePct: null,
        propulsion: 'unknown',
    });
    act(() => result.current.confirmSail());
    expect(result.current.performance).toMatchObject({ kind: 'available', propulsion: 'sail' });
    if (result.current.performance.kind === 'available')
        expect(result.current.performance.performancePct).toBeCloseTo((100 * 5) / 6);
});
it('a fresh positive original RPM resets confirmation; a later zero cannot silently restore sail', () => {
    const state = fixture();
    const { result, rerender } = renderHook(() => useInstrumentDerivations(state, NOW));
    act(() => result.current.confirmSail());
    state.instrumentEvidence!.readings.rpm!.value = 900;
    rerender();
    expect(result.current.performance).toEqual({ kind: 'unavailable', reason: 'engine-running' });
    state.instrumentEvidence!.readings.rpm!.value = 0;
    rerender();
    expect(result.current.confirmed).toBe(false);
    expect(result.current.performance).toMatchObject({ propulsion: 'unknown', performancePct: null });
});
it('switching LAN to cloud or accounts resets under-sail state even for the same boat identity', () => {
    const state = fixture();
    const { result, rerender } = renderHook(() => useInstrumentDerivations(state, NOW));
    act(() => result.current.confirmSail());
    state.instrumentEvidence!.via = 'cloud';
    rerender();
    expect(result.current.confirmed).toBe(false);
    act(() => result.current.confirmSail());
    expect(result.current.confirmed).toBe(true);
    act(() => setAuthIdentityScope('fictional-hook-b'));
    expect(result.current.confirmed).toBe(false);
});
