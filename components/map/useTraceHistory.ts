/**
 * Undo/redo history for a plotted route.
 *
 * MapHub has many independent ways to edit a trace (tap, drag, auto-route,
 * insert, reverse, load). Capturing the previous point list in one hook keeps
 * every route edit reversible without requiring each caller to remember to
 * maintain history itself.
 */
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type MutableRefObject,
    type SetStateAction,
} from 'react';
import { triggerHaptic } from '../../utils/system';

export interface TracePoint {
    lat: number;
    lon: number;
}

export interface TraceHistory {
    /** Mark the next point-list replacement as a new saved/load baseline. */
    rebaseHistoryRef: MutableRefObject<boolean>;
    /** Exclude one invariant-preserving replacement from undo history. */
    skipNextHistoryRef: MutableRefObject<boolean>;
    canUndo: boolean;
    canRedo: boolean;
    /** Clears undo/redo immediately when the current route becomes the floor. */
    reset: () => void;
    /** Restores the previous edit. Returns false when no history exists. */
    undo: () => boolean;
    /** Restores an edit that was just undone. Returns false when none exists. */
    redo: () => boolean;
}

const MAX_HISTORY_ENTRIES = 100;

export function useTraceHistory(points: TracePoint[], setPoints: Dispatch<SetStateAction<TracePoint[]>>): TraceHistory {
    const historyRef = useRef<TracePoint[][]>([]);
    const redoRef = useRef<TracePoint[][]>([]);
    const previousPointsRef = useRef(points);
    const isRestoringRef = useRef(false);
    const rebaseHistoryRef = useRef(false);
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);

    useEffect(() => {
        if (points === previousPointsRef.current) return;

        if (isRestoringRef.current) {
            // The undo/redo handler has already moved both stacks; only update
            // the baseline so this replacement is not treated as a fresh edit.
            isRestoringRef.current = false;
            previousPointsRef.current = points;
            return;
        }

        if (rebaseHistoryRef.current) {
            // Loading or saving a route establishes a new undo floor.
            rebaseHistoryRef.current = false;
            historyRef.current = [];
            redoRef.current = [];
            previousPointsRef.current = points;
            setCanUndo(false);
            setCanRedo(false);
            return;
        }

        historyRef.current.push(previousPointsRef.current);
        if (historyRef.current.length > MAX_HISTORY_ENTRIES) historyRef.current.shift();
        redoRef.current = [];
        previousPointsRef.current = points;
        setCanUndo(true);
        setCanRedo(false);
    }, [points]);

    const undo = useCallback((): boolean => {
        if (historyRef.current.length === 0) return false;

        triggerHaptic('light');
        const previous = historyRef.current.pop()!;
        redoRef.current.push(previousPointsRef.current);
        isRestoringRef.current = true;
        setPoints(previous);
        setCanUndo(historyRef.current.length > 0);
        setCanRedo(true);
        return true;
    }, [setPoints]);

    const redo = useCallback((): boolean => {
        if (redoRef.current.length === 0) return false;

        triggerHaptic('light');
        const next = redoRef.current.pop()!;
        historyRef.current.push(previousPointsRef.current);
        isRestoringRef.current = true;
        setPoints(next);
        setCanUndo(true);
        setCanRedo(redoRef.current.length > 0);
        return true;
    }, [setPoints]);

    const reset = useCallback(() => {
        rebaseHistoryRef.current = false;
        historyRef.current = [];
        redoRef.current = [];
        previousPointsRef.current = points;
        setCanUndo(false);
        setCanRedo(false);
    }, [points]);

    return { rebaseHistoryRef, skipNextHistoryRef: isRestoringRef, canUndo, canRedo, reset, undo, redo };
}
