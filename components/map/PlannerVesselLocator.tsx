import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import type { BoatFix } from '../../services/boatPositionChain';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import {
    plannerVesselLabel,
    PLANNER_LIVE_FIX_MS,
    readPlannerVesselPosition,
    validPlannerVesselFix,
} from '../../services/plannerVesselPosition';

const yacht =
    '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v13H4L12 3Zm2 3 6 10h-6M3 19h18l-3 3H6l-3-3Z" stroke-linejoin="round"/></svg>';

/** Shared manual/auto plotting control. It moves the camera only. */
export function PlannerVesselLocator({
    mapRef,
    mapReady,
    autoCenter = false,
    onLocate,
}: {
    mapRef: React.MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    autoCenter?: boolean;
    onLocate?: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const action = useRef<() => void>(() => {});
    const current = useRef({ autoCenter, onLocate });
    current.current = { autoCenter, onLocate };

    useEffect(() => {
        const map = mapRef.current;
        if (!mapReady || !map) return;
        let disposed = false;
        let marker: mapboxgl.Marker | null = null;
        let latest: BoatFix | null = null;
        let pending: Promise<BoatFix | null> | null = null;
        let touched = false;
        let centred = false;
        let requestId = 0;
        const canvas = map.getCanvasContainer();
        const interact = () => {
            touched = true;
        };
        canvas.addEventListener('pointerdown', interact);
        canvas.addEventListener('wheel', interact, { passive: true });
        canvas.addEventListener('keydown', interact);

        const clear = () => {
            marker?.remove();
            marker = null;
            latest = null;
        };
        const draw = (fix: BoatFix) => {
            const label = plannerVesselLabel(fix);
            if (!marker) {
                const el = document.createElement('div');
                el.innerHTML = yacht;
                el.style.cssText =
                    'width:36px;height:36px;display:grid;place-items:center;border:2px solid currentColor;border-radius:50%;background:#0f172a;box-shadow:0 2px 12px #0008;pointer-events:none';
                el.setAttribute('role', 'img');
                marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
                    .setLngLat([fix.longitude, fix.latitude])
                    .addTo(map);
            }
            marker.setLngLat([fix.longitude, fix.latitude]);
            const el = marker.getElement();
            el.title = label;
            el.setAttribute('aria-label', label);
            el.style.color = validPlannerVesselFix(fix, PLANNER_LIVE_FIX_MS) ? '#2dd4bf' : '#fbbf24';
            setMessage((old) => (old.includes('position ·') ? label : old));
        };
        const centre = (fix: BoatFix) => {
            // Frame beside the tracer pane on wide charts. On phones its
            // existing hide handle opens the map; do not resize/edit the route.
            const frame = map.getContainer().getBoundingClientRect();
            const root = map.getContainer().closest('.autoroute-full-chart') ?? map.getContainer().parentElement;
            const panel = root?.querySelector('.map-tracer-panel, .autoroute-controls-anchor')?.getBoundingClientRect();
            const offset: [number, number] =
                panel && frame.width >= 650 ? [Math.min(panel.width / 2, frame.width / 4), 0] : [0, 0];
            map.flyTo({
                center: [fix.longitude, fix.latitude],
                zoom: Math.max(12, map.getZoom()),
                offset,
                duration: 900,
            });
        };
        const fetchFix = () => {
            if (!pending) {
                const reading = readPlannerVesselPosition()
                    .catch(() => null)
                    .finally(() => {
                        if (pending === reading) pending = null;
                    });
                pending = reading;
            }
            return pending;
        };
        const refresh = async (explicit = false) => {
            if (disposed || (!explicit && document.hidden)) return;
            const id = ++requestId;
            const scope = getAuthIdentityScope();
            if (explicit) {
                touched = true;
                current.current.onLocate?.();
                setBusy(true);
                setMessage('Finding yacht…');
            }
            // Bound the UI wait; an old slow reply cannot move a new account's chart.
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const fix = await Promise.race([
                fetchFix(),
                new Promise<null>((resolve) => {
                    timeout = setTimeout(() => resolve(null), 10_000);
                }),
            ]);
            clearTimeout(timeout);
            if (disposed || id !== requestId || !isAuthIdentityScopeCurrent(scope)) return;
            setBusy(false);
            if (!fix) {
                clear();
                if (explicit) setMessage('Yacht position unavailable. Connect the boat GPS or enable its cloud feed.');
                return;
            }
            latest = fix;
            draw(fix);
            const fresh = validPlannerVesselFix(fix, PLANNER_LIVE_FIX_MS);
            if (explicit || (fresh && current.current.autoCenter && !touched && !centred)) {
                centre(fix);
                centred = true;
            }
            if (explicit) setMessage(plannerVesselLabel(fix));
        };
        action.current = () => {
            void refresh(true);
        };
        const unsubscribe = subscribeAuthIdentityScope(() => {
            ++requestId;
            pending = null;
            clear();
            setBusy(false);
            setMessage('');
        });
        const timer = setInterval(() => {
            if (latest) draw(latest); // Age the marker even when the network is quiet.
            if (!pending) void refresh();
        }, 60_000);
        void refresh();
        return () => {
            disposed = true;
            ++requestId;
            clear();
            unsubscribe();
            clearInterval(timer);
            canvas.removeEventListener('pointerdown', interact);
            canvas.removeEventListener('wheel', interact);
            canvas.removeEventListener('keydown', interact);
            action.current = () => {};
        };
    }, [mapReady, mapRef]);

    return (
        <div
            className="absolute right-3 z-9996 flex flex-col items-end gap-2 pointer-events-none"
            style={{ bottom: 'calc(80px + env(safe-area-inset-bottom))' }}
        >
            {message && (
                <div
                    role="status"
                    className="pointer-events-auto flex max-w-[min(19rem,calc(100vw-24px))] gap-2 rounded-xl border border-teal-400/30 bg-slate-950/95 p-3 text-xs text-slate-100 shadow-xl"
                >
                    <span>{message}</span>
                    <button
                        type="button"
                        aria-label="Dismiss yacht location message"
                        className="shrink-0 px-1"
                        onClick={() => setMessage('')}
                    >
                        ×
                    </button>
                </div>
            )}
            <button
                type="button"
                aria-label="Locate yacht"
                title="Locate yacht"
                aria-busy={busy}
                disabled={!mapReady || busy}
                onClick={() => action.current()}
                className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-teal-300/40 bg-slate-900/95 text-teal-300 shadow-[0_0_18px_-5px_rgba(45,212,191,0.5)] hover:bg-slate-800 active:scale-95 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-teal-300"
            >
                {busy ? (
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-teal-300 border-t-transparent" />
                ) : (
                    <svg
                        width="25"
                        height="25"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        aria-hidden="true"
                    >
                        <path d="M12 3v13H4L12 3Zm2 3 6 10h-6M3 19h18l-3 3H6l-3-3Z" strokeLinejoin="round" />
                    </svg>
                )}
            </button>
        </div>
    );
}
