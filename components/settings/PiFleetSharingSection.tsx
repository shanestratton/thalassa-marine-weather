import React from 'react';
import { OverlayPortal } from '../ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import {
    isPiFleetSharingConfigured,
    canStopPairedPiFleetSharing,
    stopPairedPiFleetSharing,
    reviewPiFleetSharing,
    type PiFleetSession,
} from '../../services/ais/piFleetClient';
import type { PiFleetStatus } from '../../services/ais/piFleetTransaction';
const actionClass = 'min-h-11 rounded-xl border border-white/15 px-4 py-2 text-sm font-bold text-white';
export function PiFleetSharingSheet({ session, onClose }: { session: PiFleetSession; onClose: () => void }) {
    const [status, setStatus] = React.useState<PiFleetStatus>(session.initial),
        [busy, setBusy] = React.useState(false),
        [consent, setConsent] = React.useState(false),
        [message, setMessage] = React.useState('');
    const dismiss = React.useRef<HTMLButtonElement>(null),
        trap = useFocusTrap<HTMLDivElement>(true, { onEscape: onClose, initialFocusRef: dismiss });
    return (
        <OverlayPortal
            className="flex items-center justify-center bg-black/70 p-4"
            role="presentation"
            onClick={onClose}
        >
            <div
                ref={trap}
                role="dialog"
                aria-modal="true"
                aria-label="Pi AIS sharing"
                onClick={(e) => e.stopPropagation()}
                className="max-h-[calc(100dvh-3rem)] w-full max-w-md overflow-y-auto rounded-3xl border border-white/10 bg-slate-900 p-5 text-white"
            >
                <h2 className="text-lg font-bold">Pi AIS sharing</h2>
                <p className="mt-2 break-words text-sm font-semibold">{session.vesselName}</p>
                <p className="mt-3 text-sm leading-relaxed text-slate-300">
                    This separate permission lets the boat’s Pi send the AIS it hears to Thalassa’s fleet service and
                    AISHub’s public network. It can continue while this phone is away. Phone sharing does not turn this
                    on.
                </p>
                <p className="mt-3 text-sm font-bold text-amber-200">
                    Your own boat’s AIS position, MMSI, name, course and speed may become publicly trackable and be
                    copied onward. Previously published reports cannot be recalled.
                </p>
                <p className="mt-3 text-xs leading-relaxed text-slate-400">
                    The listening map uses delayed 2° cells with at least three consenting accounts and receivers. It
                    shows no receiver identities or trails. Reception is not assured. This permission expires within 30
                    days and never enables an alarm or CPA source.
                </p>
                <p role="status" className="mt-3 break-words text-sm text-sky-200">
                    {message ||
                        (status.state === 'unavailable'
                            ? 'Pi sharing state is unavailable. Use Stop Pi sharing to clear local consent before reviewing again.'
                            : status.consent?.enabled
                              ? 'A separate consent is saved on the Pi.'
                              : 'Pi sharing is off.')}
                </p>
                {!status.operatorConfigured && (
                    <p className="mt-2 text-sm text-amber-200">
                        The Pi fleet service or receiver-only source has not been configured. Sharing stays off.
                    </p>
                )}
                {status.consent?.enabled && (
                    <p className="mt-2 text-xs text-slate-400">
                        {status.state === 'acknowledged'
                            ? 'The service acknowledged a recent batch; downstream delivery is not confirmed.'
                            : `Local sender: ${status.state.replaceAll('-', ' ')}. No delivery confirmation is implied.`}
                    </p>
                )}
                <label className="mt-4 flex min-h-11 items-center gap-3 text-sm">
                    <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                        className="h-5 w-5 shrink-0"
                    />
                    I understand and choose public sharing from this Pi for this vessel.
                </label>
                <div className="mt-4 flex flex-wrap gap-2">
                    <button ref={dismiss} type="button" className={actionClass} onClick={onClose}>
                        Close
                    </button>
                    <button
                        type="button"
                        className={actionClass + ' border-red-400/40 text-red-200'}
                        onClick={() => {
                            setBusy(true);
                            setConsent(false);
                            setMessage('Requesting an immediate local stop…');
                            void session
                                .off()
                                .then((result) => {
                                    if (!session.current()) return;
                                    if (result.localStopped) setStatus((s) => ({ ...s, state: 'off', consent: null }));
                                    setMessage(
                                        result.localStopped
                                            ? result.cloudWithdrawn
                                                ? 'Stopped on the Pi; cloud permission withdrawn.'
                                                : 'Stopped on the Pi. Cloud withdrawal could not be confirmed; review again when online.'
                                            : result.cloudWithdrawn
                                              ? 'Cloud permission withdrawn. The Pi’s local stop could not be confirmed.'
                                              : 'Stop could not be confirmed. Reconnect to the boat’s Pi or turn off its local fleet sender.',
                                    );
                                })
                                .catch(() => {
                                    if (session.current())
                                        setMessage('Stop could not be confirmed. Reconnect to the boat’s Pi.');
                                })
                                .finally(() => setBusy(false));
                        }}
                    >
                        Stop Pi sharing
                    </button>
                    <button
                        type="button"
                        className={actionClass + ' bg-sky-700 disabled:opacity-40'}
                        disabled={busy || !consent || !status.operatorConfigured || status.state === 'unavailable'}
                        onClick={() => {
                            setBusy(true);
                            setMessage('Confirming this separate consent with the paired Pi and service…');
                            void session
                                .enable()
                                .then((result) => {
                                    if (!session.current()) return;
                                    setStatus(result);
                                    setConsent(false);
                                    setMessage(
                                        'Consent saved on this Pi. Sharing needs fresh receiver observations and its internet permission.',
                                    );
                                })
                                .catch((error) => {
                                    if (session.current())
                                        setMessage(
                                            error instanceof Error ? error.message : 'Pi sharing was not confirmed.',
                                        );
                                })
                                .finally(() => setBusy(false));
                        }}
                    >
                        Enable for this vessel
                    </button>
                </div>
            </div>
        </OverlayPortal>
    );
}
export default function PiFleetSharingSection() {
    const [session, setSession] = React.useState<PiFleetSession | null>(null),
        [message, setMessage] = React.useState(''),
        [busy, setBusy] = React.useState(false),
        life = React.useRef(0),
        held = React.useRef<PiFleetSession | null>(null);
    const close = React.useCallback(() => {
        life.current++;
        held.current?.release();
        held.current = null;
        setSession(null);
        setBusy(false);
    }, []);
    React.useEffect(
        () => () => {
            life.current++;
            held.current?.release();
        },
        [],
    );
    React.useEffect(() => {
        if (!session) return;
        const timer = setInterval(() => {
            if (!session.current()) close();
        }, 500);
        return () => clearInterval(timer);
    }, [session, close]);
    React.useEffect(() => {
        if (!isPiFleetSharingConfigured()) return;
        const invalidate = () => {
            life.current++;
        };
        const retire = () => {
            close();
            setMessage('Account or vessel changed. Review Pi sharing again.');
        };
        const auth = subscribeAuthIdentityScope(retire),
            fleet =
                typeof useSettingsStore.subscribe === 'function'
                    ? useSettingsStore.subscribe((next, prior) => {
                          if (next.activeVesselId !== prior.activeVesselId) retire();
                      })
                    : () => {};
        return () => {
            invalidate();
            held.current?.release();
            auth();
            fleet();
        };
    }, [close]);
    const configured = isPiFleetSharingConfigured();
    return (
        <>
            <div className="p-4">
                {configured ? (
                    <p className="text-xs leading-relaxed text-slate-400">
                        A separate, optional consent for the boat’s Pi. Off by default; the phone’s sharing switch does
                        not enable it.
                    </p>
                ) : (
                    <p className="text-xs leading-relaxed text-slate-400">
                        This build cannot enable Pi sharing until its fleet service is configured. A previously
                        consented Pi can continue independently. Connect to the paired Pi to stop its local sender.
                    </p>
                )}
                {configured && (
                    <button
                        type="button"
                        disabled={busy}
                        className={actionClass + ' mt-3 w-full'}
                        onClick={() => {
                            const revision = ++life.current;
                            setBusy(true);
                            setMessage('Checking the paired Pi on the boat’s Wi-Fi…');
                            void reviewPiFleetSharing()
                                .then((value) => {
                                    if (life.current !== revision) {
                                        value.release();
                                        return;
                                    }
                                    held.current = value;
                                    setSession(value);
                                    setMessage('');
                                })
                                .catch((error) => {
                                    if (life.current === revision)
                                        setMessage(error instanceof Error ? error.message : 'Pi sharing unavailable.');
                                })
                                .finally(() => {
                                    if (life.current === revision) setBusy(false);
                                });
                        }}
                    >
                        Review Pi sharing
                    </button>
                )}
                {canStopPairedPiFleetSharing() && (
                    <button
                        type="button"
                        disabled={busy}
                        className={actionClass + ' mt-3 w-full border-red-400/40 text-red-200'}
                        onClick={() => {
                            close();
                            const revision = life.current;
                            setBusy(true);
                            setMessage('Requesting a local stop on the paired Pi…');
                            void stopPairedPiFleetSharing()
                                .then(() => {
                                    if (life.current === revision)
                                        setMessage(
                                            'Stopped on the paired Pi. Cloud withdrawal was not requested; previously published reports cannot be recalled.',
                                        );
                                })
                                .catch(() => {
                                    if (life.current === revision)
                                        setMessage(
                                            'Local stop could not be confirmed. Reconnect to the paired Pi with fleet sharing support, or turn off its local fleet sender.',
                                        );
                                })
                                .finally(() => {
                                    if (life.current === revision) setBusy(false);
                                });
                        }}
                    >
                        Stop paired Pi locally
                    </button>
                )}
                {message && (
                    <p role="status" className="mt-2 break-words text-xs text-sky-200">
                        {message}
                    </p>
                )}
            </div>
            {session && <PiFleetSharingSheet session={session} onClose={close} />}
        </>
    );
}
