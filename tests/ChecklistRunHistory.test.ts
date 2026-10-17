/**
 * Past runs, list by list (132-B16, CHK-10): summariseRunHistory groups the
 * completed runs in checklist_runs under the checklist each item was run
 * under, newest first. Runs from before 132 could hold every list at once and
 * name their list only by text; a list with nothing checked in one was not
 * run. Fictional lists.
 */
import { describe, expect, it } from 'vitest';
import { summariseRunHistory } from '../components/vessel/checklists/runHistory';
import { runTally } from '../components/vessel/checklists/PastRunsSheet';
import type {
    ChecklistEntry,
    ChecklistRun,
    ChecklistRunItem,
    RunItemStatus,
} from '../services/vessel/LocalChecklistService';

const at = '2026-01-01T00:00:00.000Z';
function entry(id: string, text: string, headingId: string | null): ChecklistEntry {
    return {
        id,
        type: headingId ? 'detail' : 'heading',
        text,
        heading_id: headingId,
        order: 0,
        created_at: at,
        updated_at: at,
    };
}
const ENTRIES = [
    entry('h-pre', 'Pre-departure', null),
    entry('i-bilge', 'Bilge pump', 'h-pre'),
    entry('i-seacocks', 'Close seacocks', 'h-pre'),
    entry('h-heavy', 'Heavy weather', null),
    entry('i-jib', 'Storm jib hanked on', 'h-heavy'),
];

function item(
    entryId: string,
    text: string,
    heading: string,
    status: RunItemStatus,
    headingId?: string,
): ChecklistRunItem {
    return { entry_id: entryId, heading, heading_id: headingId, text, status, flagged_rm: false, notes: '' };
}
function run(id: string, completedAt: string | null, items: ChecklistRunItem[]): ChecklistRun {
    return { id, started_at: completedAt ?? '2026-10-01T00:00:00.000Z', completed_at: completedAt, items };
}

