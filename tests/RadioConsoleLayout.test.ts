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
    it('fits ordinary scripts without truncating or going below the readable floor', () => {
        expect(dialogs).toContain('const minimum = Math.max(16, rootSize)');
        expect(dialogs).toContain('const maximum = Math.max(minimum, rootSize * 1.25)');
        expect(dialogs).toContain('new ResizeObserver(measure)');
        expect(dialogs).toContain('Scroll to continue');
        expect(dialogs).toContain('aria-label="Call script"');
        expect(dialogs).toContain('tabIndex={0}');
        expect(dialogs).toContain('overflow-y-auto overscroll-contain');
        expect(dialogs).not.toMatch(/line-clamp-|text-overflow:|text-ellipsis/);
        expect(dialogs.split('data-testid="dsc-transcript"')).toHaveLength(2);
    });
    it('keeps call choices pinned in preparation and one tap away during full-screen readback', () => {
        for (const label of ['LAT', 'LON', 'SOG', 'COG', 'UTC']) expect(page).toMatch(new RegExp(`>\\s*${label}\\s*<`));
        expect(page).toContain("paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)'");
        expect(page).toContain('<DscSelector mode={dscMode} onChange={chooseMode} mobActive={mobActive} />');
        expect(page.indexOf('ref={selectorRef}')).toBeLessThan(page.indexOf('Vessel identity strip'));
        expect(page).toContain('aria-hidden={dialogStep !== null}');
        expect(page.match(/selectorAnchor={selectorAnchor}/g)).toHaveLength(2);
        expect(dialogs.indexOf('{selectors}')).toBeLessThan(dialogs.indexOf('{children}'));
        expect(dialogs).toContain('compactReadback');
        expect(dialogs).toContain('aria-expanded={showCallTypes}');
        expect(dialogs).toContain("'Change call'");
        expect(dialogs).not.toContain('top: dialogTop');
        expect(dialogs).toContain("paddingTop: pane ? '8px' : 'max(8px, env(safe-area-inset-top))'");
        for (const mode of ['routine', 'urgency', 'distress']) expect(page).toContain(`pill('${mode}'`);
    });
    it('keeps channel guidance without a universal hold time or acknowledgement gate', () => {
        expect(page).toContain('Ch 70: DSC only, never voice.');
        expect(page).toContain('DISTRESS button hold/countdown');
        expect(page).toContain('This app does not transmit.');
        expect(page).toContain('This app cannot confirm an alert was sent.');
        expect(page).toContain('DSC 8414.5 / 6312 / 4207.5 kHz, then voice 8291 / 6215 / 4125 kHz');
        expect(page).not.toMatch(/for 5 seconds|Wait for acknowledgement/);
    });
});
