/**
 * "My cloud" — publish this device's ENC cells to the skipper's own private
 * folder so they reach thalassawx.app/plan in a browser.
 *
 * Why publishing is a BUTTON and not automatic
 * ────────────────────────────────────────────
 * Shane's library is 345 cells / ~400 MB. An automatic first publish could
 * quietly spend 400 MB of a marina 4G plan while the phone sits in a pocket,
 * so the first run is explicit and states the size.
 *
 * This used to say Wi-Fi could not be told from cellular at all, because
 * @capacitor/network was not installed and navigator.connection does not exist
 * in iOS WKWebView. The plugin IS installed now (added 2026-08-17 for the NMEA
 * gateway's reconnect path), so `connectionType` is readable — but it is not
 * trustworthy enough to spend 400 MB on unasked: with a VPN raised, iOS
 * reports 'wifi' while the device is actually on cellular. Reading it would
 * turn a deliberate button into a guess that is wrong in exactly the case that
 * costs money, so the button stays.
 *
 * After that it stays in sync on its own: `autoPublish` picks up newly
 * imported cells, which are small increments (a Pi sync is typically a handful
 * of cells), never another 400 MB.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    getPublishPlan,
    isAutoPublishEnabled,
    publishPersonalCells,
    setAutoPublishEnabled,
    type PublishPlan,
    type PublishProgress,
} from '../../services/enc/personalCellSync';
import { triggerHaptic } from '../../utils/system';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('EncPersonalCloudPanel');

const formatBytes = (bytes: number): string =>
    bytes >= 1048576
        ? `${(bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1)} MB`
        : `${Math.ceil(bytes / 1024)} KB`;

export const EncPersonalCloudPanel: React.FC = () => {
    const [plan, setPlan] = useState<PublishPlan | null>(null);
    const [progress, setProgress] = useState<PublishProgress | null>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<string | null>(null);
    const [autoPublish, setAutoPublish] = useState(isAutoPublishEnabled);
    const abortRef = useRef<AbortController | null>(null);

    const refresh = useCallback(() => {
        void getPublishPlan()
            .then(setPlan)
            .catch(() => setPlan(null));
    }, []);

    useEffect(() => {
        refresh();
        // Abort any in-flight publish if this panel unmounts, so a collapsed
        // section doesn't keep uploading with nowhere to report progress.
        return () => abortRef.current?.abort();
    }, [refresh]);

    const handlePublish = useCallback(async () => {
        triggerHaptic('light');
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setResult(null);
        setProgress(null);
        try {
            const outcome = await publishPersonalCells({
                onProgress: setProgress,
                signal: controller.signal,
            });
            if (!outcome.available) {
                setResult('Sign in to publish charts to your own cloud.');
            } else if (outcome.cancelled) {
                setResult(`Stopped — ${outcome.uploaded} chart${outcome.uploaded === 1 ? '' : 's'} published.`);
            } else if (outcome.failed.length > 0) {
                // Name the count, not a vague "some failed" — a partial publish
                // is resumable and the next run retries exactly these.
                setResult(
                    `Published ${outcome.uploaded}. ${outcome.failed.length} could not be read or uploaded — press again to retry those.`,
                );
            } else if (outcome.uploaded > 0) {
                setResult(`Published ${outcome.uploaded} chart${outcome.uploaded === 1 ? '' : 's'}.`);
                // First successful publish opts into keeping it current, so
                // new cells follow without another visit to this screen.
                setAutoPublishEnabled(true);
                setAutoPublish(true);
            } else {
                setResult('Already up to date.');
            }
        } catch (err) {
            log.warn(`publish failed: ${err instanceof Error ? err.message : String(err)}`);
            setResult('Publish failed. Check your connection and try again.');
        } finally {
            abortRef.current = null;
            setBusy(false);
            setProgress(null);
            refresh();
        }
    }, [refresh]);

    const toggleAuto = useCallback(() => {
        triggerHaptic('light');
        setAutoPublish((previous) => {
            const next = !previous;
            setAutoPublishEnabled(next);
            return next;
        });
    }, []);

    if (!plan) return null;

    if (!plan.available) {
        return (
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
                <p className="text-[11px] font-bold uppercase tracking-wider text-white/60">My cloud</p>
                <p className="mt-1 text-[11px] leading-snug text-white/45">
                    Sign in to keep your charts on your account, so they open in a browser on thalassawx.app/plan too.
                </p>
            </div>
        );
    }

    const pending = plan.candidates.length;

    return (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-white/60">My cloud</p>
            <p className="mt-1 text-[11px] leading-snug text-white/45">
                Your charts, on your account only — so the passage planner in a browser sees the same charts as this
                device. Nobody else can read them.
            </p>

            {busy && progress ? (
                <div className="mt-3">
                    <div className="flex items-center justify-between text-[11px] font-bold text-sky-300">
                        <span>
                            Publishing {progress.done}/{progress.total}
                        </span>
                        <span className="tabular-nums">{formatBytes(progress.uploadedBytes)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                        <div
                            className="h-full rounded-full bg-sky-400 transition-[width] duration-300"
                            style={{ width: `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%` }}
                        />
                    </div>
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            abortRef.current?.abort();
                        }}
                        className="mt-2 w-full rounded-xl border border-white/[0.08] bg-white/[0.04] py-2 text-[11px] font-bold uppercase tracking-wider text-white/60 transition-all active:scale-95 hover:bg-white/[0.08]"
                    >
                        Stop
                    </button>
                </div>
            ) : (
                <button
                    onClick={() => void handlePublish()}
                    disabled={busy || pending === 0}
                    className="mt-3 w-full rounded-xl border border-sky-500/30 bg-sky-500/10 py-2 text-[11px] font-bold uppercase tracking-wider text-sky-300 transition-all active:scale-95 hover:bg-sky-500/20 disabled:opacity-50"
                >
                    {busy
                        ? 'Publishing…'
                        : pending === 0
                          ? `${plan.alreadyPublished} chart${plan.alreadyPublished === 1 ? '' : 's'} in your cloud`
                          : `Publish ${pending} chart${pending === 1 ? '' : 's'} (${formatBytes(plan.bytes)})`}
                </button>
            )}

            {result && <p className="mt-2 text-[11px] font-bold leading-snug text-amber-300">{result}</p>}

            {plan.alreadyPublished > 0 && (
                <button
                    onClick={toggleAuto}
                    className="mt-2 flex w-full items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left transition-colors hover:bg-white/[0.05]"
                >
                    <span className="text-[11px] font-bold text-white/60">Keep new charts published</span>
                    <span
                        className={`text-[11px] font-black uppercase tracking-wider ${autoPublish ? 'text-sky-300' : 'text-white/35'}`}
                    >
                        {autoPublish ? 'On' : 'Off'}
                    </span>
                </button>
            )}
        </div>
    );
};
