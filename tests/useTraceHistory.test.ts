import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useTraceHistory, type TracePoint } from '../components/map/useTraceHistory';

const triggerHaptic = vi.hoisted(() => vi.fn());
vi.mock('../utils/system', () => ({ triggerHaptic }));

const A: TracePoint = { lat: -27.47, lon: 153.03 };
const B: TracePoint = { lat: -27.3, lon: 153.2 };
const C: TracePoint = { lat: -27.14, lon: 153.36 };

function useTrace(points: TracePoint[] = [A]) {
    const [currentPoints, setPoints] = useState(points);
    return { points: currentPoints, setPoints, history: useTraceHistory(currentPoints, setPoints) };
}

describe('useTraceHistory', () => {
    it('restores edits exactly and discards redo after a new branch', () => {
        const { result } = renderHook(() => useTrace());

        act(() => result.current.setPoints([A, B]));
        act(() => result.current.setPoints([A, B, C]));
        expect(result.current.history.canUndo).toBe(true);

        act(() => expect(result.current.history.undo()).toBe(true));
        expect(result.current.points).toEqual([A, B]);
        expect(result.current.history.canRedo).toBe(true);

        act(() => expect(result.current.history.redo()).toBe(true));
        expect(result.current.points).toEqual([A, B, C]);

        act(() => expect(result.current.history.undo()).toBe(true));
        act(() => result.current.setPoints([A, C]));
        expect(result.current.history.canRedo).toBe(false);
        expect(result.current.history.redo()).toBe(false);
        expect(triggerHaptic).toHaveBeenCalledWith('light');
    });

    it('sets a new history floor when a route is saved or loaded', () => {
        const { result } = renderHook(() => useTrace());

        act(() => result.current.setPoints([A, B]));
        expect(result.current.history.canUndo).toBe(true);

        act(() => result.current.history.reset());
        expect(result.current.history.canUndo).toBe(false);

        act(() => {
            result.current.history.rebaseHistoryRef.current = true;
            result.current.setPoints([B, C]);
        });
        expect(result.current.points).toEqual([B, C]);
        expect(result.current.history.canUndo).toBe(false);
        expect(result.current.history.canRedo).toBe(false);
    });

    it('keeps invariant corrections out of the user-visible undo stack', () => {
        const { result } = renderHook(() => useTrace());

        act(() => result.current.setPoints([A, B]));
        act(() => {
            result.current.history.skipNextHistoryRef.current = true;
            result.current.setPoints([A, { ...B, lon: 153.21 }]);
        });

        act(() => expect(result.current.history.undo()).toBe(true));
        expect(result.current.points).toEqual([A]);
        expect(result.current.history.canUndo).toBe(false);
    });
});
