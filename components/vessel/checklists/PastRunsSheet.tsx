/**
 * PastRunsSheet — when each checklist was last run, and what failed
 * (132-B16, CHK-10). Every Complete has been saved to checklist_runs since
 * 126, but no screen showed them. Opened from the Checklists page's ⋮ and
 * loaded only then.
 */
import React, { useMemo } from 'react';
import type { ChecklistEntry, ChecklistRun } from '../../../services/vessel/LocalChecklistService';
import { formatDisplayDate } from '../../../utils/displayDate';
import { ModalSheet } from '../../ui/ModalSheet';
import { WrenchIcon, XIcon } from '../../Icons';
import { summariseRunHistory, type PastRun } from './runHistory';

/** Runs shown per checklist: the last one and the few before it. */
const RUNS_SHOWN = 5;

/** 'Tue 13 Oct 2026, 14:05', on the phone's own clock. */
export function runWhen(iso: string): string {
    const date = new Date(iso);
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return `${formatDisplayDate(iso)}, ${time}`;
}

/** '11 passed · 1 failed · 2 not checked', or 'All 12 passed'. */
export function runTally(run: PastRun): string {
    const failed = run.failed.length;
    const total = run.passed + failed + run.unchecked;
    if (failed === 0 && run.unchecked === 0) return total === 1 ? 'Passed' : `All ${total} passed`;
    const parts = [`${run.passed} passed`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (run.unchecked > 0) parts.push(`${run.unchecked} not checked`);
    return parts.join(' · ');
}

const RunResult: React.FC<{ run: PastRun }> = ({ run }) => (
    <>
        <p className={`text-xs font-bold ${run.failed.length > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {runTally(run)}
        </p>
        {run.failed.length > 0 && (
            <ul aria-label="Failed" className="mt-1 space-y-1">
                {run.failed.map((item) => (
                    <li key={item.entry_id} className="flex items-start gap-1.5 text-sm text-white/80">
                        <XIcon className="mt-1 h-3 w-3 shrink-0 text-red-400" />
                        <span className="min-w-0 break-words">
                            {item.text}
                            {/* Flagged, not 'added': whether the repair reached
                                Maintenance was said once, on Complete. */}
                            {item.flagged_rm && (
                                <span className="ml-1.5 inline-flex items-center gap-1 text-micro font-bold text-amber-400">
                                    <WrenchIcon className="h-3 w-3" />
                                    flagged for repair
                                </span>
                            )}
                        </span>
                    </li>
                ))}
            </ul>
        )}
    </>
);

interface PastRunsSheetProps {
    runs: ChecklistRun[];
    entries: ChecklistEntry[];
    onClose: () => void;
}

export const PastRunsSheet: React.FC<PastRunsSheetProps> = ({ runs, entries, onClose }) => {
    const lists = useMemo(() => summariseRunHistory(runs, entries), [runs, entries]);
    // Lists with items that have never been completed: 'last run' is never.
    const notRun = useMemo(() => {
        const run = new Set(lists.map((list) => list.key));
        const withItems = new Set(entries.filter((e) => e.type === 'detail').map((e) => e.heading_id));
        return entries.filter((e) => e.type === 'heading' && withItems.has(e.id) && !run.has(e.id)).map((e) => e.text);
    }, [entries, lists]);

    return (
        <ModalSheet isOpen onClose={onClose} title="Past runs">
            {lists.length === 0 ? (
                <p className="text-sm text-gray-400">
                    No runs yet. Tap Run on a checklist; each one you complete is kept here.
                </p>
            ) : (
                <div className="space-y-4">
                    {lists.map((list) => {
                        const [last, ...earlier] = list.runs;
                        const hidden = earlier.length - (RUNS_SHOWN - 1);
                        return (
                            <section
                                key={list.key}
                                aria-label={list.name}
                                className="rounded-xl border border-white/8 bg-white/3 p-3.5"
                            >
                                <h4 className="text-micro font-black text-emerald-400 uppercase tracking-[0.2em] break-words">
                                    {list.name}
                                </h4>
                                <p className="mt-1 text-sm font-bold text-white">
                                    Last run {runWhen(last.completed_at)}
                                </p>
                                <RunResult run={last} />
                                {earlier.length > 0 && (
                                    <ul
                                        aria-label="Earlier runs"
                                        className="mt-3 space-y-2 border-t border-white/6 pt-2.5"
                                    >
                                        {earlier.slice(0, RUNS_SHOWN - 1).map((run) => (
                                            <li key={run.id}>
                                                <p className="text-xs text-gray-400">{runWhen(run.completed_at)}</p>
                                                <RunResult run={run} />
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {hidden > 0 && (
                                    <p className="mt-2 text-xs text-gray-400">
                                        {hidden} earlier run{hidden !== 1 ? 's' : ''} not shown
                                    </p>
                                )}
                            </section>
                        );
                    })}
                </div>
            )}
            {notRun.length > 0 && <p className="mt-4 text-xs text-gray-400">Not run yet: {notRun.join(', ')}</p>}
        </ModalSheet>
    );
};
