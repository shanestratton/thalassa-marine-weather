import { useCallback, useEffect, useState } from 'react';
import type { SshObservation } from '../../services/weather/api/sshObservations';

export const SSH_LAYER_ENABLED = import.meta.env.VITE_ENABLE_OCEAN_EDDIES === 'true';
export type SshMode = 'off' | 'sla' | 'adt';
type Loader = (signal: AbortSignal) => Promise<SshObservation>;
const loadObservation: Loader = SSH_LAYER_ENABLED
    ? async (signal) => (await import('../../services/weather/api/sshObservations')).fetchSshObservation(signal)
    : async () => {
          throw new Error('SSH observations unavailable');
      };

/** A selected foreground Obs layer owns one dated cohort in RAM. No automatic retry or durable queue. */
export function useSshObservation(eligible: boolean, load: Loader = loadObservation) {
    const [foreground, setForeground] = useState(() => document.visibilityState !== 'hidden');
    const [online, setOnline] = useState(() => navigator.onLine);
    const [state, setState] = useState<{
        phase: 'off' | 'loading' | 'ready' | 'unavailable';
        data: SshObservation | null;
    }>({ phase: 'off', data: null });
    const enabled = SSH_LAYER_ENABLED && eligible && foreground && online;
    useEffect(() => {
        const visibility = () => setForeground(document.visibilityState !== 'hidden');
        const connectivity = () => setOnline(navigator.onLine);
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('online', connectivity);
        window.addEventListener('offline', connectivity);
        return () => {
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('online', connectivity);
            window.removeEventListener('offline', connectivity);
        };
    }, []);
    useEffect(() => {
        if (!enabled) {
            setState({ phase: eligible && SSH_LAYER_ENABLED && online === false ? 'unavailable' : 'off', data: null });
            return;
        }
        const controller = new AbortController();
        let live = true,
            expiry: ReturnType<typeof setTimeout> | undefined;
        setState({ phase: 'loading', data: null });
        void load(controller.signal)
            .then((data) => {
                if (!live || controller.signal.aborted) return;
                if (Date.now() > data.validUntilMs) {
                    setState({ phase: 'unavailable', data: null });
                    return;
                }
                setState({ phase: 'ready', data });
                expiry = setTimeout(
                    () => {
                        if (!live) return;
                        controller.abort();
                        setState({ phase: 'unavailable', data: null });
                    },
                    Math.max(1, data.validUntilMs - Date.now() + 1),
                );
            })
            .catch(() => {
                if (live) setState({ phase: 'unavailable', data: null });
            });
        return () => {
            live = false;
            controller.abort();
            if (expiry) clearTimeout(expiry);
        };
    }, [enabled, eligible, online, load]);
    const sourceCurrent = useCallback(
        () =>
            enabled &&
            state.data !== null &&
            Date.now() >= state.data.sourceTimeMs &&
            Date.now() <= state.data.validUntilMs,
        [enabled, state.data],
    );
    return {
        phase: enabled
            ? state.phase
            : eligible && SSH_LAYER_ENABLED && !online
              ? ('unavailable' as const)
              : ('off' as const),
        data: enabled ? state.data : null,
        sourceCurrent,
    };
}
