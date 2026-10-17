// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
const ROOT = process.cwd();
const script = 'pi-cache/scripts/sync-polar-rule.mjs';
const check = (cwd: string) => spawnSync(process.execPath, [script, '--check'], { cwd, encoding: 'utf8' });
it('the standalone Pi polar rule is exactly the app rule and carries its SHA256', () => {
    const result = check(ROOT);
    expect(result.status, result.stderr).toBe(0);
});
it('a one-character source edit or mirror edit cannot pass the byte/hash guard', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-polar-mirror-'));
    try {
        for (const file of [
            script,
            'utils/polarLearningRule.ts',
            'pi-cache/src/polarLearningRule.ts',
            'pi-cache/src/polarLearningRuleSyncedFrom.ts',
        ]) {
            const target = path.join(scratch, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(ROOT, file), target);
        }
        expect(check(scratch).status).toBe(0);
        for (const file of ['utils/polarLearningRule.ts', 'pi-cache/src/polarLearningRule.ts']) {
            const target = path.join(scratch, file),
                original = fs.readFileSync(target, 'utf8');
            fs.writeFileSync(target, original + '\n');
            expect(check(scratch).status).toBe(1);
            fs.writeFileSync(target, original);
        }
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});
