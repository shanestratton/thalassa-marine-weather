import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateMaintenanceActive, updateMaintenancePath, updateMaintenanceStatus } from './updateMaintenance.js';
test('maintenance presence fails closed, including malformed/stale sentinel contents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-maintenance-test-'));
    try {
        assert.equal(updateMaintenanceActive(root), false);
        fs.writeFileSync(updateMaintenancePath(root), 'corrupt or stale');
        assert.equal(updateMaintenanceActive(root), true);
        const snapshot = updateMaintenanceStatus(root, { running: false, sessionExpiresAt: null });
        assert.deepEqual(Object.keys(snapshot).sort(), [
            'anchorRunning',
            'maintenance',
            'observedAt',
            'sessionExpiresAt',
            'version',
        ]);
        assert.equal(snapshot.maintenance, true);
        assert.equal(snapshot.version, 1);
    } finally {
        const relative = path.relative(os.tmpdir(), root);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
test('staged update checksum, source-boundary and lease-gate regressions pass without a real Pi', () => {
    execFileSync(process.execPath, ['--test', fileURLToPath(new URL('../scripts/update5.test.mjs', import.meta.url))], {
        stdio: 'pipe',
    });
});
