/** Layout contracts supplement the rendered emergency and real-browser tests. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const page = readFileSync(resolve(process.cwd(), 'components/vessel/RadioConsolePage.tsx'), 'utf8');
const dialogs = readFileSync(resolve(process.cwd(), 'components/vessel/RadioConsoleDialogs.tsx'), 'utf8');

describe('Radio Console full-pane readback', () => {
    it('uses pane-scoped portals and a focus trap with an accessible close button', () => {
        expect(dialogs).toContain('<OverlayPortal');
        expect(dialogs).toContain('usePaneScope()');
        expect(dialogs).toContain('useFocusTrap<HTMLDivElement>');
        expect(dialogs).toContain('onEscape: onClose');
        expect(dialogs).toContain('aria-label={`Close ${title.toLowerCase()}`}');
        expect(dialogs).not.toContain('scope="app"');
    });
    it('fits ordinary scripts without truncating or shrinking below 14px', () => {
        expect(dialogs).toContain('size > 14');
        expect(dialogs).toContain('new ResizeObserver(fit)');
        expect(dialogs).toContain('Long message — scroll within the transcript to read every word.');
        expect(dialogs).toContain('overflow-y-auto overscroll-contain');
        expect(dialogs).not.toMatch(/line-clamp-|text-overflow:|text-ellipsis/);
        expect(dialogs.split('data-testid="dsc-transcript"')).toHaveLength(2);
    });
    it('keeps readouts and pinned call buttons on the base console', () => {
        for (const label of ['LAT', 'LON', 'SOG', 'COG', 'UTC']) expect(page).toMatch(new RegExp(`>\\s*${label}\\s*<`));
        expect(page).toContain("paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)'");
        expect(page).toContain('<DscSelector mode={dscMode} onChange={chooseMode} mobActive={mobActive} />');
        for (const mode of ['routine', 'urgency', 'distress']) expect(page).toContain(`pill('${mode}'`);
    });
    it('keeps channel guidance without a universal hold time or acknowledgement gate', () => {
        expect(page).toContain('Channel 70 is DSC only — never voice.');
        expect(page).toContain('DISTRESS button hold/countdown');
        expect(page).toContain('This app does not transmit or confirm an alert.');
        expect(page).toContain('DSC 8414.5 / 6312 / 4207.5 kHz, then voice 8291 / 6215 / 4125 kHz');
        expect(page).not.toMatch(/for 5 seconds|Wait for acknowledgement/);
    });
});
