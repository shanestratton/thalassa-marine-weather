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
 *   keyboard. Inline current-location sharing instead shrinks within the
 *   keyboard-resized ChatPage and scrolls locally; it must not lift twice.
 *
 * So: internal scroll + bottom anchored ⇒ .thalassa-keyboard-safe-sheet.
 *
 * This test is deliberately a source contract rather than a render test.
 * Geometry is also covered by browser-tests/keyboard-layout.spec.ts using
 * real attachment components and a simulated keyboard; jsdom alone cannot
 * prove field visibility.
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

    it('Drop a Pin and current location are CENTRED MODALS, not bottom sheets', () => {
        // SUPERSEDES the earlier expectation that these two lift/shrink inside
        // the chat column. Shane 2026-09-05: "endless problems with the
        // keyboard for the send my location" — so both were portalled out of
        // ChatPage's keyboard-resized flex column entirely, which is the
        // standing rule for this app (centred, clear of the tab bar, scrolling
        // internally). A sheet the keyboard cannot resize cannot be shrunk out
        // from under its own text field.
        //
        // The keyboard-safe utility still governs every OTHER bottom sheet;
        // the sweep below is unchanged apart from exempting dialogs.
        const sheets = read('components/chat/ChatAttachmentSheets.tsx');

        for (const [name, end] of [
            ['export const PoiPickerSheet', 'PoiPickerSheet.displayName'],
            ['export const PinDropSheet', 'PinDropSheet.displayName'],
        ] as const) {
            const body = sheets.slice(sheets.indexOf(name), sheets.indexOf(end));
            expect(body, name).toContain('<OverlayPortal');
            expect(body, name).toContain('role="dialog"');
            expect(body, name).toContain('data-keyboard-focus-scope');
            // No longer bottom-sheet shaped, so the utility does not apply.
            expect(body, name).not.toContain('thalassa-keyboard-safe-sheet');
        }

        // The note/send row still replaces the normal composer while sharing,
        // so two pinned entry bars cannot consume a landscape viewport.
        expect(read('components/ChatPage.tsx')).toContain("view === 'messages' && !showPinSheet && (");
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
                // A CENTRED DIALOG is not bottom-sheet shaped. It is portalled
                // out of the keyboard-resized column, so the keyboard overlays
                // it rather than shrinking it, and the utility does not apply.
                // Without this the guard flags the very fix for the bug it
                // exists to catch.
                if (/rounded-3xl|max-w-(sm|md|lg)/.test(line)) continue;
                expect
                    .soft(line, `${file}: internally-scrolling vh-capped sheet without the keyboard utility`)
                    .toContain('thalassa-keyboard-safe-sheet');
            }
        }
    });
});
