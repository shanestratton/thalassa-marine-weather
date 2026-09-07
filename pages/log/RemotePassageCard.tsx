/**
 * RemotePassageCard — the account's passage is under way on ANOTHER device.
 *
 * Shane 2026-09-08: a second phone signed into the same account opened to an
 * empty Log page and could overwrite the route the first phone was following.
 * This card is what the second phone sees instead: who is recording, which
 * route is published and who set it, and the two honest doors — record here
 * as well, or change the route (which confirms against the other device's
 * name before anything is written).
 *
 * Inline card, never a toast. Sits where the skipper-claim notice sits, above
 * the totals, so it is the first thing on the page.
 */
import React from 'react';
import { remotePassageSinceLabel, type RemotePassage } from '../../services/shiplog/remotePassage';

export const RemotePassageCard: React.FC<{
    passage: RemotePassage;
    /** Display name of the published route, when this device can name it. */
    routeLabel: string | null;
    busy: boolean;
    onRecordHere: () => void;
    onChangeRoute: () => void;
}> = ({ passage, routeLabel, busy, onRecordHere, onChangeRoute }) => {
    const recorder = passage.recordingDeviceName?.trim() || 'another device';
    const title =
        passage.voyageName?.trim() ||
        (passage.departurePort && passage.destinationPort
            ? `${passage.departurePort} → ${passage.destinationPort}`
            : 'Passage under way');
    const since = remotePassageSinceLabel(passage.departureTime);
    const setBy = passage.linkHeldElsewhere ? passage.link?.deviceName?.trim() || 'another device' : null;

    return (
        <div className="shrink-0 px-4 pb-3" data-testid="remote-passage-card">
            <div className="rounded-2xl border border-sky-500/25 bg-linear-to-br from-sky-500/10 via-sky-500/4 to-transparent p-3.5">
                <div className="flex items-start gap-2.5">
                    <span className="mt-px text-base leading-none" aria-hidden="true">
                        ⛵
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-black uppercase tracking-widest text-sky-300">
                            Under way on another device
                        </div>
                        <div className="mt-0.5 truncate text-sm font-black text-white">{title}</div>
                        <p
                            className="mt-1 text-[12px] leading-snug text-gray-300"
                            data-testid="remote-passage-recorder"
                        >
                            Recording on <span className="font-bold text-white">{recorder}</span>
                            {since ? ` · ${since}` : ''}
                        </p>
                        <p className="mt-0.5 text-[12px] leading-snug text-gray-300" data-testid="remote-passage-route">
                            {passage.link ? (
                                <>
                                    Following{' '}
                                    <span className="font-bold text-white">{routeLabel ?? 'a saved route'}</span>
                                    {setBy ? (
                                        <span className="text-gray-400">
                                            {' · set by '}
                                            {setBy}
                                        </span>
                                    ) : null}
                                </>
                            ) : (
                                'No route on the public page yet'
                            )}
                        </p>
                    </div>
                </div>
                <div className="mt-2.5 grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={onRecordHere}
                        disabled={busy}
                        data-testid="remote-passage-record"
                        className="h-11 rounded-xl bg-sky-500/20 px-3 text-xs font-black uppercase tracking-[0.06em] text-sky-100 transition-colors active:brightness-110 disabled:opacity-50"
                    >
                        {busy ? 'Starting…' : 'Record here too'}
                    </button>
                    <button
                        type="button"
                        onClick={onChangeRoute}
                        disabled={busy}
                        data-testid="remote-passage-change-route"
                        className="h-11 rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-black uppercase tracking-[0.06em] text-gray-200 transition-colors active:brightness-110 disabled:opacity-50"
                    >
                        {passage.link ? 'Change the route' : 'Follow a route'}
                    </button>
                </div>
            </div>
        </div>
    );
};

RemotePassageCard.displayName = 'RemotePassageCard';
