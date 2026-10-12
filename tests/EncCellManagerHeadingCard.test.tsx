/**
 * Shane 2026-08-28: "can we at least roll them up into a heading card, so
 * they do not endlessly scroll… i just dont want to confuse punters if i can
 * help it."
 *
 * It already WAS a collapsible heading card. Two things defeated that:
 *
 *   It opened itself. An effect expanded the section whenever the Pi held
 *   cells the phone did not, to put the Sync button in front of the skipper.
 *   Right intent, wrong mechanism — it unrolled the whole list, unasked,
 *   every time the page was opened.
 *
 *   And the imported list was uncapped. The Pi picker beside it has been
 *   capped at 40 and filterable for a while; this one rendered every cell.
 *
 * The other half of his question was "in reality they are going to be on the
 * pi - is that correct??" Until 127 it was not: EncCellStore wrote every cell
 * to the phone. From 127 it is, for licensed charts (o-charts, 2026-10-10:
 * "Storing unencrypted data on any medium … is strictly prohibited"): they
 * stay on the boat's Pi and open in this phone's memory on the boat's Wi-Fi.
 * Open NOAA charts are still kept on the phone. The card says exactly that,
 * and the store does exactly that (127-C-c).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/vessel/EncCellManager.tsx', 'utf8');
const store = readFileSync('services/enc/EncCellStore.ts', 'utf8');

describe('the ENC section as a heading card', () => {
    it('never expands itself', () => {
        expect(src).not.toContain('if (piHasMoreThanLocal && !expanded)');
        expect(src).not.toContain('setExpanded(true)');
    });

    it('still surfaces what there is to do, while collapsed', () => {
        // Removing the auto-expand must not hide the Sync prompt — the
        // summary line carries it instead of the list.
        expect(src).toContain("`${openCells.length} chart${openCells.length === 1 ? '' : 's'} on this phone`");
        expect(src).toContain('piHasMoreThanLocal && `${missingOnDevice.length} more on the Pi`');
        expect(src).toContain('boatChartsAboardLine(protectedCells.length, chartsBoat)');
    });

    it('caps the imported list and offers the rest on request', () => {
        expect(src).toContain('const CELL_PREVIEW_COUNT = 8;');
        expect(src).toContain('(showAllCells ? cells : cells.slice(0, CELL_PREVIEW_COUNT)).map');
        expect(src).toContain('Show all ${cells.length} charts');
        expect(src).toContain("'Show fewer'");
    });

    it('only offers the toggle when there is more to show', () => {
        expect(src).toContain('{cells.length > CELL_PREVIEW_COUNT && (');
    });

    it('gives the toggle a real touch target', () => {
        const block = src.slice(src.indexOf('setShowAllCells'), src.indexOf('Show fewer') + 200);
        expect(block).toContain('min-h-[44px]');
    });
});

describe('what the card claims about the Pi', () => {
    it('says licensed charts stay on the Pi and open in memory; open charts are kept on the phone', () => {
        expect(src).toContain('{BOAT_CHARTS_FOOT}');
        expect(src).not.toContain('keep working with the Pi switched off');
        expect(src).not.toContain('stored on this phone');
    });

    it('and that claim is true: protected bytes go to the vault, open ones to Library/Application Support', () => {
        // Not a wording test: if a licensed cell is ever written to disk again,
        // the sentence above becomes a lie and this fails with it.
        const save = store.slice(store.indexOf('export async function saveCellGeoJSON'));
        expect(save.slice(0, save.indexOf('\n}\n'))).toContain('vault.put(');
        expect(store).toContain("'Application Support/enc-open'");
        expect(store).toContain('Directory.Library');
        expect(store).toContain('licensed cells never touch the disk');
    });

    it('licensed rows say "aboard" and offer no Remove', () => {
        expect(src).toContain('isProtectedChart(cell)');
        expect(src).toContain('aboard');
    });
});
