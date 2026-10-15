/**
 * Past runs, checklist by checklist (132-B16, CHK-10): when each list was
 * last run and what failed. Completed runs only; a run still being ticked is
 * a draft on the phone running it (services/vessel/checklistRunDraft).
 *
 * A run from 132 on carries its checklist on every item (heading_id). Older
 * runs could hold every list at once and carry only the checklist's name, so
 * their items are matched to a list by that name, then (for a list renamed
 * since) by the item itself while it still exists; a list deleted since keeps
 * the name it had. A list with nothing checked in such a run was carried
 * along, not run, and is left out of it.
 */
import type { ChecklistEntry, ChecklistRun, ChecklistRunItem } from '../../../services/vessel/LocalChecklistService';

export interface PastRun {
    id: string;
    completed_at: string;
    passed: number;
    failed: ChecklistRunItem[];
    unchecked: number;
}

export interface ChecklistHistory {
    /** The checklist's id, or 'name:…' for a list that is no longer on the page. */
    key: string;
    name: string;
    /** Newest first. */
    runs: PastRun[];
}

function completedTime(run: ChecklistRun): number {
    const time = run.completed_at ? Date.parse(run.completed_at) : Number.NaN;
    return Number.isFinite(time) ? time : Number.NaN;
}

export function summariseRunHistory(runs: ChecklistRun[], entries: ChecklistEntry[]): ChecklistHistory[] {
    const headings = new Map(entries.filter((e) => e.type === 'heading').map((h) => [h.id, h]));
    const itemHeading = new Map(
        entries.filter((e) => e.type === 'detail' && e.heading_id).map((e) => [e.id, e.heading_id as string]),
    );
    const headingByName = new Map<string, string>();
    for (const h of headings.values()) if (!headingByName.has(h.text)) headingByName.set(h.text, h.id);

    const listOf = (item: ChecklistRunItem): { key: string; name: string } => {
        const id = item.heading_id ?? headingByName.get(item.heading) ?? itemHeading.get(item.entry_id);
        const heading = id ? headings.get(id) : undefined;
        if (heading) return { key: heading.id, name: heading.text };
        // Gone from the page: its id (or, before 132, its name) still groups its runs.
        return { key: item.heading_id ?? `name:${item.heading}`, name: item.heading };
    };

    const lists = new Map<string, ChecklistHistory & { latest: number }>();
    const completed = runs
        .filter((run) => Number.isFinite(completedTime(run)) && Array.isArray(run.items))
        .sort((a, b) => completedTime(b) - completedTime(a));
    for (const run of completed) {
        const byList = new Map<string, { name: string; items: ChecklistRunItem[] }>();
        for (const item of run.items) {
            const { key, name } = listOf(item);
            const group = byList.get(key) ?? { name, items: [] };
            group.items.push(item);
            byList.set(key, group);
        }
        for (const [key, group] of byList) {
            // A pre-132 run held every list at once, so a list with nothing
            // checked in it was not run, only carried along: it falls back to
            // its last real run, or to 'Not run yet'.
            const legacy = group.items.every((i) => !i.heading_id);
            if (legacy && group.items.every((i) => i.status === 'unchecked')) continue;
            const list = lists.get(key) ?? { key, name: group.name, runs: [], latest: completedTime(run) };
            list.runs.push({
                id: run.id,
                completed_at: run.completed_at as string,
                passed: group.items.filter((i) => i.status === 'pass').length,
                failed: group.items.filter((i) => i.status === 'fail'),
                unchecked: group.items.filter((i) => i.status === 'unchecked').length,
            });
            lists.set(key, list);
        }
    }
    return [...lists.values()]
        .sort((a, b) => b.latest - a.latest)
        .map(({ key, name, runs: listRuns }) => ({
            key,
            name,
            runs: listRuns,
        }));
}
