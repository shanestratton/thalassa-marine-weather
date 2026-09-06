/**
 * Radio Console: one screen, buttons that never move.
 *
 * Shane, 2026-09-06: "the transcript runs off the bottom of the page. when
 * someone is stressed, they may not think to scroll up … the 3 types of calls
 * should be at the bottom of the screen (8px above the menu bar) … it is very
 * important that the three types of call buttons never move" — and "let the
 * punter know what channel they should be on, vhf and hf".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'components/vessel/RadioConsolePage.tsx'), 'utf8');

describe('the Radio Console fits one screen', () => {
    it('the page itself does not scroll; the transcript box does', () => {
        expect(page).toContain('className="w-full h-full flex flex-col bg-slate-950 slide-up-enter overflow-hidden"');
        expect(page).not.toContain('slide-up-enter overflow-y-auto');
        const box = page.slice(page.indexOf('── Transcript — the deliverable'), page.indexOf('── Readouts'));
        expect(box).toContain('flex-1 min-h-[150px]');
        expect(box).toContain('<div className="flex-1 min-h-0 overflow-y-auto">');
        expect(box).toContain('data-testid="dsc-transcript"');
        // One transcript element, whatever the mode — the honesty tests read it by id.
        expect(page.split('data-testid="dsc-transcript"').length - 1).toBe(1);
    });

    it('LAT, LON, SOG, COG and UTC sit directly under the transcript', () => {
        const readouts = page.slice(page.indexOf('── Readouts'), page.indexOf('── Nature of distress'));
        for (const label of ['LAT', 'LON', 'SOG', 'COG', 'UTC'])
            expect(readouts).toMatch(new RegExp(`>\\s*${label}\\s*<`));
    });

    it('the three call buttons are pinned 8 px above the tab bar, outside the scroll region', () => {
        const footer = page.slice(page.indexOf('── Pinned footer'), page.indexOf('// ── DSC sub-components'));
        expect(footer).toContain("paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)'");
        expect(footer).toContain('<ChannelStrip mode={dscMode} />');
        expect(footer).toContain('<DscSelector mode={dscMode} onChange={setDscMode} mobActive={mobActive} />');
        const selector = page.slice(page.indexOf('const DscSelector'), page.indexOf('const NatureSelector'));
        expect(selector).toContain("pill('routine', 'Routine', 'Position'");
        expect(selector).toContain("pill('urgency', 'Urgency', 'Pan-Pan'");
        expect(selector).toContain("pill('distress', 'Distress', 'Mayday'");
        expect(selector).toContain("triggerHaptic(m === 'distress' ? 'heavy' : 'light')");
    });

    it('says which channel, VHF and HF, with the GMDSS distress frequencies', () => {
        const strip = page.slice(page.indexOf('const ChannelStrip'), page.indexOf('const DscSelector'));
        expect(strip).toContain('Call on Ch 16, then shift to a working channel');
        expect(strip).toContain('on Ch 70, then voice on Ch 16');
        expect(strip).toContain('DSC 8414.5 / 6312 / 4207.5 kHz, then voice 8291 / 6215 / 4125 kHz');
        expect(strip).toContain("Your coast station's published working frequency");
    });
});
