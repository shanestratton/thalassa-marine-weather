import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { OverlayPortal } from '../ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import {
    activateFollowedCourse,
    clearSavedCourseReceipts,
    PiCourseError,
    previewFollowedCourse,
    type CoursePreview,
} from '../../services/piCourse';

export default function FollowedCourseDialog({ onClose }: { onClose: () => void }) {
    const [preview, setPreview] = useState<CoursePreview | null>(null);
    const [standby, setStandby] = useState(false),
        [replace, setReplace] = useState(false);
    const [stage, setStage] = useState<'loading' | 'ready' | 'sending' | 'clearing' | 'sent' | 'error'>('loading');
    const [message, setMessage] = useState(''),
        [clock, setClock] = useState(Date.now());
    const alive = useRef(true),
        generation = useRef(0),
        close = useRef(onClose);
    close.current = onClose;
    const busy = stage === 'sending' || stage === 'clearing';
    const title = useId();
    const retire = useCallback(() => {
        generation.current++;
    }, []);
    const trap = useFocusTrap(true, {
        onEscape: () => {
            if (!busy) close.current();
        },
    });
    const load = useCallback(async () => {
        const own = ++generation.current;
        setPreview(null);
        setStandby(false);
        setReplace(false);
        setStage('loading');
        setMessage('');
        try {
            const result = await previewFollowedCourse();
            if (alive.current && own === generation.current) {
                setPreview(result);
                setStage('ready');
            }
        } catch (error) {
            if (alive.current && own === generation.current) {
                setMessage(
                    error instanceof PiCourseError
                        ? error.message
                        : 'The paired Pi is not reachable. Connect on the boat’s Wi-Fi.',
                );
                setStage('error');
            }
        }
    }, []);
    useEffect(() => {
        alive.current = true;
        void load();
        const timer = setInterval(() => setClock(Date.now()), 1_000);
        const unsubscribe = subscribeAuthIdentityScope(() => close.current());
        return () => {
            alive.current = false;
            retire();
            clearInterval(timer);
            unsubscribe();
        };
    }, [load, retire]);
    const send = async () => {
        if (!preview || stage !== 'ready') return;
        setStage('sending');
        try {
            await activateFollowedCourse(preview, standby, replace);
            if (alive.current) {
                setStage('sent');
                setMessage(
                    'Route confirmed on the boat. Check it on the plotter before engaging the pilot at the helm.',
                );
            }
        } catch (error) {
            if (alive.current) {
                setStage('error');
                setPreview(null);
                setMessage(
                    error instanceof PiCourseError
                        ? error.message
                        : 'Sending is unconfirmed. Check the plotter before trying again.',
                );
            }
        }
    };
    const valid = preview && preview.current() && clock <= preview.expiresAt;
    const clearSent = async () => {
        setStage('clearing');
        setPreview(null);
        try {
            const count = await clearSavedCourseReceipts();
            if (alive.current) {
                setStage('sent');
                setMessage(
                    count
                        ? 'This phone’s sent route handoffs have been cleared. Check the plotter’s current destination.'
                        : 'No saved handoff to this paired boat.',
                );
            }
        } catch (error) {
            if (alive.current) {
                setStage('error');
                setMessage(
                    error instanceof PiCourseError
                        ? error.message
                        : 'Clearing is unconfirmed. Check the plotter at the helm.',
                );
            }
        }
    };
    return (
        <OverlayPortal className="flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm">
            <section
                ref={trap}
                role="dialog"
                aria-modal="true"
                aria-labelledby={title}
                className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/15 bg-slate-950 p-4 text-sm text-slate-100 shadow-2xl"
            >
                <div className="flex items-center justify-between gap-3">
                    <h2 id={title} className="text-base font-semibold">
                        Send followed route
                    </h2>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onClose}
                        aria-label="Close route confirmation"
                        className="min-h-11 min-w-11 rounded-lg border border-white/15 px-3 disabled:opacity-40"
                    >
                        Close
                    </button>
                </div>
                <p className="mt-2 leading-relaxed text-slate-300">
                    At the helm, put the pilot in standby. Check this route on the plotter before you engage the pilot.
                </p>
                {stage === 'loading' && (
                    <p role="status" className="mt-4">
                        Reading the boat’s current course…
                    </p>
                )}
                {preview && stage !== 'sent' && (
                    <div className="mt-3 space-y-3">
                        <p className="break-words font-medium">
                            {preview.name}
                            <span className="mt-1 block text-xs text-slate-400">
                                {preview.pointCount} points · exact followed route
                            </span>
                        </p>
                        <p className="text-slate-300">
                            {preview.pilotState === 'engaged'
                                ? 'The boat reports an active pilot. Put it in standby, then review again.'
                                : preview.pilotState === 'unknown'
                                  ? 'Pilot state is not reported. Confirm standby at the helm.'
                                  : 'The boat currently reports pilot standby.'}
                        </p>
                        <label className="flex min-h-11 items-start gap-3 rounded-lg border border-white/15 p-3">
                            <input
                                type="checkbox"
                                checked={standby}
                                disabled={busy}
                                onChange={(e) => {
                                    e.currentTarget.focus({ preventScroll: true });
                                    setStandby(e.target.checked);
                                }}
                                className="mt-1 h-5 w-5 shrink-0"
                            />
                            <span>I am at the helm with the pilot in standby.</span>
                        </label>
                        {preview.replacesDestination && (
                            <label className="flex min-h-11 items-start gap-3 rounded-lg border border-amber-400/30 p-3">
                                <input
                                    type="checkbox"
                                    checked={replace}
                                    disabled={busy}
                                    onChange={(e) => {
                                        e.currentTarget.focus({ preventScroll: true });
                                        setReplace(e.target.checked);
                                    }}
                                    className="mt-1 h-5 w-5 shrink-0"
                                />
                                <span>Replace the boat’s current destination with this route.</span>
                            </label>
                        )}
                        {!valid && (
                            <p role="status" className="text-amber-200">
                                The route changed or this confirmation expired. Review it again.
                            </p>
                        )}
                        <p className="text-xs leading-relaxed text-slate-400">
                            Stopping Follow asks the Pi to clear it. Check the plotter if offline.
                        </p>
                    </div>
                )}
                {message && (
                    <p
                        role={stage === 'error' ? 'alert' : 'status'}
                        className="mt-4 break-words rounded-lg border border-white/15 p-3 leading-relaxed"
                    >
                        {message}
                    </p>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                    {stage !== 'sent' && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={onClose}
                            className="min-h-11 grow rounded-xl border border-white/20 px-3 py-2 disabled:opacity-40"
                        >
                            Cancel
                        </button>
                    )}
                    {stage !== 'sent' && (
                        <button
                            type="button"
                            disabled={busy || stage === 'loading'}
                            onClick={() => void load()}
                            className="min-h-11 grow rounded-xl border border-white/20 px-3 py-2 disabled:opacity-40"
                        >
                            Review again
                        </button>
                    )}
                    {stage === 'ready' || stage === 'sending' ? (
                        <button
                            type="button"
                            disabled={
                                busy ||
                                !valid ||
                                !standby ||
                                (preview?.replacesDestination && !replace) ||
                                preview?.pilotState === 'engaged'
                            }
                            onClick={() => void send()}
                            className="min-h-11 grow rounded-xl bg-sky-700 px-3 py-2 font-semibold disabled:opacity-40"
                        >
                            {busy ? 'Confirming aboard…' : 'Send to plotter'}
                        </button>
                    ) : null}
                    {stage !== 'sent' && (
                        <button
                            type="button"
                            disabled={busy || stage === 'loading'}
                            onClick={() => void clearSent()}
                            className="min-h-11 w-full rounded-xl border border-white/20 px-3 py-2 disabled:opacity-40"
                        >
                            {stage === 'clearing' ? 'Checking sent routes…' : 'Clear this phone’s sent routes'}
                        </button>
                    )}
                    {stage === 'sent' && (
                        <button
                            type="button"
                            onClick={onClose}
                            className="min-h-11 grow rounded-xl bg-sky-700 px-3 py-2 font-semibold"
                        >
                            Done
                        </button>
                    )}
                </div>
            </section>
        </OverlayPortal>
    );
}
