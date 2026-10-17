import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { noaaAgreementAccepted, NOAA_AGREEMENT_URL } from '../../services/enc/noaaAgreement';
import {
    installNoaaCell,
    loadNoaaArea,
    removeNoaaDownload,
    savedNoaaDownloads,
    type NoaaAreaCatalogue,
    type NoaaDownload,
} from '../../services/enc/noaaCatalogue';
import { noaaRevisionNewer, type NoaaBounds } from '../../services/enc/noaaCatalogueContract';
import { getRegisteredCell } from '../../services/enc/EncCellMetadata';

const NoaaAgreementSheet = lazy(() => import('./NoaaAgreementSheet'));
export default function NoaaCatalogueSheet({ onClose, bounds }: { onClose: () => void; bounds: NoaaBounds | null }) {
    const scope = useRef(getAuthIdentityScope()).current;
    const alive = useRef(true),
        request = useRef<AbortController | null>(null),
        close = useRef(onClose);
    close.current = onClose;
    const [accepted, setAccepted] = useState(false),
        [agreement, setAgreement] = useState(false);
    const [area, setArea] = useState<NoaaAreaCatalogue | null>(null),
        [downloads, setDownloads] = useState<NoaaDownload[]>([]);
    const [busy, setBusy] = useState<string | null>(null),
        [error, setError] = useState<string | null>(null);
    const visible = (): boolean => alive.current && isAuthIdentityScopeCurrent(scope);
    const read = useCallback(
        async (refresh = false) => {
            if (!bounds || !isAuthIdentityScopeCurrent(scope)) return;
            request.current?.abort();
            const controller = new AbortController();
            request.current = controller;
            setBusy('catalogue');
            setError(null);
            try {
                const result = await loadNoaaArea(bounds, { refresh, signal: controller.signal });
                const saved = await savedNoaaDownloads(scope);
                if (alive.current && !controller.signal.aborted && isAuthIdentityScopeCurrent(scope)) {
                    setArea(result);
                    setDownloads(saved);
                }
            } catch (e) {
                if (alive.current && !controller.signal.aborted && isAuthIdentityScopeCurrent(scope))
                    setError(e instanceof Error ? e.message : 'NOAA catalogue unavailable.');
            } finally {
                if (alive.current && !controller.signal.aborted && isAuthIdentityScopeCurrent(scope)) setBusy(null);
            }
        },
        [bounds, scope],
    );
    useEffect(() => {
        alive.current = true;
        const unsubscribe = subscribeAuthIdentityScope(() => {
            request.current?.abort();
            setArea(null);
            setDownloads([]);
            setAccepted(false);
            close.current();
        });
        void noaaAgreementAccepted(scope).then((value) => {
            if (!alive.current || !isAuthIdentityScopeCurrent(scope)) return;
            setAccepted(value);
            if (value) void read();
        });
        return () => {
            alive.current = false;
            request.current?.abort();
            unsubscribe();
        };
    }, [scope, read]);
    const act = async (id: string, operation: () => Promise<void>): Promise<void> => {
        if (busy || !visible()) return;
        setBusy(id);
        setError(null);
        try {
            await operation();
            const saved = await savedNoaaDownloads(scope);
            if (visible()) setDownloads(saved);
        } catch (e) {
            if (visible()) setError(e instanceof Error ? e.message : 'NOAA chart could not be saved.');
        } finally {
            if (visible()) setBusy(null);
        }
    };
    return (
        <>
            <ModalSheet isOpen onClose={onClose} title="NOAA ENC catalogue" zIndex="z-10060">
                <div className="space-y-4 p-4 text-sm text-slate-200">
                    <p>
                        NOAA coverage in the chart area. Cells render on this phone after download; no boat computer is
                        required.
                    </p>
                    <p className="text-xs text-slate-400">
                        Contains NOAA ENC data. This Thalassa display is not certified ECDIS and does not replace
                        required charts. Original NOAA ZIPs are preserved unchanged; the rendered copy is a conversion.
                    </p>
                    <a className="text-sky-300 underline" href={NOAA_AGREEMENT_URL} target="_blank" rel="noreferrer">
                        NOAA ENC origin and user agreement
                    </a>
                    {!accepted ? (
                        <div className="space-y-2">
                            <p>
                                Read and accept the NOAA agreement for this account before opening its catalogue or
                                downloading cells.
                            </p>
                            <button
                                type="button"
                                className="rounded bg-sky-800 px-4 py-3"
                                onClick={() => setAgreement(true)}
                            >
                                Read NOAA agreement
                            </button>
                        </div>
                    ) : (
                        <>
                            {!bounds && <p>Move the chart to the area you want, then reopen the catalogue.</p>}
                            <button
                                type="button"
                                disabled={!!busy || !bounds}
                                className="rounded border border-slate-600 px-4 py-3 disabled:opacity-50"
                                onClick={() => void read(true)}
                            >
                                Check editions now
                            </button>
                            {area && (
                                <p className="text-xs text-slate-400">
                                    {area.saved ? 'Saved catalogue' : 'Catalogue received'}{' '}
                                    {new Date(area.checkedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.
                                    <br />
                                    Publisher checked NOAA {area.index.checkedAt.replace('T', ' ').slice(0, 16)} UTC.
                                    Edition checks run weekly on normal network; downloads require a current check.
                                </p>
                            )}
                            {busy === 'catalogue' && <p role="status">Reading NOAA catalogue…</p>}
                            {area && !area.cells.length && (
                                <p>No active NOAA ENC cells cover this chart area. NOAA coverage is not worldwide.</p>
                            )}
                            <ul className="space-y-3">
                                {area?.cells.map((cell) => {
                                    const held = getRegisteredCell(cell.id),
                                        newer = held && noaaRevisionNewer(cell, held);
                                    const chartObject = cell.chart ?? cell.package?.manifest,
                                        zipObject = cell.zip ?? cell.package?.zip;
                                    const same =
                                        held?.sourceHO === 'US' &&
                                        (!held.noaaPackage || held.noaaPackage.owner === scope.key) &&
                                        held.edition === cell.edition &&
                                        held.updateNumber === cell.update &&
                                        held.contentSha256 === chartObject?.sha256 &&
                                        downloads.some(
                                            (row) =>
                                                row.id === cell.id &&
                                                row.installed &&
                                                !row.withdrawn &&
                                                row.zipSha256 === zipObject?.sha256,
                                        );
                                    return (
                                        <li key={cell.id} className="rounded border border-slate-700 p-3">
                                            <p className="font-semibold">
                                                {cell.id}{' '}
                                                {newer && (
                                                    <span className="text-amber-300"> · Newer edition/update</span>
                                                )}
                                                {same && <span className="text-emerald-300"> · Saved on phone</span>}
                                            </p>
                                            <p>{cell.title}</p>
                                            <p className="text-xs text-slate-400">
                                                Edition{cell.edition} · update{cell.update} · issued{cell.issued} · 1:
                                                {cell.scale.toLocaleString()}
                                            </p>
                                            {chartObject && zipObject ? (
                                                <button
                                                    type="button"
                                                    disabled={!!busy || same}
                                                    className="mt-2 rounded bg-sky-800 px-3 py-3 disabled:opacity-50"
                                                    onClick={() => {
                                                        request.current?.abort();
                                                        const controller = new AbortController();
                                                        request.current = controller;
                                                        void act(cell.id, () =>
                                                            installNoaaCell(cell, controller.signal),
                                                        );
                                                    }}
                                                >
                                                    {busy === cell.id
                                                        ? 'Saving original and chart…'
                                                        : same
                                                          ? 'Current copy saved'
                                                          : `${newer ? 'Update' : 'Download'} · ${(((cell.package?.bytes ?? chartObject.bytes) + zipObject.bytes) / 1048576).toFixed(1)}MiB`}
                                                </button>
                                            ) : (
                                                <p className="mt-2 text-xs text-amber-200">
                                                    Current NOAA edition is listed; a verified phone conversion is not
                                                    yet available. No chart download will start.
                                                </p>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                            {!!downloads.length && (
                                <details>
                                    <summary className="cursor-pointer py-3">
                                        Saved original NOAA archives ({downloads.length}/32)
                                    </summary>
                                    <ul className="space-y-3">
                                        {downloads.map((row) => (
                                            <li key={row.zipSha256} className="rounded border border-slate-700 p-3">
                                                <p>
                                                    {row.id} · edition{row.edition} update{row.update} ·{' '}
                                                    {(row.bytes / 1048576).toFixed(2)}MiB
                                                </p>
                                                <p className={row.withdrawn ? 'text-amber-300' : 'text-slate-400'}>
                                                    {row.withdrawn
                                                        ? 'Withdrawn by NOAA. This catalogue-installed conversion was detached; original ZIP retained for reference.'
                                                        : row.installed
                                                          ? 'Unaltered original ZIP retained on this device.'
                                                          : 'Download incomplete; reserved storage remains until removed.'}
                                                </p>
                                                <button
                                                    type="button"
                                                    disabled={!!busy}
                                                    className="mt-2 rounded border border-slate-600 px-3 py-3 disabled:opacity-50"
                                                    onClick={() => void act(row.id, () => removeNoaaDownload(row))}
                                                >
                                                    Remove this download and original
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                        </>
                    )}
                    {error && (
                        <p role="alert" className="text-amber-200">
                            {error}
                        </p>
                    )}
                </div>
            </ModalSheet>
            {agreement && (
                <Suspense fallback={null}>
                    <NoaaAgreementSheet
                        onClose={() => setAgreement(false)}
                        onAccepted={() => {
                            setAgreement(false);
                            setAccepted(true);
                            void read();
                        }}
                    />
                </Suspense>
            )}
        </>
    );
}
