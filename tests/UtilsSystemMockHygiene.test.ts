// @vitest-environment node
/**
 * utils/system is called at MODULE INIT by stores/settingsStore.ts
 * (getSystemUnits for the default unit preferences). A test that mocks
 * '../utils/system' with a bare factory erases getSystemUnits for every
 * module in its graph — including chains reached by fire-and-forget
 * dynamic imports — and detonates as an unhandled rejection ONLY in slow
 * (coverage) runs, which is how CI went red on 2026-09-01 while the
 * plain local suite stayed green. 57 mocks were converted that night.
 *
 * The rule this pins: a vi.mock of '../utils/system' must either spread
 * importOriginal or explicitly provide getSystemUnits.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function testFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) out.push(...testFiles(path));
        else if (/\.test\.tsx?$/.test(name)) out.push(path);
    }
    return out;
}

describe('utils/system mock hygiene', () => {
    it('every utils/system mock keeps getSystemUnits alive', () => {
        const offenders: string[] = [];
        for (const file of testFiles('tests')) {
            const text = readFileSync(file, 'utf8');
            for (const m of text.matchAll(/vi\.mock\('\.\.\/utils\/system'[\s\S]{0,600}?\}\);/g)) {
                const call = m[0];
                if (!call.includes('importOriginal') && !call.includes('getSystemUnits')) {
                    offenders.push(`${file}:${text.slice(0, m.index ?? 0).split('\n').length}`);
                }
            }
        }
        expect(
            offenders,
            'Bare utils/system mock found — spread importOriginal or stub getSystemUnits explicitly.',
        ).toEqual([]);
    });
});
