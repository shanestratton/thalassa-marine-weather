import React, { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
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
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { usePaneScope } from '../../context/PanePortalContext';
import { OverlayPortal } from '../ui/OverlayPortal';
import { MapIcon, CompassIcon, XIcon } from '../Icons';
import type { AutoroutingTrialWorkspaceProps } from './AutoroutingTrialWorkspace';

const Workspace = lazyRetry(
    () => import('./AutoroutingTrialWorkspace').then((module) => ({ default: module.AutoroutingTrialWorkspace })),
    'AutoroutingTrialWorkspace',
);

const closeButtonClass =
    'flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-gray-300';

/** Keep the lazy-load gap dismissible and contained in the owning pane too. */
function OpeningTrial({ onClose }: { onClose: () => void }) {
    const pane = usePaneScope();
    const closeRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, { onEscape: onClose, initialFocusRef: closeRef });
    return (
        <OverlayPortal className="flex items-center justify-center bg-black/60 p-4">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal={pane ? undefined : true}
                aria-label="Opening autorouting trial"
                className="flex w-full max-w-md items-center gap-4 rounded-3xl border border-white/10 bg-slate-900 p-5 text-white shadow-2xl"
            >
                <p role="status" className="min-w-0 flex-1 text-sm font-semibold">
                    Opening trial chart…
                </p>
                <button
                    ref={closeRef}
                    type="button"
                    onClick={onClose}
                    className={closeButtonClass}
                    aria-label="Close routing choice"
                >
                    <XIcon className="h-5 w-5" />
                </button>
            </div>
        </OverlayPortal>
    );
}

/** Slider entry only: Manual delegates to the existing planner; Auto never stages a route intent. */
export function RoutingModeDialog({
    mapboxToken,
    onClose,
    onManual,
}: {
    mapboxToken: string;
    onClose: () => void;
    onManual: () => void;
}) {
    const pane = usePaneScope();
    const titleId = useId();
    const [phase, setPhase] = useState<'choice' | 'auto' | 'closed'>('choice');
    const [status, setStatus] = useState<AutoroutingTrialStatus | null>(null);
    const scope = useRef(getAuthIdentityScope());
    const finished = useRef(false);
    const initial = useRef<Pick<AutoroutingTrialWorkspaceProps, 'initialCenter' | 'initialDraftM' | 'initialSpeedKts'>>(
        {},
    );
    const closeRef = useRef<HTMLButtonElement>(null);
    const close = useCallback(() => {
        // The choice and its child workspace both fence account changes.
        // Whichever observes the change first owns the one close operation.
        if (finished.current) return;
        finished.current = true;
        initial.current = {};
        setPhase('closed');
        onClose();
    }, [onClose]);
    const dialogRef = useFocusTrap<HTMLDivElement>(phase === 'choice', { onEscape: close, initialFocusRef: closeRef });

    useEffect(() => {
        const controller = new AbortController();
        const unsubscribe = subscribeAuthIdentityScope(() => {
            if (!isAuthIdentityScopeCurrent(scope.current)) {
                controller.abort();
                setStatus(null);
                close();
            }
        });
        if (!scope.current.userId) {
            setStatus({ enabled: false, ready: false, message: 'Sign in to check Auto routing availability.' });
        } else {
            void getAutoroutingTrialStatus(controller.signal)
                .then((next) => {
                    if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope.current)) setStatus(next);
                })
                .catch(() => {
                    if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope.current))
                        setStatus({
                            enabled: false,
                            ready: false,
                            message: 'Auto routing is temporarily unavailable.',
                        });
                });
        }
        return () => {
            controller.abort();
            unsubscribe();
        };
    }, [close]);

    const chooseManual = () => {
        if (finished.current || phase !== 'choice' || !isAuthIdentityScopeCurrent(scope.current)) return;
        finished.current = true;
        setPhase('closed');
        onManual();
    };
    const chooseAuto = () => {
        if (finished.current || phase !== 'choice' || !status?.enabled || !isAuthIdentityScopeCurrent(scope.current))
            return;
        const location = LocationStore.getState();
        const settings = useSettingsStore.getState().settings;
        const center = location.source === 'initial' ? settings.defaultLocationCoords : location;
        initial.current = {
            initialCenter: center ? { lat: center.lat, lon: center.lon } : undefined,
            initialDraftM: settings.vessel ? vesselDraftMetres(settings.vessel, 0) : undefined,
            initialSpeedKts: settings.vessel?.cruisingSpeed,
        };
        setPhase('auto');
    };

    if (phase === 'closed') return null;
    if (phase === 'auto')
        return (
            <Suspense fallback={<OpeningTrial onClose={close} />}>
                <Workspace onClose={close} mapboxToken={mapboxToken} {...initial.current} />
            </Suspense>
        );

    return (
        <OverlayPortal
            className="flex items-center justify-center bg-black/60 px-4 py-[max(1rem,env(safe-area-inset-bottom))]"
            onClick={(event) => {
                if (event.target === event.currentTarget) close();
            }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal={pane ? undefined : true}
                aria-labelledby={titleId}
                className="w-full max-w-lg max-h-full overflow-y-auto rounded-3xl border border-white/10 bg-slate-900 p-5 text-white shadow-2xl"
            >
                <div className="mb-4 flex items-center justify-between gap-3">
                    <h2 id={titleId} className="ui-dialog-title">
                        Choose routing mode
                    </h2>
                    <button
                        ref={closeRef}
                        type="button"
                        onClick={close}
                        className={closeButtonClass}
                        aria-label="Close routing choice"
                    >
                        <XIcon className="h-5 w-5" />
                    </button>
                </div>
                <div
                    className="grid gap-3"
                    style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))' }}
                >
                    <button
                        type="button"
                        aria-label="Manual routing"
                        onClick={chooseManual}
                        className="flex min-h-32 flex-col items-start gap-2 rounded-2xl border border-sky-400/30 bg-sky-500/10 p-4 text-left text-sky-300 transition-colors hover:bg-sky-500/20"
                    >
                        <MapIcon className="h-7 w-7" />
                        <span className="text-base font-bold">Manual routing</span>
                        <span className="text-sm text-gray-300">Place your own waypoints on the chart.</span>
                    </button>
                    <button
                        type="button"
                        aria-label="Auto routing"
                        disabled={!status?.enabled}
                        onClick={chooseAuto}
                        className="flex min-h-32 flex-col items-start gap-2 rounded-2xl border border-teal-400/30 bg-teal-500/10 p-4 text-left text-teal-300 transition-colors enabled:hover:bg-teal-500/20 disabled:opacity-50"
                    >
                        <CompassIcon className="h-7 w-7" rotation={0} />
                        <span className="text-base font-bold">
                            Auto routing <span className="text-micro uppercase tracking-wide">· Trial</span>
                        </span>
                        <span className="text-sm text-gray-300">Try a SevenCs proposal on a separate chart.</span>
                    </button>
                </div>
                <p role="status" className="mt-4 text-sm text-gray-300">
                    {!status
                        ? 'Checking Auto routing availability… Manual is ready.'
                        : status.enabled
                          ? status.ready
                              ? 'Private trial · leaving now. Your saved routes and trip legs stay unchanged.'
                              : status.message ||
                                'Trial setup is in progress. You can still explore the separate chart.'
                          : status.message || 'Auto routing is not enabled for this account. Manual is ready.'}
                </p>
                <p className="mt-2 text-micro text-amber-300">
                    Auto is an unsaved trial, not a route cleared for navigation.
                </p>
            </div>
        </OverlayPortal>
    );
}
