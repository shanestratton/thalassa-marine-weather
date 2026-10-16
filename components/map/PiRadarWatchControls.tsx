import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { getPairing } from '../../services/PiPairingService';
import {
    PiRadarWatchStateStore,
    type PiRadarWatchState,
    type PiRadarWatchController,
} from '../../services/radar/piRadarWatchState';
const button =
    'min-h-11 rounded-lg border border-slate-400/40 px-3 py-2 text-left text-xs font-bold disabled:opacity-50';
export function PiRadarWatchControls({
    controller = PiRadarWatchStateStore,
    paired = !!getPairing(),
}: { controller?: PiRadarWatchController; paired?: boolean } = {}) {
    const state = useSyncExternalStore(controller.subscribe, controller.get);
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const release = controller.retain(),
            timer = setInterval(() => setNow(Date.now()), 1000);
        return () => {
            clearInterval(timer);
            release();
        };
    }, [controller]);
    if (!paired) return null;
    const cloud = state.source === 'cloud';
    const view = state.view,
        fresh = state.fresh && !!view && now - view.servedAt <= (cloud ? 30000 : 5000) && now >= view.servedAt - 1000;
    const other = !!view?.context && view.context.binding.deviceId !== state.deviceId;
    const watching = fresh && view.running && view.state === 'armed';
    return (
        <div
            data-testid="pi-radar-watch"
            className="w-full min-w-0 rounded-lg border border-slate-400/30 p-2 text-xs [overflow-wrap:anywhere]"
            style={{ flexBasis: '100%', whiteSpace: 'normal' }}
        >
            <p className="font-bold">
                {cloud && fresh && view.context
                    ? 'Pi radar relay received · feed status unknown'
                    : watching
                      ? 'Pi radar watch running'
                      : fresh && view.state === 'off'
                        ? 'Pi radar watch off'
                        : fresh && view.context
                          ? 'Pi radar watch cannot qualify the current feed'
                          : 'Pi radar watch unconfirmed'}
            </p>
            <p>
                {cloud
                    ? 'Owned alarm facts only. A cloud heartbeat does not prove connected radar or a current CPA.'
                    : fresh && view.context
                      ? 'Radar reports and original navigation clocks are evaluated on the Pi.'
                      : 'Radar needs update 7, an explicitly configured physical feed and a deliberate arm.'}
            </p>
            {!cloud && view?.context && (
                <p>
                    {other
                        ? 'Another phone controls this watch. Taking over replaces its radar configuration.'
                        : 'This phone controls this watch.'}
                </p>
            )}
            {!cloud && view?.context && (
                <p>
                    {view.push.state === 'ready'
                        ? 'Radar relay ready; this phone’s push delivery is not proven.'
                        : view.push.state === 'internet-off'
                          ? 'Pi radar push unavailable: Pi internet use is off.'
                          : view.push.state === 'conflict'
                            ? 'Radar relay has a different controller; review before replacing it.'
                            : 'Radar push is unconfirmed.'}
                </p>
            )}
            {state.error && (
                <p role="status" className="mt-1 text-amber-300">
                    {state.error}
                </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
                <button className={button} disabled={state.busy} onClick={() => void controller.refresh(true)}>
                    Refresh radar status
                </button>
                {!cloud && (
                    <button
                        className={button}
                        disabled={state.busy || (other && !fresh)}
                        onClick={() => void controller.armDeliberately(!!view?.context)}
                    >
                        {other
                            ? 'Take over Pi radar watch'
                            : view?.context
                              ? 'Apply current radar thresholds'
                              : 'Arm Pi radar'}
                    </button>
                )}
                {!cloud && view?.context && !other && (
                    <button
                        className={button}
                        disabled={state.busy}
                        onClick={() => void controller.standDownDeliberately()}
                    >
                        Stand Pi radar down
                    </button>
                )}
                {!cloud && fresh && !other && view?.push.state === 'conflict' && (
                    <button className={button} disabled={state.busy} onClick={() => void controller.reviewRelay()}>
                        Replace the reviewed radar relay context
                    </button>
                )}
            </div>
        </div>
    );
}
export function PiRadarAlarmCards({
    state,
    now,
    acknowledge = (key: string) => PiRadarWatchStateStore.acknowledge(key),
}: {
    state: PiRadarWatchState;
    now: number;
    acknowledge?: (key: string) => Promise<void>;
}) {
    const view = state.view;
    if (!view) return null;
    const fresh =
        state.fresh && now - view.servedAt <= (state.source === 'cloud' ? 30000 : 5000) && now >= view.servedAt - 1000;
    return (
        <>
            {view.capacity && (
                <section
                    role="alert"
                    className="rounded-xl border border-amber-400/60 bg-slate-950 p-3 text-sm text-amber-200"
                >
                    <strong>Pi radar capacity reached</strong>
                    <p>Existing encounters remain; the radar picture is incomplete. Check the radar display.</p>
                </section>
            )}
            {view.alarms.slice(0, 5).map((card) => {
                const unknown =
                    state.source === 'cloud' ||
                    !fresh ||
                    !view.running ||
                    card.unknown ||
                    now - card.sourceAt > 15000 ||
                    now < card.sourceAt - 1000;
                return (
                    <section
                        key={card.key}
                        data-pi-radar-alarm={card.key}
                        role="alert"
                        className="rounded-xl border border-rose-400/60 bg-slate-950 p-3 text-sm text-rose-100 [overflow-wrap:anywhere]"
                    >
                        <p className="text-xs font-bold">
                            PI · RADAR TARGET {card.targetNumber} · {card.talker}
                        </p>
                        <strong className="mt-1 block text-base">{card.name}</strong>
                        <p className="font-bold">
                            {unknown
                                ? 'CPA unknown · not shown clear'
                                : card.cleared === 'passed'
                                  ? 'Shown clear'
                                  : card.cleared === 'lost'
                                    ? 'Contact lost · not shown clear'
                                    : card.closeQuarters
                                      ? 'Close quarters'
                                      : 'Collision risk'}
                        </p>
                        {!unknown && !card.cleared && (
                            <p>
                                CPA {card.cpaNm?.toFixed(2) ?? 'unknown'} NM · TCPA{' '}
                                {card.tcpaMin?.toFixed(1) ?? 'unknown'} min
                            </p>
                        )}
                        <p>
                            {card.rangeNm === null ? 'Range unknown' : card.rangeNm.toFixed(2) + ' NM last assessed'} ·{' '}
                            {card.bearingDeg === null
                                ? 'unknown bearing'
                                : Math.round(card.bearingDeg).toString().padStart(3, '0') + '°T'}
                        </p>
                        <p className="text-xs text-slate-300">
                            Original report {Math.max(0, Math.round((now - card.reportAt) / 1000))} s old. Evaluated on
                            the Pi.
                        </p>
                        {!card.cleared && (
                            <button
                                className={button + ' mt-2 w-full'}
                                disabled={!fresh || state.busy || card.actionable === false}
                                onClick={() => void acknowledge(card.key)}
                            >
                                {card.closeQuarters ? 'Acknowledge Pi radar episode' : 'Mute Pi radar 30 min'}
                            </button>
                        )}
                        {(!fresh || card.actionable === false) && (
                            <p className="text-xs text-amber-200">
                                Refresh the owned Pi context before acknowledging. A failed read does not clear this
                                encounter.
                            </p>
                        )}
                    </section>
                );
            })}
            {(view.more || view.alarms.length > 5) && (
                <p role="status" className="rounded-lg bg-slate-950 p-2 text-sm text-rose-100">
                    More Pi radar encounters remain held.
                </p>
            )}
        </>
    );
}
