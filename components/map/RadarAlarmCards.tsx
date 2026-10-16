import React from 'react';
import { RadarAlarmStore, type RadarAlarmSnapshot } from '../../services/radar/radarAlarmStore';
/** Source/episode actions stay separate from numeric AIS acknowledgements. */
export function RadarAlarmCards({ state, now }: { state: RadarAlarmSnapshot; now: number }) {
    return (
        <>
            {state.capacity && (
                <section
                    role="alert"
                    data-radar-capacity
                    className="rounded-xl border border-amber-400/60 bg-slate-950 p-3 text-sm text-amber-200"
                >
                    <strong>Radar watch capacity reached</strong>
                    <p>
                        More qualified threats were reported than can be held. Existing alarms remain; the picture is
                        incomplete.
                    </p>
                    {!state.capacity.acknowledged && (
                        <button
                            type="button"
                            className="mt-2 min-h-11 w-full rounded-lg border border-amber-400/50 font-bold"
                            onClick={() => RadarAlarmStore.acknowledgeCapacity(state.capacity!.sourceAt)}
                        >
                            Acknowledge radar capacity warning
                        </button>
                    )}
                </section>
            )}
            {state.cards.slice(0, 5).map((card) => (
                <section
                    key={`${card.contactKey}:${card.episodeId}`}
                    role="alert"
                    data-radar-alarm={card.contactKey}
                    className="rounded-xl border border-rose-400/60 bg-slate-950 p-3 text-sm text-rose-100 [overflow-wrap:anywhere]"
                >
                    <div className="text-xs font-bold">
                        PHONE · RADAR TARGET {card.targetNumber} · {card.talker}
                    </div>
                    <strong className="mt-1 block text-base">{card.name}</strong>
                    <p className="font-bold">
                        {card.cleared === 'passed'
                            ? 'Shown clear'
                            : card.cleared === 'lost'
                              ? 'Contact lost · not shown clear'
                              : card.lost
                                ? 'CPA unknown · not shown clear'
                                : card.closeQuarters
                                  ? 'Close quarters'
                                  : 'Collision risk'}
                    </p>
                    {!card.lost && !card.cleared && (
                        <p>
                            CPA {card.assessment.cpaNm?.toFixed(2) ?? 'unknown'} NM · TCPA{' '}
                            {card.assessment.tcpaMin?.toFixed(1) ?? 'unknown'} min
                        </p>
                    )}
                    <p>
                        {card.assessment.rangeNm.toFixed(2)} NM last assessed ·{' '}
                        {Math.round(card.assessment.bearingDeg).toString().padStart(3, '0')}°T
                    </p>
                    <p className="text-xs text-slate-300">
                        Original report {Math.max(0, Math.round((now - card.reportAt) / 1000))} s old. Evaluated on this
                        phone.
                    </p>
                    <button
                        type="button"
                        className="mt-2 min-h-11 w-full rounded-lg border border-rose-300/40 font-bold"
                        aria-label={`${card.cleared ? 'Dismiss' : card.closeQuarters ? 'Acknowledge' : 'Mute for 30 minutes'} radar target ${card.targetNumber}: ${card.name}`}
                        onClick={() =>
                            card.cleared
                                ? RadarAlarmStore.dismiss(card.contactKey, card.episodeId)
                                : RadarAlarmStore.acknowledge({
                                      contactKey: card.contactKey,
                                      episodeId: card.episodeId,
                                      kind: card.closeQuarters ? 'radar-close-quarters' : 'radar-collision',
                                  })
                        }
                    >
                        {card.cleared ? 'Dismiss' : card.closeQuarters ? 'Acknowledge' : 'Mute 30 min'}
                    </button>
                </section>
            ))}
            {state.cards.length > 5 && (
                <p role="status" className="rounded-lg bg-slate-950 p-2 text-sm text-rose-100">
                    {state.cards.length - 5} more radar encounters remain held.
                </p>
            )}
        </>
    );
}
