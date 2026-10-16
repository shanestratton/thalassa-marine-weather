import { useCallback, useEffect, useRef } from 'react';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';

/** Latest-request lease retires synchronously on A/B/A account or vessel changes. */
export function useTrackRouteRead(active: boolean, geometry: unknown) {
    const request = useRef<AbortController | null>(null),
        epoch = useRef(0),
        live = useRef({ active, geometry });
    const nativeForeground = useRef(!Capacitor.isNativePlatform());
    live.current = { active, geometry };
    const cancel = useCallback(() => {
        epoch.current++;
        request.current?.abort();
        request.current = null;
    }, []);
    useEffect(() => {
        let stopped = false,
            stateRevision = 0,
            listener: { remove: () => Promise<void> } | null = null;
        nativeForeground.current = !Capacitor.isNativePlatform();
        if (Capacitor.isNativePlatform()) {
            void App.getState()
                .then((state) => {
                    if (!stopped && stateRevision === 0) nativeForeground.current = state.isActive;
                })
                .catch(() => {});
            void App.addListener('appStateChange', (state) => {
                if (stopped) return;
                stateRevision++;
                nativeForeground.current = state.isActive;
                if (!state.isActive) cancel();
            })
                .then((handle) => {
                    if (stopped) void handle.remove();
                    else listener = handle;
                })
                .catch(() => {
                    nativeForeground.current = false;
                    cancel();
                });
        }
        const auth = subscribeAuthIdentityScope(cancel);
        const vessel = useSettingsStore.subscribe((next, previous) => {
            if ((next.activeVesselId ?? null) !== (previous.activeVesselId ?? null)) cancel();
        });
        const visibility = () => {
            if (document.visibilityState !== 'visible') cancel();
        };
        document.addEventListener('visibilitychange', visibility);
        return () => {
            stopped = true;
            nativeForeground.current = false;
            void listener?.remove();
            cancel();
            auth();
            vessel();
            document.removeEventListener('visibilitychange', visibility);
        };
    }, [cancel]);
    useEffect(() => {
        if (!active) cancel();
    }, [active, cancel]);
    const read = useCallback(
        async (voyageId: string, scope: AuthIdentityScope = getAuthIdentityScope()) => {
            cancel();
            const controller = new AbortController(),
                mine = epoch.current,
                oldGeometry = live.current.geometry;
            request.current = controller;
            let expired = false;
            const timer = setTimeout(() => {
                expired = true;
                controller.abort();
            }, 20_000);
            const owns = () =>
                epoch.current === mine &&
                live.current.active &&
                nativeForeground.current &&
                live.current.geometry === oldGeometry &&
                isAuthIdentityScopeCurrent(scope) &&
                document.visibilityState === 'visible';
            const current = () => !controller.signal.aborted && owns();
            try {
                const { readOwnTrackRoute } = await import('../../services/routing/readOwnTrackRoute');
                if (!isAuthIdentityScopeCurrent(scope) || controller.signal.aborted) return null;
                const result = await Promise.race([
                    readOwnTrackRoute(voyageId, scope, controller.signal),
                    new Promise<never>((_, reject) =>
                        controller.signal.addEventListener('abort', () => reject(Error('Track read cancelled.')), {
                            once: true,
                        }),
                    ),
                ]);
                return current() ? result : null;
            } catch (error) {
                if (expired && owns()) throw Error('Track read timed out. Your current route was kept.');
                if (current()) throw error;
                return null;
            } finally {
                clearTimeout(timer);
                controller.abort();
                if (request.current === controller) request.current = null;
            }
        },
        [cancel],
    );
    return { read, cancel };
}
