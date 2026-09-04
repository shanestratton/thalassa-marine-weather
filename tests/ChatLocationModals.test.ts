/**
 * Share-location and Drop-a-pin are centred modals, not inline sheets.
 *
 * Shane 2026-09-05: "endless problems with the keyboard for the send my
 * location". Both lived as <section> elements INSIDE ChatPage's flex column —
 * the column the keyboard guard resizes. So raising the keyboard to type a
 * caption shrank the very sheet holding the caption field, taking the input it
 * was trying to reveal down with it.
 *
 * The pin sheet was worse: it scrolled internally, which index.css names as
 * exactly the case the app-wide keyboard guard cannot rescue.
 *
 * Portalled and centred, neither is in that column any more. Nothing resizes
 * them, the keyboard simply overlays, and they follow the standing rule this
 * project already applies everywhere else: centred, clear of the tab bar,
 * scrolling internally.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync('components/chat/ChatAttachmentSheets.tsx', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function shell(label: string): string {
    const at = code.indexOf(`aria-label="${label}"`);
    expect(at, `${label} not found`).toBeGreaterThan(-1);
    // The shell is the portal + dialog wrapper just above the label.
    return code.slice(Math.max(0, at - 700), at + 400);
}

describe('the chat location surfaces', () => {
    for (const label of ['Share my current location', 'Drop a pin']) {
        it(`${label} is portalled and centred`, () => {
            const s = shell(label);
            expect(s).toMatch(/<OverlayPortal className="flex items-center justify-center p-4"/);
            expect(s).toMatch(/role="dialog"/);
            expect(s).toMatch(/aria-modal="true"/);
        });

        it(`${label} caps its height and scrolls inside itself`, () => {
            const s = shell(label);
            expect(s).toMatch(/max-h-\[80vh\]/);
            expect(s).toMatch(/overflow-y-auto overscroll-contain/);
        });

        it(`${label} is no longer a bottom sheet in the resized column`, () => {
            const s = shell(label);
            // The tell-tales of the old inline sheets.
            expect(s).not.toMatch(/border-t border-(emerald|sky)-400\/\[0\.14\]/);
            expect(s).not.toMatch(/thalassa-keyboard-safe-sheet/);
        });
    }

    it('a tap inside does not close the modal', () => {
        // The backdrop closes; the panel must not, or typing a caption near
        // the edge would dismiss the sheet mid-sentence.
        expect(code).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
    });
});
