import React from 'react';
import mapboxgl from 'mapbox-gl';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../../services/authIdentityScope';
import { getPairing } from '../../../services/PiPairingService';
import { piCache } from '../../../services/PiCacheService';
import { isPinnedTransportAvailable } from '../../../services/piTls';
import { NmeaStore } from '../../../services/NmeaStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { overlayDisplayData, safeLabel, type OverlayData } from '../../../services/userOverlays/model';
import { addDrawingPoint, finishDrawing, type DrawingDraft } from '../../../services/chartAnnotations/draft';
import type { AnnotationLibrary, DrawingKind } from '../../../services/chartAnnotations/model';
import {
    loadAnnotations,
    saveAnnotation,
    changeAnnotation,
    removeAnnotation,
    subscribeAnnotations,
} from '../../../services/chartAnnotations/store';
import {
    qualifiedRulerFix,
    boatRulerTo,
    boatRulerData,
    type RulerFix,
    type BoatRuler,
} from '../../../services/chartAnnotations/ruler';
import DrawingLibrarySheet, { drawingButton } from './DrawingLibrarySheet';
import {
    ANNOTATION_SOURCE,
    DRAFT_SOURCE,
    RULER_SOURCE,
    putDrawingData,
    removeDrawingData,
    type DrawingData,
} from './annotationRenderer';

