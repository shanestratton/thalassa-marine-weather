import React from 'react';
import { WakeAlarmStore, type WakeAlarmCard } from '../../services/alarms/wakeAlarmStore';
import { WAKE_LABELS } from '../../services/alarms/wakeRuleLabels';
import { WAKE_PRESETS } from '../../utils/wakeRule';
export function WakeAlarmCards({ cards }: { cards: readonly WakeAlarmCard[] }) {
    return (
        <>
            {cards.map((card) => (
                <div
                    key={card.preset}
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
                        {card.quiet ? 'Quiet hours' : card.muted ? 'Silenced for this episode' : 'Phone sensor alarm'}
                    </p>
                    <button
                        type="button"
                        className="mt-2 min-h-[44px] rounded-lg border border-white/20 px-3 text-xs"
                        onClick={WakeAlarmStore.mute}
                    >
                        Silence wake-rule alarms
                    </button>
                </div>
            ))}
        </>
    );
}
