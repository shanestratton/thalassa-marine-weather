import React, { useEffect, useRef, useState } from 'react';
import type { AnchorWatchSnapshot, AnchorRelocateResult } from '../../services/AnchorWatchService';
import {
    anchorZoneOffset,
    anchorZonePosition,
    parseAnchorSafeZone,
    type AnchorZonePoint,
    type AnchorZoneWedge,
} from '../../utils/anchorSafeZone';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';
import { XIcon } from '../Icons';

interface Props {
    snapshot: AnchorWatchSnapshot;
    onClose: () => void;
    readToken: () => Promise<string>;
    onSave: (value: unknown, token: string) => Promise<AnchorRelocateResult>;
}
/** Finger input is manual geometry only. Nothing is read or copied from charts. */
export default function AnchorSafeZoneSheet({ snapshot, onClose, readToken, onSave }: Props) {
    const box = useFocusTrap<HTMLElement>(true, {
        onEscape: () => {
            if (!busy) onClose();
        },
    });
    const [token, setToken] = useState<string | null>(null);
    const [kind, setKind] = useState<'polygon' | 'wedges'>(snapshot.safeZone?.kind ?? 'polygon');
    const [vertices, setVertices] = useState<readonly AnchorZonePoint[]>(
        snapshot.safeZone?.kind === 'polygon' ? snapshot.safeZone.vertices : [],
    );
    const [exclusions, setExclusions] = useState<readonly AnchorZoneWedge[]>(
        snapshot.safeZone?.kind === 'wedges' ? snapshot.safeZone.exclusions : [{ startDeg: 0, sweepDeg: 45 }],
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const down = useRef(false);
    const initialRead = useRef(readToken);
    useEffect(() => {
        let live = true;
        void initialRead
            .current()
            .then((t) => {
                if (live) setToken(t);
            })
            .catch(() => {
                if (live) setError('The watch could not be read. Close and reopen the editor.');
            });
        return () => {
            live = false;
            down.current = false;
        };
    }, []);
    const anchor = snapshot.anchorPosition;
    if (!anchor) return null;
    const frame = { ...anchor, radiusM: snapshot.swingRadius };
    const proposed = {
        version: 1,
        anchor: { latitude: anchor.latitude, longitude: anchor.longitude },
        kind,
        ...(kind === 'polygon' ? { vertices } : { exclusions }),
    };
    const admission = parseAnchorSafeZone(proposed, frame);
    const scale = 100 / snapshot.swingRadius;
    const xy = (p: AnchorZonePoint): [number, number] => {
        const o = anchorZoneOffset(anchor, p);
        return o ? [120 + o[0] * scale, 120 - o[1] * scale] : [120, 120];
    };
    const add = (e: React.PointerEvent<SVGSVGElement>) => {
        if (kind !== 'polygon' || busy) return;
        const bounds = e.currentTarget.getBoundingClientRect();
        const x = (((e.clientX - bounds.left) / bounds.width) * 240 - 120) / scale;
        const y = (120 - ((e.clientY - bounds.top) / bounds.height) * 240) / scale;
        if (Math.hypot(x, y) > snapshot.swingRadius) return;
        const p = anchorZonePosition(anchor, x, y);
        if (!p) return;
        setVertices((old) => {
            const last = old.at(-1),
                offset = last && anchorZoneOffset(last, p);
            const first = old.length >= 3 && anchorZoneOffset(old[0], p);
            if (first && Math.hypot(...first) < Math.max(0.1, snapshot.swingRadius * 0.04)) return old;
            if (old.length >= 64 || (offset && Math.hypot(...offset) < Math.max(0.1, snapshot.swingRadius * 0.04)))
                return old;
            return [...old, p];
        });
    };
    const save = async (value: unknown) => {
        if (!token || busy) return;
        setBusy(true);
        setError(null);
        try {
            const result = await onSave(value, token);
            if (result.ok) onClose();
            else setError(result.error);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'The area was not saved.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <OverlayPortal
            layer="modal"
            role="presentation"
            className="flex items-center justify-center bg-black/70 px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] [html[data-keyboard-open='true']_&]:pb-4"
        >
            <section
                ref={box}
                role="dialog"
                aria-modal="true"
                aria-labelledby="anchor-safe-area-title"
                data-keyboard-focus-scope
                style={{ '--sheet-max-vh': '100%' } as React.CSSProperties}
                className="thalassa-keyboard-safe-sheet flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-slate-600 bg-slate-950 text-slate-100 shadow-xl"
            >
                <header className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-700 px-3">
                    <h2 id="anchor-safe-area-title" className="font-bold">
                        Anchor safe area
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        aria-label="Close safe-area editor"
                        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center text-slate-100"
                    >
                        <XIcon className="h-5 w-5" />
                    </button>
                </header>
                <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain p-3 text-sm">
                    <p className="[html[data-keyboard-open='true']_&]:hidden">
                        Draw around the anchor and boat, inside the circle.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                        {(['polygon', 'wedges'] as const).map((value) => (
                            <button
                                type="button"
                                key={value}
                                onClick={() => setKind(value)}
                                disabled={busy}
                                aria-pressed={kind === value}
                                className={`min-h-11 rounded-lg border px-2 ${kind === value ? 'border-cyan-300 bg-cyan-950' : 'border-slate-600'}`}
                            >
                                {value === 'polygon' ? 'Draw polygon' : 'Exclude wedges'}
                            </button>
                        ))}
                    </div>
                    <svg
                        viewBox="0 0 240 240"
                        role="img"
                        aria-label="Manual safe-area preview. Anchor at centre, enclosing circle, boat dot and proposed outline."
                        className="mx-auto aspect-square w-full max-w-64 touch-none rounded-xl bg-slate-900 [html[data-keyboard-open='true']_&]:hidden"
                        onPointerDown={(e) => {
                            down.current = true;
                            e.currentTarget.setPointerCapture(e.pointerId);
                            add(e);
                        }}
                        onPointerMove={(e) => {
                            if (down.current) add(e);
                        }}
                        onPointerUp={() => {
                            down.current = false;
                        }}
                        onPointerCancel={() => {
                            down.current = false;
                        }}
                    >
                        <circle cx="120" cy="120" r="100" fill="none" stroke="#94a3b8" strokeDasharray="4 3" />
                        {kind === 'polygon' && vertices.length > 0 && (
                            <polygon
                                points={vertices.map((p) => xy(p).join(',')).join(' ')}
                                fill="#22d3ee22"
                                stroke="#22d3ee"
                                strokeWidth="2"
                            />
                        )}
                        {kind === 'wedges' &&
                            exclusions
                                .filter((w) => Number.isFinite(w.startDeg) && Number.isFinite(w.sweepDeg))
                                .map((w, i) => {
                                    const pt = (d: number) => [
                                        120 + 100 * Math.sin((d * Math.PI) / 180),
                                        120 - 100 * Math.cos((d * Math.PI) / 180),
                                    ];
                                    return (
                                        <path
                                            key={i}
                                            d={`M120 120 L${pt(w.startDeg).join(' ')} A100 100 0 ${w.sweepDeg > 180 ? 1 : 0} 1 ${pt(w.startDeg + w.sweepDeg).join(' ')} Z`}
                                            fill="#fb718544"
                                            stroke="#fb7185"
                                        />
                                    );
                                })}
                        <text x="120" y="13" textAnchor="middle" fill="#cbd5e1" fontSize="10">
                            N · TRUE
                        </text>
                        <circle cx="120" cy="120" r="4" fill="#fbbf24" />
                        {snapshot.vesselPosition && (
                            <circle
                                cx={xy(snapshot.vesselPosition)[0]}
                                cy={xy(snapshot.vesselPosition)[1]}
                                r="4"
                                fill="#fff"
                                stroke="#0891b2"
                            />
                        )}
                    </svg>
                    {kind === 'polygon' ? (
                        <>
                            <p>
                                Tap corners or trace with your finger, in order. Enclose the anchor and the boat.{' '}
                                {vertices.length}/64 corners.
                            </p>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    disabled={busy || !vertices.length}
                                    onClick={() => setVertices((old) => old.slice(0, -1))}
                                    className="min-h-11 rounded-lg border border-slate-600"
                                >
                                    Undo corner
                                </button>
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => setVertices([])}
                                    className="min-h-11 rounded-lg border border-slate-600"
                                >
                                    Start again
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            <p>
                                Excluded clockwise wedges start at a true bearing. Their edges are outside the safe
                                area.
                            </p>
                            {exclusions.map((w, i) => (
                                <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                                    <label className="min-w-0">
                                        Start °T
                                        <input
                                            aria-label={`Wedge ${i + 1} start true bearing`}
                                            type="number"
                                            min="0"
                                            max="359.9"
                                            value={Number.isFinite(w.startDeg) ? w.startDeg : ''}
                                            onChange={(e) =>
                                                setExclusions((old) =>
                                                    old.map((q, j) =>
                                                        j === i
                                                            ? {
                                                                  ...q,
                                                                  startDeg:
                                                                      e.target.value === ''
                                                                          ? NaN
                                                                          : Number(e.target.value),
                                                              }
                                                            : q,
                                                    ),
                                                )
                                            }
                                            className="mt-1 min-h-11 w-full rounded border border-slate-500 bg-slate-900 px-2 text-white"
                                        />
                                    </label>
                                    <label className="min-w-0">
                                        Angle °
                                        <input
                                            aria-label={`Wedge ${i + 1} clockwise angle`}
                                            type="number"
                                            min="0.5"
                                            max="359"
                                            value={Number.isFinite(w.sweepDeg) ? w.sweepDeg : ''}
                                            onChange={(e) =>
                                                setExclusions((old) =>
                                                    old.map((q, j) =>
                                                        j === i
                                                            ? {
                                                                  ...q,
                                                                  sweepDeg:
                                                                      e.target.value === ''
                                                                          ? NaN
                                                                          : Number(e.target.value),
                                                              }
                                                            : q,
                                                    ),
                                                )
                                            }
                                            className="mt-1 min-h-11 w-full rounded border border-slate-500 bg-slate-900 px-2 text-white"
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        aria-label={`Remove wedge ${i + 1}`}
                                        onClick={() => setExclusions((old) => old.filter((_, j) => j !== i))}
                                        className="flex min-h-11 min-w-11 items-center justify-center"
                                    >
                                        <XIcon className="h-5 w-5" />
                                    </button>
                                </div>
                            ))}
                            <button
                                type="button"
                                disabled={busy || exclusions.length >= 8}
                                onClick={() => setExclusions((old) => [...old, { startDeg: 0, sweepDeg: 45 }])}
                                className="min-h-11 w-full rounded-lg border border-slate-600"
                            >
                                Add exclusion wedge
                            </button>
                        </>
                    )}
                    {!admission.ok && (
                        <p role="status" className="text-amber-200">
                            {admission.error}
                        </p>
                    )}
                    {error && (
                        <p role="alert" className="text-red-300">
                            {error}
                        </p>
                    )}
                    <p className="text-slate-300">
                        This phone checks the area on GPS updates. If iOS suspends the app, the native circle is the
                        backstop. Past movement and this drawing do not establish depth or clearance. A Pi handoff
                        requires a Pi that confirms custom-area support.
                    </p>
                </div>
                <footer className="grid shrink-0 grid-cols-2 gap-2 border-t border-slate-700 p-3 text-sm leading-tight">
                    <button
                        type="button"
                        aria-label="Use circle only"
                        disabled={busy || !token}
                        onClick={() => void save(null)}
                        className="min-h-11 rounded-lg border border-slate-500 px-2"
                    >
                        Circle only
                    </button>
                    <button
                        type="button"
                        aria-label="Use safe area"
                        disabled={busy || !token || !admission.ok}
                        onClick={() => void save(proposed)}
                        className="min-h-11 rounded-lg border border-cyan-300 bg-cyan-950 px-2 font-bold disabled:opacity-50"
                    >
                        {busy ? 'Saving…' : 'Use area'}
                    </button>
                </footer>
            </section>
        </OverlayPortal>
    );
}