export interface ChartDrawingToolsProps {
    map: mapboxgl.Map | null;
    mapReady: boolean;
    active: boolean;
    canDraw: boolean;
    open: boolean;
    onClose: () => void;
    onInteractionChange?: (owned: boolean) => void;
    className?: string;
}
export default function ChartDrawingTools({
    map,
    mapReady,
    active,
    canDraw,
    open,
    onClose,
    onInteractionChange,
    className = 'absolute bottom-[calc(env(safe-area-inset-bottom)+4rem+96px)] left-3 right-20 z-40 max-h-[35%] overflow-y-auto',
}: ChartDrawingToolsProps) {
    const [library, setLibrary] = React.useState<AnnotationLibrary | null>(null),
        [draft, setDraft] = React.useState<DrawingDraft | null>(null),
        [pickingRuler, setPickingRuler] = React.useState(false),
        [ruler, setRuler] = React.useState<BoatRuler | null>(null),
        [fix, setFix] = React.useState<RulerFix | null>(null),
        [busy, setBusy] = React.useState(false),
        [error, setError] = React.useState(''),
        [collapsed, setCollapsed] = React.useState(false),
        [foreground, setForeground] = React.useState(!Capacitor.isNativePlatform());
    const closeRef = React.useRef(onClose),
        nativeActive = React.useRef(!Capacitor.isNativePlatform()),
        generation = React.useRef(0),
        actionEpoch = React.useRef(0),
        live = React.useRef({ active, foreground }),
        libraryScope = React.useRef<AuthIdentityScope | null>(null),
        positionFloor = React.useRef(Date.now()),
        sourceBinding = React.useRef(''),
        mounted = React.useRef(false),
        markers = React.useRef<mapboxgl.Marker[]>([]),
        data = React.useRef<Record<string, DrawingData>>({}),
        pointer = React.useRef<{
            id: number;
            x: number;
            y: number;
            startX: number;
            startY: number;
            moved: boolean;
        } | null>(null),
        multiple = React.useRef(false),
        pointers = React.useRef(new Set<number>());
    const renderedScope = libraryScope.current;
    closeRef.current = onClose;
    live.current = { active, foreground };
    const invalidate = React.useCallback(() => {
        generation.current++;
        actionEpoch.current++;
    }, []);
    const currentOwner = React.useCallback(() => {
        const s = getAuthIdentityScope();
        const pairing = getPairing();
        return JSON.stringify([
            s.key,
            s.generation,
            useSettingsStore.getState().activeVesselId ?? null,
            pairing?.deviceId ?? null,
            pairing?.publicKeySpki ?? null,
            pairing?.pairedAt ?? null,
        ]);
    }, []);
    const session = active && mapReady && foreground && canDraw && (!!draft || pickingRuler);
    const clearMarkers = React.useCallback(() => {
        for (const m of markers.current) m.remove();
        markers.current = [];
    }, []);
    const clearMap = React.useCallback(() => {
        clearMarkers();
        if (map) for (const id of [ANNOTATION_SOURCE, DRAFT_SOURCE, RULER_SOURCE]) removeDrawingData(map, id);
        data.current = {};
    }, [map, clearMarkers]);
    const load = React.useCallback(async () => {
        const seq = ++generation.current,
            scope = getAuthIdentityScope();
        if (!scope.userId) {
            libraryScope.current = null;
            setLibrary(null);
            setError('Sign in to manage your private drawings.');
            return;
        }
        try {
            const next = await loadAnnotations(scope);
            if (mounted.current && seq === generation.current && isAuthIdentityScopeCurrent(scope)) {
                libraryScope.current = scope;
                setLibrary(next);
            }
        } catch {
            if (mounted.current && seq === generation.current) {
                setLibrary(null);
                setError('Private drawings could not be read.');
            }
        }
    }, []);
    React.useEffect(() => {
        mounted.current = true;
        const retire = () => {
            generation.current++;
            actionEpoch.current++;
            libraryScope.current = null;
            positionFloor.current = Date.now();
            setLibrary(null);
            setBusy(false);
            setError('');
            setDraft(null);
            setPickingRuler(false);
            setRuler(null);
            setFix(null);
            clearMap();
        };
        const auth = subscribeAuthIdentityScope(() => {
            retire();
            closeRef.current();
            if (active) void load();
        });
        const changed = subscribeAnnotations(() => {
            if (active) void load();
        });
        const settings = useSettingsStore.subscribe((s, p) => {
            if (s.activeVesselId !== p.activeVesselId) {
                actionEpoch.current++;
                setBusy(false);
                positionFloor.current = Date.now();
                setDraft(null);
                setRuler(null);
                setFix(null);
                setPickingRuler(false);
            }
        });
        if (active) void load();
        else retire();
        return () => {
            mounted.current = false;
            invalidate();
            auth();
            changed();
            settings();
            clearMap();
        };
    }, [active, clearMap, load, invalidate]);
    React.useEffect(() => {
        if (!active || !canDraw || !foreground) {
            actionEpoch.current++;
            setBusy(false);
            setDraft(null);
            setPickingRuler(false);
            pointer.current = null;
            pointers.current.clear();
        }
        if (!active || !foreground) {
            setRuler(null);
            setFix(null);
        }
    }, [active, canDraw, foreground]);
    React.useEffect(() => {
        onInteractionChange?.(!!session);
        return () => onInteractionChange?.(false);
    }, [session, onInteractionChange]);
    React.useEffect(() => {
        let stopped = false,
            listener: { remove: () => Promise<void> } | null = null;
        const changed = () => {
            setForeground(document.visibilityState === 'visible' && nativeActive.current);
            setDraft(null);
            setPickingRuler(false);
            setRuler(null);
        };
        document.addEventListener('visibilitychange', changed);
        if (Capacitor.isNativePlatform()) {
            void App.getState()
                .then((s) => {
                    if (!stopped) {
                        nativeActive.current = s.isActive;
                        setForeground(s.isActive && document.visibilityState === 'visible');
                    }
                })
                .catch(() => {});
            void App.addListener('appStateChange', (s) => {
                if (!stopped) {
                    nativeActive.current = s.isActive;
                    setForeground(s.isActive && document.visibilityState === 'visible');
                    setDraft(null);
                    setPickingRuler(false);
                    setRuler(null);
                }
            })
                .then((h) => {
                    if (stopped) void h.remove();
                    else listener = h;
                })
                .catch(() => {
                    if (!stopped) setForeground(false);
                });
        }
        return () => {
            stopped = true;
            document.removeEventListener('visibilitychange', changed);
            void listener?.remove();
        };
    }, []);
    const readFix = React.useCallback(() => {
        const evidence = NmeaStore.getState().instrumentEvidence,
            owner = currentOwner(),
            base = piCache.lanBaseUrlNow(),
            binding = `${owner}:${base ?? ''}:${evidence?.identity ?? ''}:${evidence?.via ?? ''}`;
        if (sourceBinding.current !== binding) {
            sourceBinding.current = binding;
            positionFloor.current = Date.now();
        }
        const value =
            getAuthIdentityScope().userId &&
            document.visibilityState === 'visible' &&
            (evidence?.via !== 'lan' || (!!getPairing() && !!base && isPinnedTransportAvailable()))
                ? qualifiedRulerFix(evidence, Date.now(), owner)
                : null;
        return value && value.at > positionFloor.current ? value : null;
    }, [currentOwner]);
    React.useEffect(() => {
        if (!active || !foreground) return;
        positionFloor.current = Date.now();
        const tick = () => {
            const next = readFix();
            setFix((old) =>
                old?.at === next?.at && old?.identity === next?.identity && old?.headingAt === next?.headingAt
                    ? old
                    : next,
            );
            setRuler((old) => (old && next && old.identity !== next.identity ? null : old));
        };
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [active, foreground, readFix]);
    const put = React.useCallback(
        (id: string, value: DrawingData, color: string) => {
            data.current[id] = value;
            if (map && mapReady && active)
                try {
                    putDrawingData(map, id, value, color);
                } catch {
                    /* await style */
                }
        },
        [map, mapReady, active],
    );
    React.useEffect(() => {
        if (!map || !mapReady || !active) return;
        clearMarkers();
        const visible = library?.annotations.filter((r) => r.visible) ?? [];
        const display = overlayDisplayData({
            type: 'FeatureCollection',
            features: visible.map((r) => ({
                type: 'Feature',
                id: r.id,
                properties: { label: r.label },
                geometry: r.geometry,
            })),
        });
        put(ANNOTATION_SOURCE, display, '#67e8f9');
        for (const row of visible) {
            const g = row.geometry,
                p =
                    g.type === 'Point'
                        ? g.coordinates
                        : g.type === 'LineString'
                          ? g.coordinates[0]
                          : g.coordinates[0][0];
            const node = document.createElement('span');
            node.textContent = row.label;
            node.className =
                'max-w-40 [overflow-wrap:anywhere] rounded bg-slate-950/90 px-2 py-1 text-xs text-cyan-100 pointer-events-none';
            markers.current.push(
                new mapboxgl.Marker({ element: node, anchor: 'bottom', offset: [0, -8] })
                    .setLngLat([p[0], p[1]])
                    .addTo(map),
            );
        }
        return clearMarkers;
    }, [map, mapReady, active, library, put, clearMarkers]);
    React.useEffect(() => {
        const features: OverlayData['features'] = [];
        if (draft?.points.length) {
            const points = draft.points;
            features.push({
                type: 'Feature',
                properties: { label: draft.label },
                geometry:
                    points.length === 1
                        ? { type: 'Point', coordinates: points[0] }
                        : {
                              type: 'LineString',
                              coordinates: draft.kind === 'area' && points.length > 2 ? [...points, points[0]] : points,
                          },
            });
        }
        put(DRAFT_SOURCE, overlayDisplayData({ type: 'FeatureCollection', features }), '#f0abfc');
    }, [draft, put]);
    const measured = boatRulerData(ruler, fix);
    React.useEffect(() => {
        put(
            RULER_SOURCE,
            { type: 'FeatureCollection', features: boatRulerData(ruler, fix)?.features ?? [] },
            '#fbbf24',
        );
    }, [ruler, fix, put]);
    React.useEffect(() => {
        if (!map || !mapReady || !active) return;
        const style = () => {
            if (!map.isStyleLoaded()) return;
            for (const [id, color] of [
                [ANNOTATION_SOURCE, '#67e8f9'],
                [DRAFT_SOURCE, '#f0abfc'],
                [RULER_SOURCE, '#fbbf24'],
            ])
                if (!map.getSource(id) && data.current[id]) putDrawingData(map, id, data.current[id], color);
        };
        map.on('style.load', style);
        map.on('styledata', style);
        return () => {
            map.off('style.load', style);
            map.off('styledata', style);
        };
    }, [map, mapReady, active]);
    async function action(fn: (scope: AuthIdentityScope) => Promise<AnnotationLibrary>) {
        const scope = renderedScope,
            epoch = actionEpoch.current;
        const current = () =>
            mounted.current &&
            live.current.active &&
            live.current.foreground &&
            nativeActive.current &&
            document.visibilityState === 'visible' &&
            actionEpoch.current === epoch &&
            !!scope &&
            isAuthIdentityScopeCurrent(scope);
        if (!scope || scope !== libraryScope.current || !current()) return false;
        setBusy(true);
        setError('');
        try {
            const next = await fn(scope);
            if (current()) setLibrary(next);
            return current();
        } catch (e) {
            if (current()) setError(e instanceof Error ? e.message : 'Private drawing unavailable.');
            return false;
        } finally {
            if (current()) setBusy(false);
        }
    }
    function start(kind: DrawingKind, label: string) {
        if (
            !canDraw ||
            !active ||
            !foreground ||
            !library ||
            !renderedScope ||
            !isAuthIdentityScopeCurrent(renderedScope)
        )
            return;
        setError('');
        setCollapsed(false);
        setPickingRuler(false);
        setDraft({ kind, label: safeLabel(label, 'User drawing'), points: [], moving: false });
        onClose();
    }
    async function finish() {
        if (!draft || !library || busy) return;
        try {
            const geometry = finishDrawing(draft);
            if (await action((scope) => saveAnnotation(geometry, draft.label, library.revision, scope))) setDraft(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Drawing invalid.');
        }
    }
    async function exportFile(format: 'GeoJSON' | 'GPX') {
        if (!library) return;
        const scope = renderedScope;
        if (!scope || !isAuthIdentityScopeCurrent(scope)) return;
        const epoch = actionEpoch.current,
            owner = currentOwner();
        const current = () =>
            mounted.current &&
            actionEpoch.current === epoch &&
            currentOwner() === owner &&
            live.current.active &&
            live.current.foreground &&
            nativeActive.current &&
            document.visibilityState === 'visible' &&
            isAuthIdentityScopeCurrent(scope);
        setBusy(true);
        setError('');
        try {
            const { annotationsGeoJSON, annotationsGPX } = await import('../../../services/chartAnnotations/exports');
            const text = format === 'GeoJSON' ? annotationsGeoJSON(library) : annotationsGPX(library);
            const { handoffAnnotationFile } = await import('../../../services/chartAnnotations/handoff');
            if (!current()) return;
            await handoffAnnotationFile(text, format, scope, { isCurrent: current });
        } catch (e) {
            if (current()) setError(e instanceof Error ? e.message : 'Export unavailable.');
        } finally {
            if (mounted.current && isAuthIdentityScopeCurrent(scope)) setBusy(false);
        }
    }
    function place(clientX: number, clientY: number) {
        if (busy || !map || !session || !renderedScope || !isAuthIdentityScopeCurrent(renderedScope)) return;
        const b = map.getCanvas().getBoundingClientRect(),
            p = map.unproject([clientX - b.left, clientY - b.top]);
        try {
            setError('');
            if (pickingRuler) {
                const current = readFix();
                if (!current) throw Error('Fresh boat position unavailable. The ruler was not set.');
                setRuler(boatRulerTo(current, { lat: p.lat, lon: p.lng }));
                setPickingRuler(false);
            } else if (draft) setDraft(addDrawingPoint(draft, p.lng, p.lat));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Chart point unavailable.');
        }
    }
    return (
        <>
            {active && open && (
                <DrawingLibrarySheet
                    onClose={onClose}
                    library={library}
                    busy={busy}
                    error={error}
                    canDraw={canDraw && foreground}
                    onStart={start}
                    onRuler={() => {
                        setDraft(null);
                        setPickingRuler(true);
                        setError('');
                        onClose();
                    }}
                    onClearRuler={() => {
                        setRuler(null);
                        setPickingRuler(false);
                    }}
                    onVisible={(r, value) => {
                        if (library)
                            void action((scope) =>
                                changeAnnotation(r.id, r.revision, library.revision, { visible: value }, scope),
                            );
                    }}
                    onRemove={(r) => {
                        if (library)
                            void action((scope) => removeAnnotation(r.id, r.revision, library.revision, scope));
                    }}
                    onExport={(format) => void exportFile(format)}
                />
            )}
            {session && (
                <div
                    role="application"
                    aria-label="Chart drawing surface"
                    className="absolute inset-0 z-30"
                    style={{ touchAction: 'none' }}
                    onContextMenu={(e) => e.preventDefault()}
                    onPointerDown={(e) => {
                        e.preventDefault();
                        pointers.current.add(e.pointerId);
                        if (pointers.current.size > 1) {
                            multiple.current = true;
                            pointer.current = null;
                            return;
                        }
                        multiple.current = false;
                        pointer.current = {
                            id: e.pointerId,
                            x: e.clientX,
                            y: e.clientY,
                            startX: e.clientX,
                            startY: e.clientY,
                            moved: false,
                        };
                        e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                        const p = pointer.current;
                        if (busy || !p || p.id !== e.pointerId || multiple.current) return;
                        const dx = e.clientX - p.x,
                            dy = e.clientY - p.y;
                        p.moved ||= Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > 8;
                        if (draft?.moving && map) {
                            map.panBy([-dx, -dy], { duration: 0 });
                        }
                        p.x = e.clientX;
                        p.y = e.clientY;
                    }}
                    onPointerUp={(e) => {
                        pointers.current.delete(e.pointerId);
                        const p = pointer.current;
                        pointer.current = null;
                        if (
                            !pointers.current.size &&
                            !multiple.current &&
                            p?.id === e.pointerId &&
                            !p.moved &&
                            !draft?.moving
                        )
                            place(e.clientX, e.clientY);
                        if (!pointers.current.size) multiple.current = false;
                    }}
                    onPointerCancel={(e) => {
                        pointers.current.delete(e.pointerId);
                        pointer.current = null;
                        multiple.current = pointers.current.size > 0;
                    }}
                />
            )}
            {active && (session || ruler || (error && !open)) && (
                <aside
                    aria-label="Chart drawing tools"
                    className={`${className} space-y-2 rounded-xl border border-cyan-300/30 bg-slate-950/95 p-3 text-sm text-slate-100`}
                >
                    <button
                        type="button"
                        className={drawingButton}
                        aria-expanded={!collapsed}
                        onClick={() => setCollapsed(!collapsed)}
                    >
                        {collapsed ? 'Expand drawing tools' : 'Minimise drawing tools'}
                    </button>
                    {!collapsed && (
                        <>
                            {draft && (
                                <>
                                    <p className="[overflow-wrap:anywhere]">
                                        {draft.label}: {draft.kind}, {draft.points.length}/256 points.{' '}
                                        {draft.moving ? 'Drag to move the map.' : 'Tap the chart to add a point.'}
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            className={drawingButton}
                                            disabled={busy || draft.moving}
                                            onClick={() => {
                                                const canvas = map?.getCanvas().getBoundingClientRect();
                                                if (canvas)
                                                    place(
                                                        canvas.left + canvas.width / 2,
                                                        canvas.top + canvas.height / 2,
                                                    );
                                            }}
                                        >
                                            Add map centre
                                        </button>
                                        <button
                                            className={drawingButton}
                                            disabled={busy || !draft.points.length}
                                            onClick={() => setDraft({ ...draft, points: draft.points.slice(0, -1) })}
                                        >
                                            Undo point
                                        </button>
                                        <button
                                            className={drawingButton}
                                            disabled={busy}
                                            onClick={() => setDraft({ ...draft, moving: !draft.moving })}
                                        >
                                            {draft.moving ? 'Resume drawing' : 'Move map'}
                                        </button>
                                        <button className={drawingButton} disabled={busy} onClick={() => void finish()}>
                                            Finish and save
                                        </button>
                                        <button
                                            className={drawingButton}
                                            disabled={busy}
                                            onClick={() => {
                                                setDraft(null);
                                                setError('');
                                            }}
                                        >
                                            Cancel drawing
                                        </button>
                                    </div>
                                    {draft.moving && (
                                        <div className="flex flex-wrap gap-2">
                                            {(
                                                [
                                                    ['North', 0, -80],
                                                    ['South', 0, 80],
                                                    ['West', -80, 0],
                                                    ['East', 80, 0],
                                                ] as const
                                            ).map(([label, x, y]) => (
                                                <button
                                                    key={label}
                                                    className={drawingButton}
                                                    onClick={() => map?.panBy([x, y], { duration: 0 })}
                                                >
                                                    {label}
                                                </button>
                                            ))}
                                            <button
                                                className={drawingButton}
                                                aria-label="Drawing zoom in"
                                                onClick={() => map?.zoomIn({ duration: 0 })}
                                            >
                                                Zoom +
                                            </button>
                                            <button
                                                className={drawingButton}
                                                aria-label="Drawing zoom out"
                                                onClick={() => map?.zoomOut({ duration: 0 })}
                                            >
                                                Zoom -
                                            </button>
                                        </div>
                                    )}
                                </>
                            )}
                            {pickingRuler && (
                                <>
                                    <p>
                                        Tap a chart point for the boat-centred true bearing line and range ring. Fresh
                                        boat position is required.
                                    </p>
                                    <button
                                        className={drawingButton}
                                        onClick={() => {
                                            const canvas = map?.getCanvas().getBoundingClientRect();
                                            if (canvas)
                                                place(canvas.left + canvas.width / 2, canvas.top + canvas.height / 2);
                                        }}
                                    >
                                        Use map centre for ruler
                                    </button>
                                    <button className={drawingButton} onClick={() => setPickingRuler(false)}>
                                        Cancel ruler pick
                                    </button>
                                </>
                            )}
                            {ruler && (
                                <>
                                    <p>
                                        {measured && fix
                                            ? `EBL ${ruler.bearingTrue.toFixed(1)} degrees true; VRM ${ruler.rangeNm.toFixed(3)} NM. ${fix.source}, ${new Date(fix.at).toISOString()}. ${measured.relative === null ? 'Relative bearing unknown: true heading unavailable.' : `Relative bearing ${measured.relative.toFixed(1)} degrees; heading UTC ${new Date(fix.headingAt!).toISOString()}.`}`
                                            : 'Boat ruler unknown: selected original position is unavailable.'}
                                    </p>
                                    <button className={drawingButton} onClick={() => setRuler(null)}>
                                        Clear ruler
                                    </button>
                                </>
                            )}
                            {error && !open && <p role="status">{error}</p>}
                        </>
                    )}
                </aside>
            )}
        </>
    );
}
