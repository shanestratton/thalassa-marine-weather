import { useEffect, useRef } from 'react';
import { toast } from '../Toast';
import type { CmemsLayerId } from './CmemsAttribution';
import type { CmemsLayerLoadState } from './useCmemsGridRefresh';

export const CMEMS_VECTOR_DWELL_MS = 800;
export const CMEMS_SCALAR_DWELL_MS = 1200;

export interface CmemsPlaybackConfig {
    layer: CmemsLayerId;
    label: string;
    visible: boolean;
    playing: boolean;
    step: number;
    totalSteps: number;
    dwellMs: number;
    status: CmemsLayerLoadState;
    setStep: (step: number) => void;
    setPlaying: (playing: boolean) => void;
    setLayerVisibility: (layer: CmemsLayerId, visible: boolean) => void;
}

export type CmemsFailureNotifier = (message: string, retry: () => void) => void;

const notifyCmemsFailure: CmemsFailureNotifier = (message, retry) => {
    toast.persistentError(message, { label: 'Retry', onClick: retry });
};

/** Exact rendered identity required before playback may start its dwell. */
export function isCmemsRenderedStepReady(status: CmemsLayerLoadState, requestedStep: number): boolean {
    return (
        status.phase === 'ready' &&
        status.presentation === 'visible' &&
        status.attempt > 0 &&
        status.requestedStep === requestedStep &&
        status.verifiedStep === requestedStep &&
        Boolean(status.sourceGeneration)
    );
}

/** Includes a previously-ready layer that Mapbox has not yet safely hidden. */
export function isCmemsStepPresented(status: CmemsLayerLoadState): boolean {
    return status.presentation === 'visible' && status.verifiedStep !== null && Boolean(status.sourceGeneration);
}

/**
 * Advance only after the selected frame reached the renderer, then remained
 * visible for the complete dwell. Changing the step starts one new bounded
 * load through useCmemsGridRefresh; this hook never fetches or prefetches.
 */
export function useCmemsAutoplay(config: CmemsPlaybackConfig | null): void {
    const phase = config?.status.phase;
    const attempt = config?.status.attempt;
    const presentation = config?.status.presentation;
    const verifiedStep = config?.status.verifiedStep;
    const sourceGeneration = config?.status.sourceGeneration;

    useEffect(() => {
        if (!config || !config.visible || !config.playing) return;
        const step = Math.max(0, Math.round(config.step));
        if (!isCmemsRenderedStepReady(config.status, step)) return;

        const timer = setTimeout(() => {
            const next = step + 1;
            if (next >= config.totalSteps) {
                config.setPlaying(false);
                config.setStep(0);
                return;
            }
            config.setStep(next);
        }, config.dwellMs);
        return () => clearTimeout(timer);
        // Config is intentionally decomposed below. MapHub creates its small
        // active-product descriptor during render; object identity must not
        // restart a dwell while its exact rendered state is unchanged.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        attempt,
        config?.dwellMs,
        config?.playing,
        config?.setPlaying,
        config?.setStep,
        config?.step,
        config?.totalSteps,
        config?.visible,
        phase,
        presentation,
        sourceGeneration,
        verifiedStep,
    ]);
}

/**
 * One failed attempt produces one fail-closed deselection and one actionable
 * notice. Retry forces a fresh loader attempt before explicitly reselecting.
 */
export function useCmemsFailureBoundary(
    config: CmemsPlaybackConfig | null,
    notify: CmemsFailureNotifier = notifyCmemsFailure,
): void {
    const handledFailureRef = useRef<string | null>(null);
    const phase = config?.status.phase;
    const attempt = config?.status.attempt;
    const presentation = config?.status.presentation;

    useEffect(() => {
        if (!config) {
            handledFailureRef.current = null;
            return;
        }
        if (phase !== 'error') {
            if (phase === 'idle' || phase === 'ready') handledFailureRef.current = null;
            return;
        }
        if (!config.visible) return;
        // Teardown can deteriorate from an ordinary renderer error into a
        // proven stale-visible layer without starting a new fetch attempt.
        // Treat that presentation transition as a distinct safety notice.
        const failureKey = `${config.layer}:${attempt}:${presentation}`;
        if (handledFailureRef.current === failureKey) return;
        handledFailureRef.current = failureKey;

        config.setPlaying(false);
        config.setLayerVisibility(config.layer, false);
        notify(
            config.status.presentation === 'visible'
                ? `${config.label} data could not be verified or removed. Do not rely on the stale layer still visible on the chart.`
                : `${config.label} data could not be verified. The layer was switched off.`,
            () => {
                config.status.retry();
                config.setLayerVisibility(config.layer, true);
            },
        );
        // See useCmemsAutoplay: depend on the stateful contract, not the
        // descriptor object's per-render identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        attempt,
        config?.label,
        config?.layer,
        config?.setLayerVisibility,
        config?.setPlaying,
        config?.status.retry,
        config?.visible,
        notify,
        phase,
        presentation,
    ]);
}
