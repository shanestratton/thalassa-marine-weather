import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('production ENC demo bootstrap contract', () => {
    it('requires an explicit non-production demo flag before the bundled NOAA sample can import', () => {
        const bootstrap = read('services/enc/bootstrapEncSamples.ts');
        const inventoryHook = read('components/map/useEncChartInventory.ts');

        expect(bootstrap).toContain('VITE_ENABLE_ENC_DEMO_SAMPLES');
        expect(bootstrap).toMatch(
            /explicit\s*&&\s*\(import\.meta\.env\?\.DEV === true \|\| mode === 'test' \|\| mode === 'demo'\)/,
        );
        expect(bootstrap).toContain("importCell(blob, { usage: 'demo' })");
        expect(inventoryHook).toContain('if (isEncDemoSampleOptedIn()) void bootstrapEncSamplesIfNeeded()');
    });

    it('excludes tagged and legacy auto-seeded demos from live metadata consumers', () => {
        const metadata = read('services/enc/EncCellMetadata.ts');

        expect(metadata).toContain("if (cell.usage === 'demo') return false");
        expect(metadata).toContain("LEGACY_BUNDLED_DEMO_CELL_IDS = new Set(['US5GA22M'])");
        expect(metadata).toMatch(/listCells\(\)[\s\S]*?isLiveNavigationCell\(cell\)/);
        expect(metadata).toMatch(/cellsForBBox[\s\S]*?return listCells\(\)\.filter/);
    });
});
