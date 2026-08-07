import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encCellSyncKey } from '../services/EncImportService';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const codeOf = (relative: string): string =>
    read(relative)
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The UI's "do I already have this chart?" must be the SERVICE's answer.
 *
 * The ENC sheet keyed on `cellId@edition` while syncEncFromPi keyed on
 * `cellId@edition@sizeBytes`. The two agree until our extractor improves: a
 * re-extracted cell keeps its id and its S-57 edition and changes only its
 * bytes. The service would happily re-fetch it; the sheet said "Pi charts
 * already in sync", hid the Sync button, and hid the per-chart picker with it
 * (both gate on the same flag). Shane 2026-08-07 — the fixed Noumea and Port
 * Vila charts sat on a reachable Pi with no way to pull them.
 *
 * Two independent definitions of one identity is the defect. These tests pin
 * that there is only one.
 */
describe('ENC sync-key agreement', () => {
    it('treats a re-extracted cell as needing sync', () => {
        // Same id, same chart edition, different bytes — the exact shape of an
        // extractor improvement.
        const before = encCellSyncKey('FR466870', 6, 15_460_883);
        const after = encCellSyncKey('FR466870', 6, 9_120_004);
        expect(after).not.toBe(before);
    });

    it('treats an unchanged cell as already held', () => {
        expect(encCellSyncKey('FR466870', 6, 15_460_883)).toBe(encCellSyncKey('FR466870', 6, 15_460_883));
    });

    it('still catches a genuine edition bump', () => {
        expect(encCellSyncKey('GB501494', 11, 100)).not.toBe(encCellSyncKey('GB501494', 12, 100));
    });

    it('re-imports a legacy cell once rather than pinning it forever', () => {
        // Cells written before sizeBytes existed carry undefined. That must be
        // its own value, not a wildcard that matches any size.
        expect(encCellSyncKey('AU5PTL01', 3, undefined)).not.toBe(encCellSyncKey('AU5PTL01', 3, 500));
        expect(encCellSyncKey('AU5PTL01', 3, undefined)).toBe(encCellSyncKey('AU5PTL01', 3, undefined));
    });

    it('is case-insensitive on the cell id, like the storage identity', () => {
        // Apple filesystems are case-insensitive; `au...` and `AU...` address
        // one physical blob and must not read as two charts.
        expect(encCellSyncKey('fr466870', 6, 100)).toBe(encCellSyncKey('FR466870', 6, 100));
    });

    it('leaves the ENC sheet no second definition of its own', () => {
        // A local re-derivation is how these drifted apart the first time.
        const ui = codeOf('components/vessel/EncCellManager.tsx');
        expect(ui).toContain('encCellSyncKey(');
        expect(ui, 'UI re-derives the sync identity instead of sharing it').not.toMatch(
            /`\$\{c(ell)?Id\}@\$\{edition\}`|`\$\{c\.id\}@\$\{c\.edition \?\? 0\}`/,
        );
    });

    it('keeps the service using the shared key too', () => {
        const service = codeOf('services/EncImportService.ts');
        const sync = service.slice(service.indexOf('export async function syncEncFromPi'));
        expect(sync).toContain('encCellSyncKey(c.id, c.edition, c.sizeBytes)');
    });
});
