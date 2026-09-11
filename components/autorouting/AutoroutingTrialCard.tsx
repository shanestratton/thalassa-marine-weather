import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { getAutoroutingTrialStatus, type AutoroutingTrialStatus } from '../../services/autoroutingTrial';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { lazyRetry } from '../../utils/lazyRetry';
import { LocationStore } from '../../stores/LocationStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { vesselDraftMetres } from '../../services/units';
import type { AutoroutingTrialWorkspaceProps } from './AutoroutingTrialWorkspace';

const Workspace = lazyRetry(
    () => import('./AutoroutingTrialWorkspace').then((module) => ({ default: module.AutoroutingTrialWorkspace })),
    'AutoroutingTrialWorkspace',
);

/** Entitlement comes only from the server; a local identity is not authorization. */
export function AutoroutingTrialCard({ mapboxToken }: { mapboxToken: string }) {
    const [status, setStatus] = useState<AutoroutingTrialStatus | null>(null);
    const [open, setOpen] = useState(false);
    const initial = useRef<Pick<AutoroutingTrialWorkspaceProps, 'initialCenter' | 'initialDraftM' | 'initialSpeedKts'>>(
        {},
    );
    const close = useCallback(() => setOpen(false), []);
    useEffect(() => {
        let request: AbortController | undefined;
        const refresh = () => {
            request?.abort();
            setStatus(null);
            setOpen(false);
            initial.current = {};
            const scope = getAuthIdentityScope();
            if (!scope.userId) return;
            const controller = new AbortController();
            request = controller;
            void getAutoroutingTrialStatus(controller.signal)
                .then((next) => {
                    if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope)) setStatus(next);
                })
                .catch(() => {
                    /* A failed entitlement check never exposes the trial. */
                });
        };
        const unsubscribe = subscribeAuthIdentityScope(refresh);
        refresh();
        return () => {
            request?.abort();
            unsubscribe();
        };
    }, []);
    if (!status?.enabled) return null;
    return (
        <>
            <button
                type="button"
                onClick={() => {
                    const location = LocationStore.getState();
                    const settings = useSettingsStore.getState().settings;
                    const center = location.source === 'initial' ? settings.defaultLocationCoords : location;
                    initial.current = {
                        initialCenter: center ? { lat: center.lat, lon: center.lon } : undefined,
                        initialDraftM: settings.vessel ? vesselDraftMetres(settings.vessel, 0) : undefined,
                        initialSpeedKts: settings.vessel?.cruisingSpeed,
                    };
                    setOpen(true);
                }}
                className="flex w-full items-center gap-3 rounded-2xl border border-teal-500/25 bg-linear-to-br from-teal-500/10 to-slate-900/40 p-3 text-left text-teal-300"
            >
                <span aria-hidden="true" className="text-2xl">
                    ↗
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-sm font-black uppercase tracking-wide">Autorouting · Trial</span>
                    <span className="block text-micro text-gray-400">Separate draft chart · not for navigation</span>
                </span>
                <span aria-hidden="true">›</span>
            </button>
            {open && (
                <Suspense
                    fallback={
                        <p role="status" className="text-micro">
                            Opening trial chart…
                        </p>
                    }
                >
                    <Workspace onClose={close} mapboxToken={mapboxToken} {...initial.current} />
                </Suspense>
            )}
        </>
    );
}
