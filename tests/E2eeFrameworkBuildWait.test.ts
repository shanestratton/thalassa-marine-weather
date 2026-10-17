// @vitest-environment node
/** Source controls only. No framework compilation or elapsed-time simulation. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync('experiments/scuttlebutt-e2ee/bridge-native/buildLocalUiFrameworks.mjs', 'utf8');
const helper = readFileSync('experiments/scuttlebutt-e2ee/sharedBuildWait.mjs', 'utf8');
describe('owned framework build shared waiting controls', () => {
    it('records a bounded cumulative budget and refuses dispatch at exhaustion', () => {
        expect(source).toContain('sharedSlotWaitMs: 0');
        expect(source).toContain('sharedSlotWaitBudgetMs: waitArgs.budgetMs');
        expect(source).toContain('parseSharedBuildWaitArgs(process.argv.slice(2))');
        expect(helper).toContain('let budgetMs = 120000;');
        expect(helper).toContain('if (spentMs >= budgetMs)');
        const guard = source.indexOf('await sharedWait.wait();'),
            dispatch = source.indexOf("command('/opt/homebrew/opt/ruby/bin/ruby'");
        expect(guard).toBeGreaterThan(0);
        expect(dispatch).toBeGreaterThan(guard);
        expect(source).not.toContain('Date.now() + 600000');
    });
    it('retains actual wait including overshoot and persists before the next poll', () => {
        expect(helper).toContain('await sleep(Math.min(5000, budgetMs - spentMs))');
        expect(helper).toContain('spentMs += ended - started;');
        expect(helper).toMatch(/finally \{\s+elapsed\(started\);/);
        expect(helper).toMatch(/finally \{\s+elapsed\(beforeSleep\);/);
        expect(source).toMatch(/receipt\.sharedSlotWaitMs = spentMs;[^]*?save\(\);/);
    });
    it('parses PID records without reporting raw command lines and preserves queued state', () => {
        expect(helper).toContain('/^\\d+\\s/.test(line)');
        expect(source).toContain("if (receipt.status !== 'queued-unrun') receipt.status = 'failed';");
        expect(source).not.toMatch(/console\.(?:log|info|error)\([^;]*p\.stdout/);
    });
});
