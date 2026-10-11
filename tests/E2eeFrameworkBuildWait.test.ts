// @vitest-environment node
/** Source controls only. No framework compilation or elapsed-time simulation. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync('experiments/scuttlebutt-e2ee/bridge-native/buildLocalUiFrameworks.mjs', 'utf8');
describe('owned framework build shared waiting controls', () => {
    it('records a bounded cumulative budget and refuses dispatch at exhaustion', () => {
        expect(source).toContain('sharedSlotWaitMs: 0');
        expect(source).toContain('sharedSlotWaitBudgetMs: 120000');
        const guard = source.indexOf('if (receipt.sharedSlotWaitMs >= receipt.sharedSlotWaitBudgetMs)'),
            dispatch = source.indexOf("receipt.status = 'building'");
        expect(guard).toBeGreaterThan(0);
        expect(dispatch).toBeGreaterThan(guard);
        expect(source).not.toContain('Date.now() + 600000');
    });
    it('retains actual wait including overshoot and persists before the next poll', () => {
        expect(source).toContain(
            'await delay(Math.min(5000, receipt.sharedSlotWaitBudgetMs - receipt.sharedSlotWaitMs))',
        );
        expect(source).toContain('receipt.sharedSlotWaitMs += Date.now() - started;');
        expect(source).toMatch(/receipt\.sharedSlotWaitMs \+= Date\.now\(\) - started;\s+save\(\);/);
    });
    it('parses PID records without reporting raw command lines and preserves queued state', () => {
        expect(source).toContain('/^\\d+\\s/.test(s)');
        expect(source).toContain("if (receipt.status !== 'queued-unrun') receipt.status = 'failed';");
        expect(source).not.toMatch(/console\.(?:log|info|error)\([^;]*p\.stdout/);
    });
});
