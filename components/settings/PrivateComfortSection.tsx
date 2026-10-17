import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import {
    deletePrivateComfort,
    loadPrivateComfort,
    pendingPrivateComfort,
    privateComfortSnapshot,
    privateComfortViewKey,
    reportPrivateComfort,
    resetPrivateComfort,
    subscribePrivateComfort,
} from '../../services/comfort/privateComfort';
import { PERSONAL_COMFORT_INPUTS } from '../../utils/comfortPreference';
const WORDS = ['Comfortable', 'Lively', 'Uncomfortable', 'Hard going'];
/** Separate owner-private sidecar; no edits to shared ship-log entry types. */
export default function PrivateComfortSection() {
    const [open, setOpen] = useState(false),
        [busy, setBusy] = useState(false),
        [message, setMessage] = useState('');
    const [pending, setPending] = useState<Awaited<ReturnType<typeof pendingPrivateComfort>>>(null);
    const state = useSyncExternalStore(subscribePrivateComfort, privateComfortSnapshot, () => null);
    useEffect(() => {
        if (!open) return;
        let current = true;
        void loadPrivateComfort().then(async (value) => {
            if (current && !value)
                setMessage('Private reports are unavailable. Confirm this is your current owned vessel and reconnect.');
            const queued = await pendingPrivateComfort();
            if (current) setPending(queued);
        });
        return () => {
            current = false;
        };
    }, [open]);
    const action = async (fn: () => Promise<unknown>) => {
        if (busy) return;
        setBusy(true);
        setMessage('');
        try {
            const text = await fn();
            if (typeof text === 'string') setMessage(text);
        } catch (error) {
            setMessage(error instanceof Error ? error.message : 'Private action could not be confirmed.');
        } finally {
            setPending(await pendingPrivateComfort().catch(() => null));
            setBusy(false);
        }
    };
    const pendingRows = pending?.key === privateComfortViewKey() ? pending.rows : [];
    return (
        <>
            <button
                type="button"
                className="min-h-11 w-full rounded-lg border border-sky-500/30 px-3 text-left text-sm font-bold text-sky-200"
                onClick={() => {
                    setMessage('');
                    setOpen(true);
                }}
            >
                Private passage comfort
            </button>
            <ModalSheet
                isOpen={open}
                onClose={() => setOpen(false)}
                title="Private passage comfort"
                fitViewport
                footer={
                    <button
                        type="button"
                        className="min-h-11 w-full rounded-lg bg-sky-500/20 px-4 font-bold text-white"
                        onClick={() => setOpen(false)}
                    >
                        Done
                    </button>
                }
            >
                <div className="space-y-4 text-sm text-white" data-private-comfort>
                    <p>
                        Your preference for this boat, not a safety rating or measured forecast accuracy. Starts
                        uncalibrated. Rough-sea floors and your routing limits still apply.
                    </p>
                    <p>
                        Report how this passage feels while its log is recording. Uses an accepted GPS fix no older than
                        45 seconds and a real nearby recorded point. Requires confirmed open water and a local wave cell
                        clear of the coast. Model sea remains a forecast, not an instrument observation.
                    </p>
                    <div className="grid grid-cols-2 gap-2" aria-label="Report current comfort">
                        {WORDS.map((word, level) => (
                            <button
                                key={word}
                                type="button"
                                disabled={busy || !state}
                                className="min-h-11 rounded-lg border border-sky-500/40 px-2 py-2 text-white disabled:opacity-40"
                                onClick={() => void action(() => reportPrivateComfort(level))}
                            >
                                {word}
                            </button>
                        ))}
                    </div>
                    <p>
                        Only you can read these reports. They sync after the ordinary log uploads. No crew sharing,
                        public export or weather skill score. Up to 50 pending for 30 days and 120 report/deletion slots
                        per boat; reset explicitly when full.
                    </p>
                    <p className="font-bold">
                        {state ? 'Personal preference warm-up' : 'Uncalibrated · private data unavailable'}
                    </p>
                    {state && (
                        <ul className="space-y-1">
                            {PERSONAL_COMFORT_INPUTS.map((input) => {
                                const count = state.preference.qualified[input],
                                    ready = count.reports >= 6 && count.voyages >= 3;
                                return (
                                    <li key={input}>
                                        {input}: {count.reports}/6 reports · {count.voyages}/3 voyages ·{' '}
                                        {ready
                                            ? `personal adjustment ${state.preference.adjustments[input] > 0 ? '+' : ''}${state.preference.adjustments[input]}`
                                            : 'warming up'}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    {message && (
                        <p role="status" className="rounded-lg bg-sky-950 p-3 text-sky-100">
                            {message}
                        </p>
                    )}
                    {!!pendingRows.length && (
                        <ul className="space-y-2" aria-label="Pending private comfort reports">
                            {pendingRows.map((report) => (
                                <li
                                    key={report.operation}
                                    className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2"
                                >
                                    <span>
                                        Pending · {new Date(report.at).toLocaleString()} ·{' '}
                                        {WORDS[report.level] ?? 'Unknown'}
                                    </span>
                                    <button
                                        type="button"
                                        disabled={busy || !state}
                                        className="min-h-11 rounded-lg border border-white/20 px-3"
                                        aria-label={`Delete pending comfort report ${report.operation}`}
                                        onClick={() => void action(() => deletePrivateComfort(report.operation))}
                                    >
                                        Delete
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {!!state?.reports.length && (
                        <ul className="space-y-2" aria-label="Own private comfort reports">
                            {state.reports.map((report) => (
                                <li
                                    key={report.operation}
                                    className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2"
                                >
                                    <span>
                                        {new Date(report.capturedAt).toLocaleString()} · {WORDS[report.level]}
                                        {!report.qualified ? ' · Not qualified: recorded point changed' : ''}
                                    </span>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        className="min-h-11 rounded-lg border border-white/20 px-3"
                                        aria-label={`Delete private comfort report ${report.operation}`}
                                        onClick={() => void action(() => deletePrivateComfort(report.operation))}
                                    >
                                        Delete
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <button
                        type="button"
                        disabled={busy || !state}
                        className="min-h-11 w-full rounded-lg border border-rose-400/50 px-3 text-rose-200 disabled:opacity-40"
                        onClick={() =>
                            void action(async () => {
                                await resetPrivateComfort();
                                return 'Private reports reset. This boat is uncalibrated again; older queued reports cannot return.';
                            })
                        }
                    >
                        Reset this boat’s private reports
                    </button>
                </div>
            </ModalSheet>
        </>
    );
}
