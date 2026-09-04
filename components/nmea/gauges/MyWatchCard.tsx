/**
 * The crew member's own watch, and waking them for it.
 *
 * Shane 2026-09-04: "how do we know what watch the punter is on. it should be
 * taken from the watch card of the passage planning… so if there is no watch
 * for this user, then nothing shows and that page does not exist."
 *
 * So this never renders an empty state — the section around it is not mounted
 * at all when services/myWatches returns nothing. It assumes it has a watch.
 *
 * The "Wake me" pills were three odd-width chips wrapping onto two lines
 * ("clean that up a bit. make it more symmetrical. better pills"). They are
 * now an even grid of equal cells, and they mean something concrete: minutes
 * before THIS crew member's next watch, not a generic bell.
 */
import React from 'react';
import type { MyWatch } from '../../../services/myWatches';

export interface WatchLeadOption {
    /** Minutes before the watch starts. 0 = on the hour. */
    minutes: number;
    label: string;
}

export const WATCH_LEADS: WatchLeadOption[] = [
    { minutes: 30, label: '30 min' },
    { minutes: 15, label: '15 min' },
    { minutes: 0, label: 'On watch' },
];

function countdown(to: Date, now: Date): string {
    const ms = to.getTime() - now.getTime();
    if (ms <= 0) return 'now';
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `in ${mins} min`;
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    if (hours < 24) return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
    return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

interface Props {
    watches: MyWatch[];
    now: Date;
    /** Disabled while a lead time already has an alarm set. */
    armedLeads: Set<number>;
    onWake: (lead: WatchLeadOption, watch: MyWatch) => void;
}

export const MyWatchCard: React.FC<Props> = ({ watches, now, armedLeads, onWake }) => {
    const next = watches[0];
    const later = watches.slice(1, 4);

    return (
        <div className="flex flex-col gap-3">
            <div className="rounded-2xl border border-amber-400/25 bg-amber-400/8 p-4 text-center">
                <p className="text-[11px] font-black uppercase tracking-widest text-amber-300/70">Your next watch</p>
                <p className="mt-1 text-2xl font-black tracking-tight text-white">{next.label}</p>
                <p className="mt-0.5 text-sm font-bold tabular-nums text-amber-200">{next.timeLabel} UTC</p>
                <p className="mt-2 text-[13px] font-semibold text-slate-300">{countdown(next.startsAt, now)}</p>
            </div>

            <div>
                <p className="mb-2 px-1 text-xs font-black uppercase tracking-widest text-gray-400">Wake me</p>
                {/* An even grid, not wrapping chips: three equal cells that
                    stay three equal cells on every screen. */}
                <div className="grid grid-cols-3 gap-2">
                    {WATCH_LEADS.map((lead) => {
                        const armed = armedLeads.has(lead.minutes);
                        return (
                            <button
                                key={lead.minutes}
                                onClick={() => onWake(lead, next)}
                                aria-pressed={armed}
                                className={`min-h-[56px] rounded-2xl border text-sm font-black tracking-tight transition-all active:scale-[0.97] ${
                                    armed
                                        ? 'border-amber-400/50 bg-amber-400/20 text-amber-100'
                                        : 'border-white/10 bg-white/5 text-slate-200'
                                }`}
                            >
                                <span className="block">{lead.label}</span>
                                <span className="mt-0.5 block text-[10px] font-bold uppercase tracking-widest text-slate-400">
                                    {armed ? 'set' : lead.minutes === 0 ? 'at start' : 'before'}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {later.length > 0 && (
                <div>
                    <p className="mb-2 px-1 text-xs font-black uppercase tracking-widest text-gray-400">Then</p>
                    <ul className="space-y-1.5">
                        {later.map((w) => (
                            <li
                                key={`${w.index}-${w.startsAt.toISOString()}`}
                                className="flex items-center justify-between gap-2 rounded-xl bg-white/4 px-3 py-2"
                            >
                                <span className="truncate text-sm font-bold text-white">{w.label}</span>
                                <span className="shrink-0 text-[12px] font-semibold tabular-nums text-slate-400">
                                    {w.timeLabel} · {countdown(w.startsAt, now)}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
};
