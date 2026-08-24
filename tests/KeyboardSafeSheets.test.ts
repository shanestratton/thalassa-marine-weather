/**
 * Bottom sheets must lift themselves above the on-screen keyboard.
 *
 * Shane, 2026-08-13, on Drop a Pin: "i cannot see what i am writing. it is
 * perfect when I share my location. however the keyboard hides what you are
 * writing on the drop a pin." Both sheets live in the same file, which made
 * the cause unusually clear.
 *
 * THE RULE, and it is narrower than "handle the keyboard":
 *
 *   capacitor.config.ts sets KeyboardResize.None, so the iOS keyboard
 *   OVERLAYS the WebView rather than shrinking the layout viewport. `vh`
 *   never shrinks. utils/keyboardScroll.ts compensates app-wide by scrolling
 *   the NEAREST SCROLLING SURFACE to keep the focused field visible — and
 *   that is enough for almost every field in the app.
 *
 *   It is not enough for a bottom-anchored sheet that scrolls INTERNALLY.
 *   There the nearest scrolling surface is the sheet itself, so the guard
 *   scrolls content around inside a box whose bottom is still under the
 *   keyboard. Share my location works precisely because it has no internal
 *   scroll box; Drop a Pin had `max-h-[68vh] overflow-y-auto` and did not.
 *
 * So: internal scroll + bottom anchored ⇒ .thalassa-keyboard-safe-sheet.
 *
 * This test is deliberately a source contract rather than a render test.
 * The failure is geometric and only exists on a real device with a real
 * keyboard — jsdom has no keyboard, no visual viewport and no layout, so a
 * render test would assert nothing about the actual bug.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('keyboard-safe bottom sheets', () => {
    it('the utility exists and is driven by the guard’s published height', () => {
        const css = read('index.css');
        const block = css.slice(css.indexOf('.thalassa-keyboard-safe-sheet'));
        expect(block).toContain('margin-bottom: var(--thalassa-keyboard-height');
        expect(block).toContain('max-height: calc(var(--sheet-max-vh)');
        // Must subtract the keyboard, not merely cap the height — a shorter
        // sheet still anchored to the bottom of the screen is still covered.
        expect(block).toMatch(/max-height:\s*calc\([^)]*-\s*var\(--thalassa-keyboard-height/);
    });

    it('the guard actually publishes that variable', () => {
        // If this ever stops being set, the utility silently degrades to a
        // 0px inset and the bug returns with no visible cause.
        const guard = read('utils/keyboardScroll.ts');
        expect(guard).toContain("setProperty('--thalassa-keyboard-height'");
    });

    it('Drop a Pin pins its fields in a non-scrolling footer', () => {
        // Lifting the sheet is NOT sufficient on its own, and the first
        // attempt proved it: with the fields sitting below a 320px map inside
        // the sheet's own scroller, the margin merely pushed the top of the
        // sheet off screen while the field stayed out of reach (Shane
        // 2026-08-13: "it pushes it all the way off the screen. also you
        // cannot see that box unless you scroll up"). The tall content has to
        // scroll INSIDE while the fields stay pinned below it.
        //
        // Measured in a real browser at 375x812 with a 336px keyboard:
        // sheet margin-bottom 336px, max-height 216px, map 244px -> 130px,
        // and the field's row is the sheet's last child.
        const sheets = read('components/chat/ChatAttachmentSheets.tsx');
        const poi = sheets.slice(
            sheets.indexOf('export const PoiPickerSheet'),
            sheets.indexOf('PoiPickerSheet.displayName'),
        );
        expect(poi).toContain('flex-col');
        expect(poi).toMatch(/min-h-0\s+flex-1\s+overflow-y-auto|flex-1\s+.*min-h-0.*overflow-y-auto/);
        expect(poi).toContain('flex-none');
        // The map must be the shrinkable utility, never a fixed pixel height —
        // it is the only element that can give up space to the keyboard.
        expect(poi).toContain('thalassa-pin-map');
        expect(poi).not.toMatch(/h-\[\d+px\][^"]*rounded-2xl[^"]*overflow-hidden/);
    });

    it('the map shrinks when the keyboard is open', () => {
        const css = read('index.css');
        const block = css.slice(css.indexOf('.thalassa-pin-map'));
        expect(block).toMatch(/\.thalassa-pin-map\s*\{[^}]*height:/);
        expect(block).toContain("data-keyboard-open='true'");
    });

    it('Drop a Pin uses it; Share my location deliberately does not', () => {
        const sheets = read('components/chat/ChatAttachmentSheets.tsx');

        const poi = sheets.slice(
            sheets.indexOf('export const PoiPickerSheet'),
            sheets.indexOf('PoiPickerSheet.displayName'),
        );
        expect(poi).toContain('thalassa-keyboard-safe-sheet');
        // The hard-coded cap must be gone — the utility owns max-height now,
        // and a leftover Tailwind max-h would win the cascade by specificity
        // order and reinstate the bug.
        expect(poi).not.toMatch(/max-h-\[\d+vh\]/);

        const pin = sheets.slice(
            sheets.indexOf('export const PinDropSheet'),
            sheets.indexOf('PinDropSheet.displayName'),
        );
        expect(pin).not.toContain('overflow-y-auto');
    });

    it('no bottom sheet scrolls internally without the utility', () => {
        // The sweep guard. Any element that both scrolls internally and caps
        // itself in vh is bottom-sheet-shaped and needs the class.
        const files = ['components/chat/ChatAttachmentSheets.tsx', 'components/chat/ChatComposer.tsx'];
        for (const file of files) {
            const src = read(file);
            for (const line of src.split('\n')) {
                if (!/overflow-y-auto/.test(line)) continue;
                if (!/max-h-\[\d+vh\]/.test(line)) continue;
                expect
                    .soft(line, `${file}: internally-scrolling vh-capped sheet without the keyboard utility`)
                    .toContain('thalassa-keyboard-safe-sheet');
            }
        }
    });
});
