import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const markers = vi.hoisted(() => [] as Array<{ position: number[]; removed: boolean }>);
vi.mock('mapbox-gl', () => ({
    default: {
        Marker: class {
            item = { position: [] as number[], removed: false };
            constructor() {
                markers.push(this.item);
            }
            setLngLat(p: number[]) {
                this.item.position = p;
                return this;
            }
            addTo() {
                return this;
            }
            remove() {
                this.item.removed = true;
                return this;
            }
        },
    },
}));
import { useTracerConstraintMarks } from '../components/map/useTracerConstraintMarks';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const points = [
    {
        lat: -0.001,
        lon: 1,
        constraint: { lat: 0, lon: 1, leaveSide: 'port' as const, standOffM: 100, courseBearing: 90 },
    },
];
afterEach(() => {
    vi.useRealTimers();
    markers.length = 0;
    setAuthIdentityScope(null);
});
describe('original user mark reference lifecycle', () => {
    it('draws the original position separately and removes it synchronously on account change', () => {
        setAuthIdentityScope('fixture-a');
        const hook = renderHook(() => useTracerConstraintMarks({ current: {} } as never, true, points));
        expect(markers[0]).toEqual({ position: [1, 0], removed: false });
        act(() => setAuthIdentityScope('fixture-b'));
        expect(markers[0].removed).toBe(true);
        hook.unmount();
    });
    it('waits boundedly for a cold map and cancels references when capture closes', () => {
        vi.useFakeTimers();
        const map = { current: null as unknown };
        const hook = renderHook(({ active }) => useTracerConstraintMarks(map as never, active, points), {
            initialProps: { active: true },
        });
        expect(markers).toHaveLength(0);
        map.current = {};
        act(() => vi.advanceTimersByTime(200));
        expect(markers).toHaveLength(1);
        hook.rerender({ active: false });
        expect(markers[0].removed).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});
