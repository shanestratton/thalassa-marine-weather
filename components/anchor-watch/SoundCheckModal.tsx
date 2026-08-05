/**
 * SoundCheckModal — Pre-anchor confirmation for alarm readiness.
 * Displays a truthful platform-specific readiness check and plays a real
 * sample through the exact alarm service used by Anchor Watch.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { AlarmAudioService } from '../../services/AlarmAudioService';
import { AnchorSafetyNotificationService } from '../../services/AnchorSafetyNotificationService';

interface SoundCheckModalProps {
    onConfirm: () => void;
    onCancel: () => void;
}

type AlarmTestState = 'idle' | 'starting' | 'playing' | 'stopping' | 'heard-prompt' | 'start-failed' | 'stop-failed';
type NotificationReadiness = 'checking' | 'granted' | 'prompt' | 'denied' | 'unavailable';

export const SoundCheckModal: React.FC<SoundCheckModalProps> = React.memo(({ onConfirm, onCancel }) => {
    const cancelButtonRef = useRef<HTMLButtonElement>(null);
    const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const testLeaseRef = useRef<string | null>(null);
    const testLeasePromiseRef = useRef<Promise<string> | null>(null);
    const testReleasePromiseRef = useRef<Promise<void> | null>(null);
    const closeRequestRef = useRef<Promise<void> | null>(null);
    const testAttemptRef = useRef(0);
    const mountedRef = useRef(true);
    const isNative = Capacitor.isNativePlatform();
    const [testState, setTestState] = useState<AlarmTestState>('idle');
    const [alarmAudibilityConfirmed, setAlarmAudibilityConfirmed] = useState(false);
    const [notificationReadiness, setNotificationReadiness] = useState<NotificationReadiness>(
        isNative ? 'checking' : 'unavailable',
    );
    const [notificationReadinessError, setNotificationReadinessError] = useState<string | null>(null);

    const stopTestAlarm = useCallback(async (nextState: AlarmTestState = 'heard-prompt') => {
        testAttemptRef.current += 1;
        if (testTimerRef.current) {
            clearTimeout(testTimerRef.current);
            testTimerRef.current = null;
        }

        const releaseInFlight = testReleasePromiseRef.current;
        if (releaseInFlight) {
            await releaseInFlight;
            if (mountedRef.current) setTestState(nextState);
            return;
        }

        const releasePromise = (async () => {
            const leasePromise = testLeasePromiseRef.current;
            let lease = testLeaseRef.current;

            if (!lease && leasePromise) {
                try {
                    lease = await leasePromise;
                    if (!testLeaseRef.current) testLeaseRef.current = lease;
                } catch {
                    if (testLeasePromiseRef.current === leasePromise) testLeasePromiseRef.current = null;
                    return;
                }
            }

            if (!lease) return;
            await AlarmAudioService.release(lease);
            if (testLeaseRef.current === lease) testLeaseRef.current = null;
            if (testLeasePromiseRef.current === leasePromise) testLeasePromiseRef.current = null;
        })();

        testReleasePromiseRef.current = releasePromise;
        try {
            await releasePromise;
            if (mountedRef.current) setTestState(nextState);
        } finally {
            if (testReleasePromiseRef.current === releasePromise) testReleasePromiseRef.current = null;
        }
    }, []);

    const showStopFailure = useCallback(() => {
        if (!mountedRef.current) return;
        setAlarmAudibilityConfirmed(false);
        setTestState('stop-failed');
    }, []);

    const closeAfterTestStops = useCallback(
        (closeAction: () => void) => {
            if (closeRequestRef.current) return;

            const closeRequest = (async () => {
                if (testLeaseRef.current || testLeasePromiseRef.current) setTestState('stopping');
                try {
                    await stopTestAlarm('idle');
                } catch {
                    showStopFailure();
                    return;
                }
                if (mountedRef.current) closeAction();
            })();

            closeRequestRef.current = closeRequest;
            void closeRequest.finally(() => {
                if (closeRequestRef.current === closeRequest) closeRequestRef.current = null;
            });
        },
        [showStopFailure, stopTestAlarm],
    );

    const handleCancel = useCallback(() => {
        closeAfterTestStops(onCancel);
    }, [closeAfterTestStops, onCancel]);

    const handleConfirm = useCallback(() => {
        if (!alarmAudibilityConfirmed) return;
        // Native Anchor Watch promises a locked-screen fallback. Never let a
        // skipper confirm while that permission is denied or still unknown.
        if (isNative && notificationReadiness !== 'granted') return;
        closeAfterTestStops(onConfirm);
    }, [alarmAudibilityConfirmed, closeAfterTestStops, isNative, notificationReadiness, onConfirm]);

    const dialogRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: cancelButtonRef,
        onEscape: handleCancel,
    });

    useEffect(() => {
        mountedRef.current = true;
        if (isNative) {
            void LocalNotifications.checkPermissions()
                .then(async ({ display }) => {
                    if (!mountedRef.current) return;
                    if (display !== 'granted') {
                        setNotificationReadiness(display === 'denied' ? 'denied' : 'prompt');
                        return;
                    }
                    await AnchorSafetyNotificationService.requireReadiness();
                    if (mountedRef.current) {
                        setNotificationReadinessError(null);
                        setNotificationReadiness('granted');
                    }
                })
                .catch((error: unknown) => {
                    if (mountedRef.current) {
                        setNotificationReadinessError(
                            error instanceof Error ? error.message : 'Locked-screen readiness could not be verified.',
                        );
                        setNotificationReadiness('unavailable');
                    }
                });
        }
        return () => {
            mountedRef.current = false;
            testAttemptRef.current += 1;
            if (testTimerRef.current) {
                clearTimeout(testTimerRef.current);
                testTimerRef.current = null;
            }

            const lease = testLeaseRef.current;
            if (lease) AlarmAudioService.releaseEventually(lease);

            const pendingLease = testLeasePromiseRef.current;
            if (pendingLease) {
                void pendingLease.then(
                    (resolvedLease) => AlarmAudioService.releaseEventually(resolvedLease),
                    () => undefined,
                );
            }
        };
    }, [isNative]);

    const requestNotificationPermission = useCallback(async () => {
        if (!isNative) return;
        setNotificationReadiness('checking');
        setNotificationReadinessError(null);
        try {
            const { display } = await LocalNotifications.requestPermissions();
            if (!mountedRef.current) return;
            if (display !== 'granted') {
                setNotificationReadiness('denied');
                return;
            }
            await AnchorSafetyNotificationService.requireReadiness();
            if (mountedRef.current) setNotificationReadiness('granted');
        } catch (error) {
            if (mountedRef.current) {
                setNotificationReadinessError(
                    error instanceof Error ? error.message : 'Locked-screen readiness could not be verified.',
                );
                setNotificationReadiness('unavailable');
            }
        }
    }, [isNative]);

    const handleAlarmTest = useCallback(async () => {
        if (testLeaseRef.current || testLeasePromiseRef.current) {
            setTestState('stopping');
            try {
                await stopTestAlarm();
            } catch {
                showStopFailure();
            }
            return;
        }
        if (testState === 'starting' || testState === 'stopping') return;
        const attempt = ++testAttemptRef.current;
        setAlarmAudibilityConfirmed(false);
        setTestState('starting');
        const leasePromise = AlarmAudioService.acquire('anchor-sound-check');
        testLeasePromiseRef.current = leasePromise;
        try {
            const lease = await leasePromise;
            if (testLeasePromiseRef.current !== leasePromise) {
                AlarmAudioService.releaseEventually(lease);
                return;
            }
            testLeaseRef.current = lease;
            if (!mountedRef.current || testAttemptRef.current !== attempt) {
                return;
            }
            setTestState('playing');
            testTimerRef.current = setTimeout(() => {
                if (mountedRef.current) setTestState('stopping');
                void stopTestAlarm().catch(showStopFailure);
            }, 3_000);
        } catch {
            if (testLeasePromiseRef.current === leasePromise) testLeasePromiseRef.current = null;
            if (mountedRef.current && testAttemptRef.current === attempt) setTestState('start-failed');
        }
    }, [showStopFailure, stopTestAlarm, testState]);

    const notificationBlocked = isNative && notificationReadiness !== 'granted';
    const audioCleanupBlocked =
        testState === 'starting' || testState === 'playing' || testState === 'stopping' || testState === 'stop-failed';
    const confirmRequirementIds = [
        !alarmAudibilityConfirmed || audioCleanupBlocked ? 'anchor-audio-requirement' : null,
        notificationBlocked ? 'anchor-notification-requirement' : null,
    ]
        .filter((id): id is string => Boolean(id))
        .join(' ');

    return createPortal(
        <div
            className="anchor-sound-check-backdrop fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center p-6"
            onClick={handleCancel}
            role="presentation"
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="sound-check-title"
                className="anchor-sound-check-dialog flex w-full max-w-sm max-h-[calc(100dvh-3rem)] flex-col bg-slate-900/95 border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="anchor-sound-check-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {/* Header */}
                    <div className="px-5 pt-5 pb-3 text-center">
                        <div className="text-4xl mb-3">🔊</div>
                        <h2 id="sound-check-title" className="text-lg font-black text-white tracking-tight">
                            Sound Check
                        </h2>
                        <p className="text-sm text-slate-400 mt-1 leading-relaxed">
                            Before you anchor up, make sure your alarm will wake you.
                        </p>
                    </div>

                    {/* Checklist */}
                    <div className="px-5 pb-4 space-y-2.5">
                        <div className="bg-emerald-500/[0.06] border border-emerald-500/10 rounded-xl px-3.5 py-3">
                            <div className="flex items-start gap-3">
                                <span className="text-lg mt-0.5">🔊</span>
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-bold text-emerald-400">Test the actual alarm</p>
                                    <p className="text-xs text-emerald-400/70 leading-snug">
                                        Turn the volume up, then verify that this sample is loud enough to wake you.
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => void handleAlarmTest()}
                                disabled={testState === 'starting' || testState === 'stopping'}
                                className="mt-2.5 min-h-[44px] w-full rounded-xl border border-emerald-400/25 bg-emerald-500/15 px-3 py-2 text-xs font-black text-emerald-200 disabled:opacity-60"
                                aria-label={
                                    testState === 'playing'
                                        ? 'Stop test alarm'
                                        : testState === 'stop-failed'
                                          ? 'Retry stopping test alarm'
                                          : 'Play test alarm'
                                }
                            >
                                {testState === 'starting'
                                    ? 'Starting alarm…'
                                    : testState === 'stopping'
                                      ? 'Stopping alarm…'
                                      : testState === 'playing'
                                        ? 'Stop Alarm'
                                        : testState === 'stop-failed'
                                          ? 'Retry Stop Alarm'
                                          : 'Test Alarm'}
                            </button>
                            {testState === 'heard-prompt' && !alarmAudibilityConfirmed && (
                                <div className="mt-2 space-y-2">
                                    <p role="status" className="text-center text-xs font-bold text-amber-200">
                                        Test stopped. Only continue if the alarm was loud and clear on this device.
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => setAlarmAudibilityConfirmed(true)}
                                        className="min-h-[44px] w-full rounded-xl border border-emerald-400/30 bg-emerald-500/20 px-3 py-2 text-xs font-black text-emerald-100"
                                        aria-label="Confirm alarm was audible"
                                    >
                                        I Heard It Clearly
                                    </button>
                                </div>
                            )}
                            {alarmAudibilityConfirmed && (
                                <p role="status" className="mt-2 text-center text-xs font-bold text-emerald-200">
                                    Alarm heard and confirmed for this arming attempt.
                                </p>
                            )}
                            {testState === 'stopping' && (
                                <p role="status" className="mt-2 text-center text-xs font-bold text-amber-200">
                                    Waiting for this device to confirm that the test alarm stopped…
                                </p>
                            )}
                            {testState === 'start-failed' && (
                                <p role="alert" className="mt-2 text-center text-xs font-bold text-red-300">
                                    The alarm test could not start. Do not arm until audio is working.
                                </p>
                            )}
                            {testState === 'stop-failed' && (
                                <p role="alert" className="mt-2 text-center text-xs font-bold text-red-300">
                                    The alarm may still be sounding because this device did not confirm it stopped. Keep
                                    this window open and retry; Anchor Watch cannot start until stopping succeeds.
                                </p>
                            )}
                        </div>

                        <div className="flex items-start gap-3 bg-amber-500/[0.06] border border-amber-500/10 rounded-xl px-3.5 py-2.5">
                            <span className="text-lg mt-0.5">🔔</span>
                            <div>
                                <p className="text-sm font-bold text-amber-400">Volume &amp; Focus</p>
                                <p className="text-xs text-amber-400/70 leading-snug">
                                    Turn your volume up. Silent mode, Focus and device audio routing can affect what you
                                    hear; the test above is the only honest check of this device right now.
                                </p>
                            </div>
                        </div>

                        <div className="flex items-start gap-3 bg-sky-500/[0.06] border border-sky-500/10 rounded-xl px-3.5 py-2.5">
                            <span className="text-lg mt-0.5">📱</span>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-bold text-sky-400">
                                    {isNative ? 'Locked-screen fallback' : 'Keep Thalassa visible'}
                                </p>
                                {isNative ? (
                                    <>
                                        <p className="text-xs text-sky-400/70 leading-snug">
                                            Background GPS can continue on this device. Locked-screen warning depends on
                                            local-notification permission; keep Thalassa running and verify the
                                            foreground speaker test as well.
                                        </p>
                                        <p
                                            className={`mt-1.5 text-xs font-bold ${
                                                notificationReadiness === 'denied' ||
                                                notificationReadiness === 'unavailable'
                                                    ? 'text-red-300'
                                                    : 'text-sky-200'
                                            }`}
                                            aria-live="polite"
                                            role={
                                                notificationReadiness === 'denied' ||
                                                notificationReadiness === 'unavailable'
                                                    ? 'alert'
                                                    : 'status'
                                            }
                                        >
                                            {notificationReadiness === 'checking'
                                                ? 'Checking notification permission…'
                                                : notificationReadiness === 'granted'
                                                  ? 'Notifications allowed.'
                                                  : notificationReadiness === 'denied'
                                                    ? 'Notifications are off — locked-screen alerts are unavailable.'
                                                    : notificationReadiness === 'prompt'
                                                      ? 'Notification permission has not been granted.'
                                                      : notificationReadinessError ||
                                                        'Notification readiness could not be verified.'}
                                        </p>
                                        {notificationReadiness === 'prompt' && (
                                            <button
                                                type="button"
                                                onClick={() => void requestNotificationPermission()}
                                                className="mt-2 min-h-[44px] w-full rounded-xl border border-sky-400/25 bg-sky-500/15 px-3 py-2 text-xs font-black text-sky-200"
                                            >
                                                Allow Locked-Screen Alerts
                                            </button>
                                        )}
                                    </>
                                ) : (
                                    <p className="text-xs text-sky-400/70 leading-snug">
                                        Browser audio and GPS cannot be relied on after the screen locks or this tab is
                                        backgrounded. Keep the screen awake with Thalassa in view.
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Actions */}
                <div className="anchor-sound-check-actions shrink-0 border-t border-white/[0.06] bg-slate-950/95 px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                    <div className="flex gap-2.5">
                        <button
                            ref={cancelButtonRef}
                            aria-label={
                                testState === 'stop-failed' ? 'Retry stopping alarm and cancel' : 'Cancel this action'
                            }
                            onClick={handleCancel}
                            disabled={testState === 'stopping'}
                            className="flex-1 py-3 rounded-xl bg-white/5 border border-white/[0.06] text-sm font-bold text-slate-400 hover:text-white transition-colors disabled:cursor-wait disabled:opacity-60"
                        >
                            {testState === 'stopping'
                                ? 'Stopping…'
                                : testState === 'stop-failed'
                                  ? 'Retry Stop & Cancel'
                                  : 'Cancel'}
                        </button>
                        <button
                            aria-label="Confirm selection"
                            onClick={handleConfirm}
                            disabled={!alarmAudibilityConfirmed || notificationBlocked || audioCleanupBlocked}
                            aria-describedby={confirmRequirementIds || undefined}
                            className="flex-[2] py-3 rounded-xl text-white text-sm font-black transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
                            style={{
                                background: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)',
                                boxShadow: '0 4px 16px rgba(249,115,22,0.3)',
                            }}
                        >
                            ⚓ Drop Anchor
                        </button>
                    </div>
                    {(!alarmAudibilityConfirmed || audioCleanupBlocked) && (
                        <p id="anchor-audio-requirement" className="pt-2 text-center text-xs font-bold text-red-300">
                            {audioCleanupBlocked
                                ? 'The test alarm must be confirmed stopped before Anchor Watch can start.'
                                : 'Play the real alarm and confirm you heard it before Anchor Watch can start.'}
                        </p>
                    )}
                    {notificationBlocked && (
                        <p
                            id="anchor-notification-requirement"
                            className="pt-1 text-center text-xs font-bold text-red-300"
                        >
                            Locked-screen alerts must be verified before Anchor Watch can start.
                        </p>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
});

SoundCheckModal.displayName = 'SoundCheckModal';
