import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "We could not load this" must never be rendered as "there is nothing here".
 *
 * Five Ship's Office pages collapsed a failed fetch into their empty state: the
 * request threw, a toast flashed for a few seconds, and what stayed on screen
 * was an illustration reading "No safety equipment logged" — in the calm,
 * illustrated voice of a legitimately empty list. On a boat that is a genuine
 * hazard: it tells the skipper their flares, liferaft and maintenance records
 * are absent when in fact they merely could not be fetched. Pull-to-refresh is
 * disabled on exactly these views, so the toast was the only signal, and it
 * expired.
 *
 * Each page must therefore have three distinguishable states — loading, load
 * FAILED (with a retry), and genuinely empty. This test pins that shape rather
 * than any particular wording.
 */

const PAGES = [
    { file: 'components/vessel/InventoryList.tsx', loader: 'loadItems' },
    { file: 'components/vessel/ChecklistsPage.tsx', loader: 'loadEntries' },
    { file: 'components/vessel/EquipmentList.tsx', loader: 'loadItems' },
    { file: 'components/vessel/MaintenanceHub.tsx', loader: 'loadTasks' },
    { file: 'components/vessel/DocumentsHub.tsx', loader: 'loadDocs' },
];

describe.each(PAGES)('$file distinguishes a failed load from an empty list', ({ file, loader }) => {
    const src = readFileSync(resolve(process.cwd(), file), 'utf8');

    it('tracks the failure separately from emptiness', () => {
        expect(src).toContain('const [loadError, setLoadError]');
        expect(src).toContain('setLoadError(true)');
        // Cleared when a load begins, or the error state would be sticky and a
        // successful retry would still read as broken.
        expect(src).toContain('setLoadError(false)');
    });

    it('renders the error state BEFORE falling through to the empty state', () => {
        const errorBranch = src.indexOf('loadError ? (');
        const emptyBranch = src.indexOf('length === 0 ? (');
        expect(errorBranch, 'no loadError branch found').toBeGreaterThan(-1);
        expect(emptyBranch, 'no empty branch found').toBeGreaterThan(-1);
        expect(errorBranch).toBeLessThan(emptyBranch);
    });

    it('offers a retry wired to the real loader', () => {
        expect(src).toContain('<LoadErrorState');
        expect(src).toMatch(new RegExp(`onRetry=\\{${loader}\\}`));
    });
});

describe('the shared error state stays honest', () => {
    const src = readFileSync(resolve(process.cwd(), 'components/ui/LoadErrorState.tsx'), 'utf8');

    it('says the records still exist, and offers a way to try again', () => {
        // The whole point is that the skipper does not read this as "empty".
        expect(src).toContain('not an empty list');
        expect(src).toContain('actionLabel="Try again"');
        expect(src).toContain('onAction={onRetry}');
    });
});
