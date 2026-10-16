import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { WakeRuleWatch } from '../../services/alarms/WakeRuleWatch';
import { readWakeRuleSensors } from '../../services/alarms/wakeRuleRuntime';
import { WAKE_LABELS } from '../../services/alarms/wakeRuleLabels';
import { WAKE_PRESETS } from '../../utils/wakeRule';
const timeText = (minute: number) =>
    `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
export function WakePiControls() {
    const view = useSyncExternalStore(WakeRuleWatch.subscribe, WakeRuleWatch.getSnapshot);
    const [replace, setReplace] = useState(false),
        [replaceDelivery, setReplaceDelivery] = useState(false),
        [message, setMessage] = useState('');
    const revision = view.pi?.configuration?.revision;
    const canClear = !!revision && view.pi?.configuration?.binding.feedId === view.pi?.binding?.feedId;
    const conflict = view.pi?.push.state === 'conflict' ? view.pi.push.conflict : undefined;
    const savedRules = view.pi?.configuration?.rules.filter((rule) => rule.enabled) ?? [];
    const reviewKey = conflict
        ? JSON.stringify([
              revision,
              view.pi?.configuration?.rulesDigest,
              view.pi?.binding,
              conflict.revision,
              conflict.rulesDigest,
          ])
        : '';
    useEffect(() => setReplace(false), [revision]);
    useEffect(() => setReplaceDelivery(false), [reviewKey]);
    const button = 'min-h-[44px] rounded-lg border border-white/20 px-3 py-2 text-xs text-white disabled:opacity-40';
    return (
        <div className="space-y-2 rounded-lg border border-white/10 p-2 text-xs">
            <p role="status">
                {view.keeper === 'pi' ? 'Pi is evaluating these saved rules.' : 'Phone only while the app is active.'}
            </p>
            <p className="text-amber-200">
                {view.keeper === 'pi' && view.pi?.push.state === 'ready' && view.pi.push.capability === 1
                    ? 'The paired Pi recently confirmed relay support and a registered recipient. Delivery depends on its internet, APNs and phone settings.'
                    : view.pi?.push.state === 'conflict'
                      ? 'Cloud wake rules changed. Locked-phone delivery is held for review.'
                      : 'Locked-phone delivery is unavailable.'}
            </p>
            <p className="break-words text-gray-400">
                {view.state === 'update'
                    ? 'The boat needs Pi update 7 to supply these sensors.'
                    : view.state === 'enrollment'
                      ? 'Set this phone up with the boat’s Pi first.'
                      : view.state === 'unavailable'
                        ? 'Connect to the paired boat’s Wi-Fi to read sensors.'
                        : view.state === 'conflict'
                          ? 'Pi rules changed elsewhere. Read status before replacing them.'
                          : view.state === 'error'
                            ? 'Boat status is unavailable. An active phone alarm stays active.'
                            : view.state === 'paused'
                              ? 'Phone watch is paused.'
                              : view.state === 'connecting'
                                ? 'Reading boat sensors…'
                                : view.state === 'watching'
                                  ? 'Reading measured boat sensors.'
                                  : 'Read boat sensors to choose a source.'}
            </p>
            {view.pi?.pressure.state === 'warming' && (
                <p className="text-gray-400">
                    Pressure is warming up: at least 90 minutes of measured samples are needed.
                </p>
            )}
            {view.pi?.reason === 'binding-changed' && (
                <p className="text-amber-200">
                    The boat source changed. Review the Pi’s saved rules before replacing them.
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    className={button}
                    disabled={view.busy}
                    onClick={() => {
                        setMessage('');
                        void readWakeRuleSensors();
                    }}
                >
                    Read boat sensors
                </button>
                <button
                    type="button"
                    className={button}
                    disabled={view.busy || ['off', 'paused'].includes(view.state)}
                    onClick={() => WakeRuleWatch.stop('paused')}
                >
                    Pause phone watch
                </button>
            </div>
            {revision && (
                <label className="flex items-center gap-2">
                    <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                    Replace the Pi’s saved wake rules with these saved phone rules
                </label>
            )}
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    className={button}
                    disabled={view.busy || !view.pi || (!!revision && !replace)}
                    onClick={() => {
                        void WakeRuleWatch.configurePi(replace).then((ok) =>
                            setMessage(
                                ok
                                    ? 'Sent. Waiting for the Pi to confirm it is running.'
                                    : 'Could not confirm. Read status before trying again.',
                            ),
                        );
                    }}
                >
                    Keep saved rules on Pi
                </button>
                <button
                    type="button"
                    className={button}
                    disabled={view.busy || !canClear}
                    onClick={() => {
                        void WakeRuleWatch.clearPi().then((ok) =>
                            setMessage(
                                ok ? 'Pi wake rules stopped.' : 'Could not confirm. Read status before trying again.',
                            ),
                        );
                    }}
                >
                    Stop Pi wake rules
                </button>
            </div>
            {conflict && (
                <section aria-label="Review phone delivery setup" className="space-y-2 border-t border-white/10 pt-2">
                    <p>
                        Replace the previous phone delivery setup for your account with this Pi’s saved rules and quiet
                        hours.
                    </p>
                    {(!conflict.feedMatches || conflict.retired) && (
                        <p className="text-amber-200">
                            {conflict.retired
                                ? 'The previous setup was stopped.'
                                : 'The previous setup uses a different sensor feed.'}
                        </p>
                    )}
                    <ul
                        aria-label="Saved Pi rules for delivery"
                        className="max-h-32 space-y-1 overflow-y-auto break-words"
                    >
                        {savedRules.map((rule) => (
                            <li key={rule.preset}>
                                {WAKE_LABELS[rule.preset]}:{' '}
                                {WAKE_PRESETS[rule.preset].comparison === 'below' ? '<' : '>'} {rule.threshold}{' '}
                                {WAKE_PRESETS[rule.preset].unit}
                                {rule.quietHours
                                    ? ` · quiet ${timeText(rule.quietHours.startMinute)}–${timeText(rule.quietHours.endMinute)} UTC${rule.quietHours.utcOffsetMinutes < 0 ? '−' : '+'}${timeText(Math.abs(rule.quietHours.utcOffsetMinutes))}`
                                    : ' · no quiet hours'}
                            </li>
                        ))}
                    </ul>
                    <label className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            checked={replaceDelivery}
                            onChange={(event) => setReplaceDelivery(event.target.checked)}
                        />
                        Use these saved Pi rules for phone delivery
                    </label>
                    <button
                        type="button"
                        className={button}
                        disabled={view.busy || !canClear || !savedRules.length || !replaceDelivery}
                        onClick={() => {
                            setReplaceDelivery(false);
                            void WakeRuleWatch.reviewPiRelay().then((ok) =>
                                setMessage(
                                    ok
                                        ? 'Review sent. Waiting for fresh Pi confirmation; delivery is not confirmed.'
                                        : 'Could not confirm. Read boat status before reviewing again.',
                                ),
                            );
                        }}
                    >
                        Restore phone delivery
                    </button>
                </section>
            )}
            {message && (
                <p role="status" className="text-amber-200">
                    {message}
                </p>
            )}
        </div>
    );
}
