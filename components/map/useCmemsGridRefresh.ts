import { useCallback, useEffect, useRef, useState } from 'react';
import type { WindGrid } from '../../services/weather/windField';
import { CMEMS_CACHE_TTL_MS } from '../../services/weather/api/cmemsGridTrust';

export type CmemsLoadPhase = 'idle' | 'loading' | 'ready' | 'error';
export type CmemsPresentation = 'absent' | 'hidden' | 'visible';

export interface CmemsLayerLoadState {
    phase: CmemsLoadPhase;
    requestedStep: number;
    verifiedStep: number | null;
    sourceGeneration: string | null;
    presentation: CmemsPresentation;
    attempt: number;
    retry: () => void;
}

export interface CmemsGridRefreshState extends CmemsLayerLoadState {
    grid: WindGrid | null;
}

export interface CmemsRenderOutcome {
    phase: 'ready' | 'error' | 'hidden' | 'stuck-visible';
    attempt: number;
    verifiedStep: number | null;
    sourceGeneration: string | null;
}

/**
 * A verified frame is not presented as ready until its layer hook confirms
 * that the exact fetch attempt, step and generation reached the renderer.
 */
export function cmemsRenderedLayerState(
    refresh: CmemsGridRefreshState,
    enabled: boolean,
    visible: boolean,
    mapReady: boolean,
    outcome: CmemsRenderOutcome | null,
): CmemsLayerLoadState {
    const base = {
        requestedStep: refresh.requestedStep,
        verifiedStep: null,
        sourceGeneration: null,
        presentation: 'absent' as const,
        attempt: refresh.attempt,
        retry: refresh.retry,
    };
    if (outcome?.phase === 'stuck-visible') {
        return {
            ...base,
            phase: 'error',
            verifiedStep: outcome.verifiedStep,
            sourceGeneration: outcome.sourceGeneration,
            presentation: 'visible',
        };
    }
    if (outcome?.phase === 'hidden') {
        return {
            ...base,
            phase: enabled && visible ? 'error' : 'idle',
            verifiedStep: outcome.verifiedStep,
            sourceGeneration: outcome.sourceGeneration,
            presentation: 'hidden',
        };
    }
    if (!enabled || !visible) return { ...base, phase: 'idle' };
    if (refresh.phase === 'error') return { ...base, phase: 'error' };
    if (!mapReady || refresh.phase !== 'ready' || !refresh.grid) return { ...base, phase: 'loading' };
    if (outcome?.attempt !== refresh.attempt) return { ...base, phase: 'loading' };
    if (outcome.phase === 'error') return { ...base, phase: 'error' };
    if (
        outcome.verifiedStep !== refresh.requestedStep ||
        outcome.sourceGeneration !== refresh.sourceGeneration ||
        !outcome.sourceGeneration
    ) {
        return { ...base, phase: 'loading' };
    }
    return {
        ...base,
        phase: 'ready',
        verifiedStep: outcome.verifiedStep,
        sourceGeneration: outcome.sourceGeneration,
        presentation: 'visible',
    };
}

/**
 * Own exactly one verified CMEMS map frame.
 *
 * Frame changes, hide/unmount, TTL revalidation, coverage expiry and failures
 * all clear React state and the loader's decoded ownership before continuing.
 * Immutable assets remain eligible for the browser HTTP cache, so revisiting a
 * frame does not require retaining a global decoded forecast cube.
 */
export function useCmemsGridRefresh(
    enabled: boolean,
    visible: boolean,
    requestedStep: number,
    fetchGrid: (step: number) => Promise<WindGrid | null>,
    releaseGrid: () => void,
    prepareForFrame: () => boolean = ALLOW_FRAME_LOAD,
): CmemsGridRefreshState {
    const retrySequenceRef = useRef(0);
    const attemptRef = useRef(0);
    const [retrySequence, setRetrySequence] = useState(0);
    const retry = useCallback(() => {
        retrySequenceRef.current += 1;
        setRetrySequence(retrySequenceRef.current);
    }, []);
    const initialStep = Math.max(0, Math.round(requestedStep));
    const [state, setState] = useState<CmemsGridRefreshState>({
        phase: 'idle',
        grid: null,
        requestedStep: initialStep,
        verifiedStep: null,
        sourceGeneration: null,
        presentation: 'absent',
        attempt: 0,
        retry,
    });

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const step = Math.max(0, Math.round(requestedStep));

        const publish = (phase: CmemsLoadPhase, attempt: number, grid: WindGrid | null = null) => {
            if (cancelled) return;
            setState({
                phase,
                grid,
                requestedStep: step,
                verifiedStep: phase === 'ready' ? (grid?.sourceStep ?? null) : null,
                sourceGeneration: phase === 'ready' ? (grid?.sourceGeneration ?? null) : null,
                presentation: 'absent',
                attempt,
                retry,
            });
        };

        const clearOwnedFrame = (phase: 'idle' | 'error', attempt: number) => {
            releaseGrid();
            publish(phase, attempt);
        };

        if (!enabled || !visible) {
            clearOwnedFrame('idle', attemptRef.current);
            return () => {
                cancelled = true;
                if (timer !== undefined) clearTimeout(timer);
                releaseGrid();
            };
        }

        const scheduleRefresh = (verified: WindGrid) => {
            if (cancelled) return;
            const now = Date.now();
            const coverageEnd = Date.parse(verified.validUntil ?? '');
            const verifiedAt = Date.parse(verified.verifiedAt ?? '');
            const untilCoverageEnd = Number.isFinite(coverageEnd) ? coverageEnd - now + 100 : CMEMS_CACHE_TTL_MS;
            const untilTtl = Number.isFinite(verifiedAt)
                ? verifiedAt + CMEMS_CACHE_TTL_MS - now + 100
                : CMEMS_CACHE_TTL_MS;
            const delay = Math.max(100, Math.min(untilCoverageEnd, untilTtl));
            timer = setTimeout(() => void load(true), delay);
        };

        const load = async (isRefresh: boolean) => {
            const attempt = ++attemptRef.current;
            publish('loading', attempt);
            if (isRefresh) releaseGrid();
            // Let React commit the OFF state so Mapbox drops the old typed
            // arrays before the next bounded response/decoder allocation.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (cancelled) return;
            // A new immutable response/decoder allocation is forbidden while
            // an older Mapbox layer ID may still own painted geometry. The
            // layer hook must synchronously prove absence first.
            if (!prepareForFrame()) {
                clearOwnedFrame('error', attempt);
                return;
            }
            let next: WindGrid | null = null;
            try {
                next = await fetchGrid(step);
            } catch {
                next = null;
            }
            if (cancelled) return;
            if (!next || next.sourceStep !== step || !next.u[step]) {
                clearOwnedFrame('error', attempt);
                return;
            }
            publish('ready', attempt, next);
            scheduleRefresh(next);
        };

        void load(false);
        return () => {
            cancelled = true;
            if (timer !== undefined) clearTimeout(timer);
            // This cleanup runs for scrub changes as well as hide/unmount,
            // aborting obsolete downloads instead of letting them populate a
            // cache after their layer has moved on.
            releaseGrid();
        };
    }, [enabled, fetchGrid, prepareForFrame, releaseGrid, requestedStep, retry, retrySequence, visible]);

    return state;
}

const ALLOW_FRAME_LOAD = () => true;