describe('summariseRunHistory', () => {
    it('groups runs under their checklist, newest first, lists by their latest run', () => {
        const history = summariseRunHistory(
            [
                run('r1', '2026-10-01T00:00:00.000Z', [
                    item('i-jib', 'Storm jib hanked on', 'Heavy weather', 'pass', 'h-heavy'),
                ]),
                run('r2', '2026-10-03T00:00:00.000Z', [
                    item('i-bilge', 'Bilge pump', 'Pre-departure', 'fail', 'h-pre'),
                    item('i-seacocks', 'Close seacocks', 'Pre-departure', 'unchecked', 'h-pre'),
                ]),
                run('r3', '2026-10-02T00:00:00.000Z', [
                    item('i-bilge', 'Bilge pump', 'Pre-departure', 'pass', 'h-pre'),
                ]),
            ],
            ENTRIES,
        );
        expect(history.map((list) => [list.key, list.name, list.runs.map((r) => r.id)])).toEqual([
            ['h-pre', 'Pre-departure', ['r2', 'r3']],
            ['h-heavy', 'Heavy weather', ['r1']],
        ]);
        const last = history[0].runs[0];
        expect([last.passed, last.failed.map((i) => i.text), last.unchecked]).toEqual([0, ['Bilge pump'], 1]);
    });

    it('a run still in progress is not a past run', () => {
        expect(
            summariseRunHistory(
                [run('open', null, [item('i-bilge', 'Bilge pump', 'Pre-departure', 'pass', 'h-pre')])],
                ENTRIES,
            ),
        ).toEqual([]);
    });

    it('a pre-132 run of every list counts as a run of each, matched by name', () => {
        const history = summariseRunHistory(
            [
                run('legacy', '2026-09-20T00:00:00.000Z', [
                    item('i-bilge', 'Bilge pump', 'Pre-departure', 'pass'),
                    item('i-jib', 'Storm jib hanked on', 'Heavy weather', 'fail'),
                ]),
            ],
            ENTRIES,
        );
        expect(history.map((list) => [list.key, runTally(list.runs[0])])).toEqual([
            ['h-pre', 'Passed'],
            ['h-heavy', '0 passed · 1 failed'],
        ]);
    });

    it('a list with nothing checked in a pre-132 run was carried along, not run', () => {
        const history = summariseRunHistory(
            [
                run('legacy-new', '2026-09-20T01:00:00.000Z', [
                    item('i-bilge', 'Bilge pump', 'Pre-departure', 'pass'),
                    item('i-seacocks', 'Close seacocks', 'Pre-departure', 'unchecked'),
                    item('i-jib', 'Storm jib hanked on', 'Heavy weather', 'unchecked'),
                ]),
                run('legacy-old', '2026-09-01T01:00:00.000Z', [
                    item('i-bilge', 'Bilge pump', 'Pre-departure', 'unchecked'),
                    item('i-jib', 'Storm jib hanked on', 'Heavy weather', 'fail'),
                ]),
            ],
            ENTRIES,
        );
        // Heavy weather's last run is the one where it was ticked; Pre-departure's
        // older slice, with nothing ticked, is not a run of it.
        expect(history.map((list) => [list.key, list.runs.map((r) => r.id)])).toEqual([
            ['h-pre', ['legacy-new']],
            ['h-heavy', ['legacy-old']],
        ]);
        expect(runTally(history[0].runs[0])).toBe('1 passed · 1 not checked');
    });

    it('a list never ticked in any pre-132 run has no past run', () => {
        const history = summariseRunHistory(
            [
                run('legacy', '2026-09-20T01:00:00.000Z', [
                    item('i-bilge', 'Bilge pump', 'Pre-departure', 'pass'),
                    item('i-jib', 'Storm jib hanked on', 'Heavy weather', 'unchecked'),
                ]),
            ],
            ENTRIES,
        );
        expect(history.map((list) => list.key)).toEqual(['h-pre']);
    });

    it('a list run on its own from 132 counts even with nothing checked: it was chosen and completed', () => {
        const history = summariseRunHistory(
            [
                run('r1', '2026-10-05T00:00:00.000Z', [
                    item('i-jib', 'Storm jib hanked on', 'Heavy weather', 'unchecked', 'h-heavy'),
                ]),
            ],
            ENTRIES,
        );
        expect(history.map((list) => [list.key, runTally(list.runs[0])])).toEqual([
            ['h-heavy', '0 passed · 1 not checked'],
        ]);
    });

    it('a pre-132 run of a list renamed since is matched by its items', () => {
        const history = summariseRunHistory(
            [run('legacy', '2026-09-20T00:00:00.000Z', [item('i-bilge', 'Bilge pump', 'Before leaving', 'pass')])],
            ENTRIES,
        );
        expect(history.map((list) => [list.key, list.name])).toEqual([['h-pre', 'Pre-departure']]);
    });

    it('a list deleted since keeps the name it was run under', () => {
        const history = summariseRunHistory(
            [
                run('gone', '2026-09-20T00:00:00.000Z', [
                    item('i-snubber', 'Snubber on', 'Anchoring', 'pass', 'h-anchor'),
                ]),
                run('gone-old', '2026-09-10T00:00:00.000Z', [item('i-snubber', 'Snubber on', 'Anchoring', 'pass')]),
            ],
            ENTRIES,
        );
        expect(history.map((list) => [list.key, list.name])).toEqual([
            ['h-anchor', 'Anchoring'],
            ['name:Anchoring', 'Anchoring'],
        ]);
    });
});

describe('runTally', () => {
    const tally = (passed: number, failed: number, unchecked: number) =>
        runTally({
            id: 'r',
            completed_at: at,
            passed,
            failed: Array.from({ length: failed }, (_, i) => item(`f${i}`, `F${i}`, 'L', 'fail')),
            unchecked,
        });

    it('says all passed only when nothing failed or was left', () => {
        expect(tally(12, 0, 0)).toBe('All 12 passed');
        expect(tally(1, 0, 0)).toBe('Passed');
        expect(tally(11, 1, 0)).toBe('11 passed · 1 failed');
        expect(tally(9, 1, 2)).toBe('9 passed · 1 failed · 2 not checked');
        expect(tally(10, 0, 2)).toBe('10 passed · 2 not checked');
    });
});
