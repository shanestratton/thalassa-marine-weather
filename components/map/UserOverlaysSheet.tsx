import React from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { previewUserOverlay } from '../../services/userOverlays/import';
import {
    loadUserOverlays,
    saveUserOverlay,
    updateUserOverlay,
    removeUserOverlay,
    type UserOverlayLibrary,
} from '../../services/userOverlays/store';
import type { OverlayPreview } from '../../services/userOverlays/model';
import { unlockOverlayChime } from '../../services/userOverlays/audio';

const button = 'min-h-11 px-3 py-2 rounded-lg bg-white/10 disabled:opacity-40';
export default function UserOverlaysSheet({ onClose }: { onClose: () => void }) {
    const scope = React.useRef(getAuthIdentityScope()).current,
        mounted = React.useRef(true),
        controller = React.useRef<AbortController | null>(null);
    const [library, setLibrary] = React.useState<UserOverlayLibrary | null>(null),
        [preview, setPreview] = React.useState<OverlayPreview | null>(null),
        [label, setLabel] = React.useState(''),
        [busy, setBusy] = React.useState(false),
        [notice, setNotice] = React.useState('');
    React.useEffect(() => {
        mounted.current = true;
        void loadUserOverlays(scope)
            .then((v) => {
                if (mounted.current) setLibrary(v);
            })
            .catch(() => {
                if (mounted.current) setNotice('Private overlays could not be read.');
            });
        const stop = subscribeAuthIdentityScope(() => {
            controller.current?.abort();
            setPreview(null);
            setLibrary(null);
            onClose();
        });
        return () => {
            mounted.current = false;
            controller.current?.abort();
            stop();
        };
    }, [scope, onClose]);
    async function action(fn: () => Promise<unknown>) {
        setBusy(true);
        setNotice('');
        try {
            await fn();
            if (!mounted.current) return;
            const next = await loadUserOverlays(scope);
            if (mounted.current) setLibrary(next);
        } catch (e) {
            if (mounted.current) setNotice(e instanceof Error ? e.message : 'Overlay unavailable.');
        } finally {
            if (mounted.current) setBusy(false);
        }
    }
    async function choose(file: File | undefined) {
        if (!file) return;
        controller.current?.abort();
        const abort = new AbortController();
        controller.current = abort;
        setBusy(true);
        setPreview(null);
        setNotice('');
        try {
            const next = await previewUserOverlay(file, abort.signal);
            if (mounted.current && !abort.signal.aborted) {
                setPreview(next);
                setLabel(file.name.replace(/\.[^.]+$/, '').slice(0, 80));
            }
        } catch (e) {
            if (mounted.current) setNotice(e instanceof Error ? e.message : 'Overlay could not be read.');
        } finally {
            if (mounted.current) setBusy(false);
        }
    }
    return (
        <ModalSheet isOpen title="Your overlays" onClose={onClose} zIndex="z-[10080]">
            <div className="space-y-4 p-4 text-sm text-slate-200">
                <p>
                    Private files stay on this device, under your account. User overlays are reference annotations, not
                    official charts or routing data.
                </p>
                <p>
                    GeoJSON up to 4 MiB, KML up to 1 MiB, or a ZIP with one 2D shapefile, matching .dbf and geographic
                    WGS84 .prj. Projected files must be re-exported. Linked resources and converted chart packs are
                    refused.
                </p>
                <label className="block">
                    Choose local overlay
                    <input
                        aria-label="Choose local overlay"
                        type="file"
                        accept=".geojson,.json,.kml,.zip"
                        disabled={busy}
                        className="block w-full min-h-11 py-2"
                        onChange={(e) => {
                            void choose(e.target.files?.[0]);
                            e.target.value = '';
                        }}
                    />
                </label>
                {preview && (
                    <section aria-label="Overlay preview" className="space-y-3 border border-white/20 rounded p-3">
                        <p>
                            {preview.format} · {preview.data.features.length} features · {preview.vertices} vertices ·{' '}
                            {preview.polygons} polygons · {(preview.bytes / 1024).toFixed(1)} KiB.
                        </p>
                        <label className="block">
                            Overlay name
                            <input
                                value={label}
                                maxLength={80}
                                onChange={(e) => setLabel(e.target.value)}
                                className="block min-h-11 w-full rounded bg-slate-900 p-2"
                            />
                        </label>
                        <p>
                            Only geometry and short labels will be saved. Entry notices start off. No files or names are
                            uploaded.
                        </p>
                        <button
                            className={button}
                            disabled={busy || !label.trim()}
                            onClick={() =>
                                void action(async () => {
                                    await saveUserOverlay(preview, label, scope);
                                    if (mounted.current) setPreview(null);
                                })
                            }
                        >
                            Import and save overlay
                        </button>{' '}
                        <button className={button} disabled={busy} onClick={() => setPreview(null)}>
                            Discard preview
                        </button>
                    </section>
                )}
                {library && (
                    <>
                        <p>
                            {library.overlays.length}/10 overlays ·{' '}
                            {(library.overlays.reduce((n, r) => n + r.bytes, 0) / 1024 / 1024).toFixed(1)}/8 MiB.
                        </p>
                        <label className="block">
                            Entry-check position source
                            <select
                                aria-label="Entry-check position source"
                                value={library.position}
                                disabled={busy}
                                className="block min-h-11 w-full appearance-none rounded bg-slate-900 p-2 text-slate-100"
                                onChange={(e) =>
                                    void action(() =>
                                        updateUserOverlay(
                                            null,
                                            { position: e.target.value as 'boat' | 'phone' },
                                            scope,
                                        ),
                                    )
                                }
                            >
                                <option value="boat">Boat receiver — original instrument clock</option>
                                <option value="phone">This phone GPS — user overlays only</option>
                            </select>
                        </label>
                        <p>
                            Foreground only. The selected source never falls back to another position. Old, inaccurate
                            or missing fixes cannot establish an entry or an all-clear.
                        </p>
                        <label className="flex gap-2 min-h-11 items-center">
                            <input
                                type="checkbox"
                                checked={library.charts}
                                disabled={busy}
                                onChange={(e) => {
                                    if (e.target.checked) void unlockOverlayChime();
                                    void action(() => updateUserOverlay(null, { charts: e.target.checked }, scope));
                                }}
                            />
                            Entry notices for currently displayed chart areas aboard (entry restrictions, no wake,
                            avoid, speed restrictions)
                        </label>
                        <p>
                            Chart notices require the paired Pi on boat Wi-Fi and fresh boat-receiver position. They
                            inspect only open chart geometry already in memory; an omitted area is unknown. Licensed
                            names/areas are never saved. The banner and one quiet chime are advisory; higher-priority
                            alarms keep their audio.
                        </p>
                        {library.overlays.map((row) => (
                            <section
                                key={row.id}
                                aria-label={row.label}
                                className="space-y-2 rounded border border-white/20 p-3"
                            >
                                <h3 className="font-bold break-words">{row.label}</h3>
                                <p>
                                    {row.features} features · {row.polygons} polygons · imported{' '}
                                    {new Date(row.createdAt).toISOString()}
                                </p>
                                <label className="flex gap-2 min-h-11 items-center">
                                    <input
                                        type="checkbox"
                                        checked={row.visible}
                                        disabled={busy}
                                        onChange={(e) =>
                                            void action(() =>
                                                updateUserOverlay(row.id, { visible: e.target.checked }, scope),
                                            )
                                        }
                                    />
                                    Show on Obs
                                </label>
                                <label className="flex gap-2 min-h-11 items-center">
                                    <input
                                        type="checkbox"
                                        checked={row.alerts}
                                        disabled={busy || !row.polygons}
                                        onChange={(e) => {
                                            if (e.target.checked) void unlockOverlayChime();
                                            void action(() =>
                                                updateUserOverlay(row.id, { alerts: e.target.checked }, scope),
                                            );
                                        }}
                                    />
                                    Foreground polygon-entry banner and one quiet chime
                                </label>
                                <button
                                    className={button}
                                    disabled={busy}
                                    onClick={() => void action(() => removeUserOverlay(row.id, scope))}
                                >
                                    Remove {row.label}
                                </button>
                            </section>
                        ))}
                    </>
                )}
                {busy && <p role="status">Reading local overlay…</p>}
                {notice && <p role="status">{notice}</p>}
            </div>
        </ModalSheet>
    );
}
