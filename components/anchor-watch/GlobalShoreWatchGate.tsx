import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ShoreWatchAlarmService } from '../../services/ShoreWatchAlarmService';
import { AnchorWatchService } from '../../services/AnchorWatchService';
import { AnchorPhoneHeartbeat } from '../../services/anchorPhoneHeartbeat';
import { AnchorPiWatchKeeper } from '../../services/anchorPiWatchKeeper';
import { ShoreSwingTrail } from '../../services/shoreSwingTrail';
import { useSettingsStore } from '../../stores/settingsStore';
import { formatAnchorLength } from './anchorUtils';
import { OverlayPortal } from '../ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { AlertTriangleIcon, RadioTowerIcon } from '../Icons';
import { toast } from '../Toast';

/** Only the phone that handed its own Pi this watch can renew it (126-03b). */
const keepsOwnPi = (sessionCode: string | null) =>
    !!sessionCode && AnchorPiWatchKeeper.keepingSessionCode() === sessionCode;

function ShoreAlarmDialog() {
    const watch = useSyncExternalStore(ShoreWatchAlarmService.subscribe, ShoreWatchAlarmService.getSnapshot);
    const silenceRef = useRef<HTMLButtonElement>(null);
    const ref = useFocusTrap<HTMLDivElement>(true, { initialFocusRef: silenceRef });
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [renewing, setRenewing] = useState(false);
    const canRenew = watch.cause === 'session-expiring' && keepsOwnPi(watch.sessionCode);
    const renew = () => {
        const failed = () => setError('This phone could not renew the Pi’s watch. Check it is online, then try again.');
        setRenewing(true);
        setError(null);
        void AnchorPiWatchKeeper.renewNow()
            .then((renewed) => {
                if (!renewed) return failed();
                // The cloud authorisation is the renewal; re-sending the Pi the watch is extra.
                ShoreWatchAlarmService.clearSessionExpiring();
                if (renewed === 'authorised')
                    toast.info(
                        'Renewed for another week. This phone could not reach the Pi just now; it keeps trying.',
                    );
            })
            .catch(failed)
            .finally(() => setRenewing(false));
    };
    // The viewer's own units (126-03a): feet for a feet skipper, wherever the boat is.
    const units = useSettingsStore((state) => state.settings.units);
    const length = (metres: number) =>
        formatAnchorLength(metres, units?.length === 'ft' ? 'ft' : 'm', { long: units?.distance });
    const title =
        watch.cause === 'drag'
            ? 'Vessel drag alarm'
            : watch.cause === 'gps-lost'
              ? 'Vessel GPS lost'
              : watch.cause === 'session-expiring'
                ? 'Shore Watch ends soon'
                : 'Vessel contact lost';
    return (
        <OverlayPortal
            ref={ref}
            layer="critical"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="shore-alarm-title"
            aria-describedby="shore-alarm-description"
            className="flex flex-col items-center justify-center overflow-y-auto bg-slate-950 px-6 py-[max(2rem,env(safe-area-inset-top))] text-center"
        >
            <div aria-hidden="true" className="mb-6 text-red-400">
                {watch.cause === 'drag' ? (
                    <AlertTriangleIcon className="h-14 w-14" />
                ) : (
                    <RadioTowerIcon className="h-14 w-14" />
                )}
            </div>
            <p className="mb-3 text-sm font-black uppercase tracking-[0.25em] text-amber-300">Shore Watch</p>
            <h1 id="shore-alarm-title" className="text-3xl font-black text-red-400">
                {title}
            </h1>
            <p id="shore-alarm-description" className="mt-5 max-w-md text-lg text-slate-100">
                {watch.cause === 'drag'
                    ? 'The boat’s watchkeeper reported an anchor alarm. Check the vessel immediately.'
                    : watch.cause === 'session-expiring'
                      ? canRenew
                          ? 'The Pi keeping the anchor watch stops within 12 hours unless this phone renews it.'
                          : 'The Pi keeping the anchor watch stops within 12 hours unless the skipper opens Thalassa on the phone that handed it the watch.'
                      : 'We cannot confirm the boat is holding. Check the vessel, its GPS and its internet connection.'}
            </p>
            {watch.position && (
                <p className="mt-4 text-slate-300">
                    Last reported: {length(watch.position.distance)} from anchor · {length(watch.position.swingRadius)}{' '}
                    radius
                </p>
            )}
            {(error || watch.audioError) && (
                <p
                    role="alert"
                    className="mt-5 max-w-md rounded-xl border border-amber-400/50 bg-amber-950/40 p-4 text-amber-200"
                >
                    {error || watch.audioError}
                </p>
            )}
            {watch.audioError && (
                <button
                    className="mt-3 min-h-11 px-5 text-amber-200 underline"
                    onClick={ShoreWatchAlarmService.retryAudio}
                >
                    Retry alarm sound
                </button>
            )}
            {canRenew && (
                <button
                    disabled={renewing}
                    className="mt-8 min-h-14 w-full max-w-sm rounded-2xl bg-sky-600 px-6 py-4 text-lg font-black text-white disabled:opacity-60"
                    onClick={renew}
                >
                    {renewing ? 'Renewing…' : 'Renew watch'}
                </button>
            )}
            <button
                ref={silenceRef}
                disabled={busy}
                className={`${canRenew ? 'mt-3' : 'mt-8'} min-h-14 w-full max-w-sm rounded-2xl bg-red-700 px-6 py-4 text-lg font-black text-white disabled:opacity-60`}
                onClick={() => {
                    setBusy(true);
                    void ShoreWatchAlarmService.mute()
                        .catch(() => setError('Could not silence the alarm. Please retry.'))
                        .finally(() => setBusy(false));
                }}
            >
                {busy ? 'Silencing…' : 'Silence this phone'}
            </button>
            <p className="mt-3 text-sm text-slate-300">
                Monitoring continues. This does not stop or silence the boat’s watchkeeper.
            </p>
        </OverlayPortal>
    );
}

