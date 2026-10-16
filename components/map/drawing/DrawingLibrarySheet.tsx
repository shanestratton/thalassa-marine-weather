import React from 'react';
import { ModalSheet } from '../../ui/ModalSheet';
import type { AnnotationLibrary, ChartAnnotation, DrawingKind } from '../../../services/chartAnnotations/model';
export const drawingButton =
    'min-h-11 max-w-full min-w-0 whitespace-normal [overflow-wrap:anywhere] rounded-lg bg-white/10 px-3 py-2 disabled:opacity-40';
export interface DrawingLibraryProps {
    onClose: () => void;
    library: AnnotationLibrary | null;
    busy: boolean;
    error: string;
    canDraw: boolean;
    onStart: (kind: DrawingKind, label: string) => void;
    onRuler: () => void;
    onClearRuler: () => void;
    onVisible: (row: ChartAnnotation, value: boolean) => void;
    onRemove: (row: ChartAnnotation) => void;
    onExport: (format: 'GeoJSON' | 'GPX') => void;
}
export default function DrawingLibrarySheet(p: DrawingLibraryProps) {
    const [label, setLabel] = React.useState('');
    return (
        <ModalSheet isOpen title="Draw on chart" onClose={p.onClose} zIndex="z-[10080]" fitViewport>
            <div className="space-y-4 p-4 text-sm text-slate-200">
                <p>
                    Your drawings stay on this device under your account. They are annotations, not checked routes,
                    no-go zones or anchor-watch boundaries.
                </p>
                <label className="block">
                    Drawing label
                    <input
                        className="mt-1 block min-h-11 w-full rounded bg-slate-900 p-2"
                        maxLength={80}
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                    />
                </label>
                <div className="flex flex-wrap gap-2">
                    {(['line', 'area', 'label'] as const).map((kind) => (
                        <button
                            key={kind}
                            className={drawingButton}
                            disabled={p.busy || !p.canDraw || !p.library || !label.trim()}
                            onClick={() => p.onStart(kind, label)}
                        >
                            {kind === 'line' ? 'Draw line' : kind === 'area' ? 'Draw area' : 'Place label'}
                        </button>
                    ))}
                </div>
                {!p.canDraw && <p>Finish the other chart action before drawing.</p>}
                <p>
                    Tap to place points; Undo corrects the last point. Move map enables dragging and zoom controls.
                    Finish validates and saves; Cancel discards the draft.
                </p>
                <div className="flex flex-wrap gap-2">
                    <button className={drawingButton} disabled={p.busy || !p.canDraw || !p.library} onClick={p.onRuler}>
                        Set boat EBL / VRM
                    </button>
                    <button className={drawingButton} onClick={p.onClearRuler}>
                        Clear boat ruler
                    </button>
                </div>
                <p>
                    The bearing line and range ring need a fresh boat gateway or paired-LAN position. They use true
                    north; relative bearing needs fresh true heading from the same feed. The ruler stays in memory and
                    is never exported.
                </p>
                <p>
                    {p.library?.annotations.length ?? 0}/128 drawings; at most 256 placed points each and 4,096 saved
                    vertices combined. Crew sharing is not enabled.
                </p>
                <div className="flex flex-wrap gap-2">
                    <button
                        className={drawingButton}
                        disabled={p.busy || !p.library?.annotations.length}
                        onClick={() => p.onExport('GeoJSON')}
                    >
                        Export GeoJSON
                    </button>
                    <button
                        className={drawingButton}
                        disabled={p.busy || !p.library?.annotations.length}
                        onClick={() => p.onExport('GPX')}
                    >
                        Export GPX
                    </button>
                </div>
                <p>
                    GeoJSON preserves all drawings. GPX preserves points and lines; an area makes the whole GPX export
                    unavailable.
                </p>
                {p.library?.annotations.map((row) => (
                    <section key={row.id} className="space-y-2 rounded border border-white/20 p-3">
                        <h3 className="font-bold [overflow-wrap:anywhere]">{row.label}</h3>
                        <p>
                            {row.geometry.type}; revision {row.revision}
                        </p>
                        <label className="flex min-h-11 items-center gap-2">
                            <input
                                type="checkbox"
                                checked={row.visible}
                                disabled={p.busy}
                                onChange={(e) => p.onVisible(row, e.target.checked)}
                            />
                            Show drawing on Obs
                        </label>
                        <button className={drawingButton} disabled={p.busy} onClick={() => p.onRemove(row)}>
                            Remove {row.label}
                        </button>
                    </section>
                ))}
                {p.busy && <p role="status">Saving private drawings...</p>}
                {p.error && <p role="status">{p.error}</p>}
            </div>
        </ModalSheet>
    );
}
