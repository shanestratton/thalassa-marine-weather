import React, { useState } from 'react';
import { WakeAlarmStore, type WakeAlarmCard } from '../../services/alarms/wakeAlarmStore';
import { WAKE_LABELS } from '../../services/alarms/wakeRuleLabels';
import { WAKE_PRESETS } from '../../utils/wakeRule';
export function WakeAlarmCards({ cards }: { cards: readonly WakeAlarmCard[] }) {
    const [message, setMessage] = useState<{ key: string; text: string } | null>(null),
        [busy, setBusy] = useState<string | null>(null);
    return (
        <>
            {cards.map((card) => (
                <div
                    key={card.cloud?.key ?? card.preset}
                    role="alert"
                    className="rounded-xl border border-amber-400/60 bg-slate-900 p-3 text-white shadow-xl"
                >
                    <p className="text-sm font-bold">{WAKE_LABELS[card.preset]}</p>
                    <p className="text-xs">
                        {card.value === null
                            ? 'Reading unavailable'
                            : `${card.value.toFixed(1)} ${WAKE_PRESETS[card.preset].unit}`}
                        {card.status === 'unknown' || card.status === 'error'
                            ? ' · Alarm retained until a fresh clear reading'
                            : ` · ${card.status}`}
                    </p>
                    <p className="text-xs text-gray-300">
                        {card.cloud ? 'Paired Pi wake rule · ' : ''}
                        {card.acknowledged
                            ? 'Acknowledged on Pi'
                            : card.quiet
                              ? 'Quiet hours'
                              : card.muted
                                ? 'Silenced for this episode'
                                : 'Sensor alarm'}
                    </p>
                    <button
                        type="button"
                        className="mt-2 min-h-[44px] rounded-lg border border-white/20 px-3 text-xs"
                        onClick={() => WakeAlarmStore.mute()}
                    >
                        Silence phone wake-rule alarms
                    </button>
                    {card.cloud && (
                        <button
                            type="button"
                            disabled={busy !== null}
                            className="mt-2 min-h-[44px] rounded-lg border border-white/20 px-3 text-xs disabled:opacity-40"
                            onClick={() => {
                                const key = card.cloud!.key;
                                setBusy(key);
                                setMessage(null);
                                void WakeAlarmStore.acknowledge(card.cloud!)
                                    .then((ok) =>
                                        setMessage({
                                            key,
                                            text: ok
                                                ? 'Pi acknowledgement saved.'
                                                : 'Pi acknowledgement not confirmed. Alarm retained.',
                                        }),
                                    )
                                    .finally(() => setBusy((old) => (old === key ? null : old)));
                            }}
                        >
                            Acknowledge this Pi alarm
                        </button>
                    )}
                    {message?.key === card.cloud?.key && (
                        <p role="status" className="text-xs">
                            {message?.text}
                        </p>
                    )}
                </div>
            ))}
        </>
    );
}
