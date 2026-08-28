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
 * pi - is that correct??" — and it is NOT. EncCellStore writes one GeoJSON
 * per cell to Directory.Data/enc-cells on the DEVICE. The Pi has GDAL and the
 * phone does not, so it converts on import and can hold spares; it is a
 * translator, not the place the charts live. That is why his setup works with
 * the Pi ashore on the bench and the gateway on the yacht.
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
        expect(src).toContain("${cells.length} chart${cells.length === 1 ? '' : 's'} on this phone");
        expect(src).toContain("(piHasMoreThanLocal ? ` · ${missingOnDevice.length} more on the Pi` : '')");
    });

    it('says the charts are on the phone, not on the Pi', () => {
        expect(src).toContain('on this phone');
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
    it('tells the skipper their charts survive the Pi being off', () => {
        // His Pi is on the bench at home and the gateway is on the yacht. A
        // skipper in that position should not have to wonder whether their
        // charts went with it.
        expect(src).toContain('keep working with the Pi switched off');
        expect(src).toContain('only used to convert a cell when you import one');
    });

    it('and that claim is true — the cells are written to the device', () => {
        // Not a wording test: if this ever moves to the Pi, the sentence
        // above becomes a lie and this fails with it.
        expect(store).toContain('Directory.Data');
        expect(store).toContain('enc-cells');
        expect(store).toContain("import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';");
    });
});
