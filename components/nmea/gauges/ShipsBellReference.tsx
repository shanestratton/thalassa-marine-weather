/**
 * What each bell means — the printed watch table, made live.
 *
 * Shane 2026-09-04: "can we have this on the chelsea ships bell… so i know
 * what each bell means???"
 *
 * The cell for right now is lit, so the table answers the question a skipper
 * actually has at 3 a.m. — "what was that?" — without them counting columns.
 * Every time here comes from utils/shipsBells, the same source the face
 * strikes from, so the reference can never drift from the instrument beside
 * it (tests/ShipsBellTable.test.ts pins both to the printed table).
 */
import React from 'react';
import {
    WATCH_ORDER,
    WATCH_SHORT,
    bellPattern,
    bellTime,
    bellsAt,
    bellsSpoken,
    watchAt,
} from '../../../utils/shipsBells';

interface Props {
    hour: number;
    minute: number;
}

const BRASS = '#e8c987';

export const ShipsBellReference: React.FC<Props> = ({ hour, minute }) => {
    const nowWatch = watchAt(hour, minute).name;
    const nowBells = bellsAt(hour, minute);

    return (
        <div className="rounded-2xl border border-white/[0.07] bg-slate-900/40 p-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="text-[13px] font-black tracking-wide text-slate-200">What the bells mean</h3>
                <span className="text-[11px] font-bold" style={{ color: BRASS }}>
                    {bellsSpoken(nowBells)} · {nowWatch}
                </span>
            </div>

            <div className="overflow-x-auto overscroll-x-contain">
                <table className="w-max border-collapse text-[11px]">
                    <thead>
                        <tr>
                            <th className="sticky left-0 z-10 bg-slate-900 px-2 py-1.5 text-left font-black text-slate-400">
                                Bells
                            </th>
                            {WATCH_ORDER.map((w) => (
                                <th
                                    key={w}
                                    className={`px-2 py-1.5 text-center font-black ${
                                        w === nowWatch ? 'text-slate-100' : 'text-slate-500'
                                    }`}
                                >
                                    {WATCH_SHORT[w]}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((bells) => (
                            <tr key={bells} className="border-t border-white/[0.05]">
                                <th className="sticky left-0 z-10 bg-slate-900 px-2 py-1.5 text-left font-bold text-slate-300">
                                    <span className="flex items-center gap-1.5">
                                        <span className="flex gap-[3px]">
                                            {bellPattern(bells).map((group, i) => (
                                                <span key={i} className="flex gap-[1px]">
                                                    {Array.from({ length: group }).map((_, j) => (
                                                        <span
                                                            key={j}
                                                            className="h-[5px] w-[5px] rounded-full"
                                                            style={{ background: BRASS }}
                                                        />
                                                    ))}
                                                </span>
                                            ))}
                                        </span>
                                        <span className="tabular-nums">{bells}</span>
                                    </span>
                                </th>
                                {WATCH_ORDER.map((w) => {
                                    const at = bellTime(w, bells);
                                    const isNow = w === nowWatch && bells === nowBells;
                                    return (
                                        <td
                                            key={w}
                                            className={`px-2 py-1.5 text-center tabular-nums ${
                                                isNow
                                                    ? 'rounded-md font-black text-slate-950'
                                                    : at
                                                      ? 'font-semibold text-slate-300'
                                                      : 'text-slate-700'
                                            }`}
                                            style={isNow ? { background: BRASS } : undefined}
                                        >
                                            {at ?? '·'}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <p className="mt-2 text-[11px] leading-4 text-slate-500">
                A watch is four hours and a bell is struck every half hour, one more each time, so eight bells ends it.
                The dog watches split 1600–2000 in two so no one stands the same watch daily — the first stops at four
                bells, and the last strikes <span className="text-slate-300">eight at 2000</span> to close the day.
            </p>
        </div>
    );
};
