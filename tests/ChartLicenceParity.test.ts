// @vitest-environment node
/**
 * One licence rule on both sides of the boat LAN (127-C-b, C7). The Pi stamps
 * `licence` on its chart index (pi-cache/src/chartLicence.ts) and the phone
 * classifies every cell itself (services/enc/chartLicence.ts); pi-cache cannot
 * import app services, so the rule lives twice and this pins the two copies to
 * the same NOAA pattern and the same answers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPEN_CHART_ID, chartLicenceOf } from '../services/enc/chartLicence';
import { NOAA_OPEN_CHART_ID, piChartLicence } from '../pi-cache/src/chartLicence';

const ROOT = join(__dirname, '..');
const literal = (file: string, name: string): string => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const match = new RegExp(`export const ${name} = (/[^\\n]+/);`).exec(source);
    if (!match) throw new Error(`${file}: ${name} is not a regex literal`);
    return match[1];
};

describe('the Pi and the phone classify charts alike', () => {
    it('declare the same NOAA id pattern, as written', () => {
        expect(literal('pi-cache/src/chartLicence.ts', 'NOAA_OPEN_CHART_ID')).toBe(
            literal('services/enc/chartLicence.ts', 'OPEN_CHART_ID'),
        );
        expect(NOAA_OPEN_CHART_ID.source).toBe(OPEN_CHART_ID.source);
    });

    it('give the same answer for every source and id', () => {
        const ids = [
            'US5XX01M',
            'us5xx01m',
            'US1ZZ999',
            'OC-99-ZZTEST',
            'ZZ5TEST1',
            'FR466870',
            'USX12345',
            'US5XX01MZ',
        ];
        for (const cellId of ids) {
            for (const sourceHO of ['US', 'FR', 'ZZ']) {
                for (const source of ['url', 'phone-upload'] as const) {
                    expect(piChartLicence({ cellId, sourceHO, source }), `${cellId} ${sourceHO} ${source}`).toBe(
                        chartLicenceOf({ id: cellId, sourceHO }),
                    );
                }
                // The Pi's own decrypts (o-charts, S-63) are protected whatever the id says.
                for (const source of ['pi-decrypt', 's63'] as const)
                    expect(piChartLicence({ cellId, sourceHO, source })).toBe('protected');
                expect(piChartLicence({ cellId, sourceHO, source: 'url', licence: 'protected' })).toBe('protected');
            }
        }
    });
});
