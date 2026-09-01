// @vitest-environment node
/**
 * THE CENTRED-MODAL RATCHET (Shane, 2026-09-02: "ensure that all modal
 * boxes are centered on the punters screen … across the board").
 *
 * History: bottom-anchored sheets repeatedly slid their buttons under the
 * tab bar or off-screen (the Two-positions card, the VideoTrimmer, then a
 * 25-strong census conviction list, all converted 2026-09-02). The law:
 * a modal overlay is `fixed inset-0 flex items-center justify-center` with
 * overlay padding clearing the tab bar and internal card scroll.
 *
 * This ratchet scans every component for an `items-end`/`justify-end` in
 * the textual neighbourhood of a modal marker (`fixed inset-0`,
 * `aria-modal`, `role="dialog"`). Every hit must be on the explicit
 * exception list. Adding a new bottom-anchored modal fails this test —
 * as it should.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const EXCEPTIONS = new Set<string>([
    // Night-watch dim scrim: full-screen, aria-hidden, tap-to-wake — a
    // utility veil, not a modal box (census 2026-09-02: exception).
    'components/ScreenDimOverlay.tsx',
]);

function tsxFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const stats = statSync(path);
        if (stats.isDirectory()) out.push(...tsxFiles(path));
        else if (name.endsWith('.tsx')) out.push(path);
    }
    return out;
}

describe('centred-modal ratchet', () => {
    it('no modal-class overlay anchors to an edge', () => {
        const offenders: string[] = [];
        for (const file of [...tsxFiles('components'), ...tsxFiles('src')]) {
            if (EXCEPTIONS.has(file.replace(/\\/g, '/'))) continue;
            const text = readFileSync(file, 'utf8');
            for (const match of text.matchAll(/items-end|justify-end(?!-)/g)) {
                const at = match.index ?? 0;
                const ctx = text.slice(Math.max(0, at - 400), at + 200);
                if (ctx.includes('fixed inset-0') || ctx.includes('aria-modal') || ctx.includes('role="dialog"')) {
                    offenders.push(`${file}:${text.slice(0, at).split('\n').length}`);
                }
            }
        }
        expect(
            offenders,
            `Bottom/edge-anchored modal(s) found. Centre them per the standing rule ` +
                `(fixed inset-0 flex items-center justify-center, tab-bar-clearing padding, ` +
                `max-h-full overflow-y-auto card) or, for a genuine non-modal exception, ` +
                `add the file to EXCEPTIONS with a reason.`,
        ).toEqual([]);
    });
});
