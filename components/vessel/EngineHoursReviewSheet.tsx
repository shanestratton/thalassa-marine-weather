import React, { useEffect, useState } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import { isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import {
    confirmEngineHours,
    loadEngineHoursReview,
    type EngineHoursOffer,
    type EngineHoursReview,
} from '../../services/shiplog/engineHoursReview';
import { engineRunSummary } from '../../services/shiplog/engineRunCounter';
import { useSettingsStore } from '../../stores/settingsStore';

const duration = (seconds: number) => `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
export default function EngineHoursReviewSheet({ offer, onClose }: { offer: EngineHoursOffer; onClose: () => void }) {
    const [review, setReview] = useState<EngineHoursReview | null>(null);
    const [error, setError] = useState('');
    const [confirmedBoat, setConfirmedBoat] = useState(false);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState('');
    const [reload, setReload] = useState(0);
    const controller = React.useRef<AbortController | null>(null);
    const mounted = React.useRef(true);
    const currentOffer = React.useRef(offer);
    currentOffer.current = offer;
    const summary = engineRunSummary(offer.counter);
    const boatName = useSettingsStore((s) => s.vesselFleet.find((boat) => boat.id === offer.boatId)?.profile.name);
    useEffect(() => {
        let live = true;
        const abort = new AbortController();
        const timeout = setTimeout(() => {
            abort.abort();
            if (live && isAuthIdentityScopeCurrent(offer.scope))
                setError('The reading timed out. Connect and reload it.');
        }, 12_000);
        controller.current = abort;
        setError('');
        setReview(null);
        setConfirmedBoat(false);
        void loadEngineHoursReview(offer, abort.signal)
            .then((value) => {
                if (live && !abort.signal.aborted && isAuthIdentityScopeCurrent(offer.scope)) setReview(value);
            })
            .catch((cause) => {
                if (live && !abort.signal.aborted && isAuthIdentityScopeCurrent(offer.scope))
                    setError(cause instanceof Error ? cause.message : 'Can’t review engine hours now.');
            })
            .finally(() => clearTimeout(timeout));
        return () => {
            live = false;
            clearTimeout(timeout);
            abort.abort();
        };
    }, [offer, reload]);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            controller.current?.abort();
        };
    }, []);
    if (!isAuthIdentityScopeCurrent(offer.scope)) return null;
    const confirm = async () => {
        if (busy || !confirmedBoat || review?.hours === null || review?.hours === undefined) return;
        const abort = new AbortController();
        controller.current?.abort();
        controller.current = abort;
        const timeout = setTimeout(() => abort.abort(), 12_000);
        setBusy(true);
        setError('');
        try {
            const result = await confirmEngineHours(offer, review.hours, abort.signal);
            if (
                !mounted.current ||
                currentOffer.current !== offer ||
                !isAuthIdentityScopeCurrent(offer.scope) ||
                abort.signal.aborted
            )
                return;
            setDone(
                result.applied
                    ? `Confirmed. Maintenance reads ${result.hours.toLocaleString()} h${result.remainderSeconds ? `, with ${duration(result.remainderSeconds)} carried toward the next hour` : ''}.`
                    : 'This voyage’s engine time was already counted.',
            );
        } catch (cause) {
            if (mounted.current && currentOffer.current === offer && isAuthIdentityScopeCurrent(offer.scope))
                setError(cause instanceof Error ? cause.message : 'Can’t confirm engine hours now.');
        } finally {
            clearTimeout(timeout);
            if (mounted.current && currentOffer.current === offer && isAuthIdentityScopeCurrent(offer.scope))
                setBusy(false);
        }
    };
    const close = () => {
        controller.current?.abort();
        onClose();
    };
    return (
        <ModalSheet
            isOpen
            onClose={close}
            title="Voyage engine hours"
            maxWidth="max-w-md"
            footer={
                <div className="flex flex-wrap gap-2">
                    {!done && (
                        <button
                            type="button"
                            className="min-h-[44px] flex-1 rounded-xl bg-sky-600 px-4 py-2 font-bold text-white disabled:opacity-40"
                            disabled={
                                busy ||
                                !confirmedBoat ||
                                review?.hours == null ||
                                review.alreadyConfirmed ||
                                summary.clockUncertain
                            }
                            onClick={() => void confirm()}
                        >
                            {busy ? 'Confirming…' : 'Add recorded time'}
                        </button>
                    )}
                    <button
                        type="button"
                        className="min-h-[44px] rounded-xl border border-white/20 px-4 py-2 text-white"
                        onClick={close}
                    >
                        {done ? 'Done' : busy ? 'Close' : 'Not now'}
                    </button>
                </div>
            }
        >
            <div className="space-y-4 p-4 text-sm leading-relaxed text-white/85">
                <p className="text-lg font-bold text-white">{duration(summary.seconds)} recorded engine time</p>
                <p>
                    {boatName ? `Voyage boat: ${boatName}.` : 'Check the voyage boat against your Maintenance record.'}
                </p>
                <p>
                    {summary.measuredSeconds ? `${duration(summary.measuredSeconds)} from fresh RPM. ` : ''}
                    {summary.loggedSeconds ? `${duration(summary.loggedSeconds)} from your Log declarations.` : ''}
                </p>
                {summary.unknownSeconds > 0 && <p>{duration(summary.unknownSeconds)} is unknown and won’t be added.</p>}
                {summary.clockUncertain && (
                    <p>The clock changed during this record. Check the hour meter in Maintenance.</p>
                )}
                {review && !done && (
                    <>
                        <p>
                            {review.alreadyConfirmed
                                ? 'This voyage’s engine time was already counted.'
                                : review.hours === null
                                  ? 'Set the current hour-meter reading in Maintenance, then reload.'
                                  : `Current Maintenance reading: ${review.hours.toLocaleString()} h. Partial logged hours carry toward the next whole hour.`}
                        </p>
                        {!review.alreadyConfirmed && (
                            <label className="flex min-h-[44px] items-center gap-3">
                                <input
                                    type="checkbox"
                                    checked={confirmedBoat}
                                    onChange={(e) => setConfirmedBoat(e.target.checked)}
                                    className="h-5 w-5 shrink-0"
                                />
                                <span>
                                    I checked that this is the same boat and engine as this Maintenance reading.
                                </span>
                            </label>
                        )}
                    </>
                )}
                {!review && !error && <p role="status">Reading the current meter…</p>}
                {error && (
                    <p role="alert" className="text-amber-300">
                        {error}
                    </p>
                )}
                {done && (
                    <p role="status" className="text-emerald-300">
                        {done}
                    </p>
                )}
                {!busy && !done && (
                    <button type="button" className="min-h-[44px] underline" onClick={() => setReload((n) => n + 1)}>
                        Reload reading
                    </button>
                )}
            </div>
        </ModalSheet>
    );
}