/** Lives beside the local anchor gate, outside page navigation/Suspense. */
export function GlobalShoreWatchGate({ showStatus, onOpen }: { showStatus: boolean; onOpen: () => void }) {
    const watch = useSyncExternalStore(ShoreWatchAlarmService.subscribe, ShoreWatchAlarmService.getSnapshot);
    const [localAlarm, setLocalAlarm] = useState(() => AnchorWatchService.getSnapshot().state === 'alarm');
    useEffect(() => {
        ShoreWatchAlarmService.start();
        AnchorPhoneHeartbeat.start();
        ShoreSwingTrail.start();
        const unsubscribe = AnchorWatchService.subscribe((snap) => setLocalAlarm(snap.state === 'alarm'));
        return () => {
            unsubscribe();
        };
        // Deliberately do not stop the app-lifetime watch when UI unmounts.
    }, []);
    if (watch.cause && !watch.muted && !localAlarm) return <ShoreAlarmDialog key={watch.cause} />;
    // Routine connection/readiness details now live in the top information
    // FAB. Keep a muted safety alarm visible rather than hiding it in a menu.
    if (!showStatus || !watch.sessionCode || !watch.cause) return null;
    return (
        <button
            onClick={onOpen}
            aria-label="Open active Shore Watch"
            className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-1/2 z-[80] flex min-h-11 max-w-[90vw] -translate-x-1/2 items-center gap-2 rounded-full border border-amber-400/50 bg-slate-950/95 px-4 py-2 text-sm font-bold text-amber-200 shadow-xl backdrop-blur-xl"
        >
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
            Shore Watch ·{' '}
            {watch.cause === 'session-expiring'
                ? keepsOwnPi(watch.sessionCode)
                    ? 'Renew watch'
                    : 'Ends soon'
                : 'Check vessel'}
        </button>
    );
}
