import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { CourseOwnershipFile } from './courseOwnership.js';
import type { OwnedCourse } from './courseWriter.js';
const claim: OwnedCourse = {
    device: 'device-a',
    routeKey: 'route-a',
    digest: 'a'.repeat(64),
    resourceId: '11111111-1111-4111-8111-111111111111',
    startTime: null,
    phase: 'activating',
};
function fixture(work: (directory: string) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-course-store-'));
    try {
        work(root);
    } finally {
        assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'thalassa-course-store-'));
        fs.rmSync(root, { recursive: true, force: true });
    }
}
test('an uncertain ownership receipt survives a real file reopen and can be replaced atomically', () =>
    fixture((root) => {
        const store = new CourseOwnershipFile(root, 'pi-a');
        assert.deepEqual(store.read(), []);
        store.write([claim]);
        assert.deepEqual(new CourseOwnershipFile(root, 'pi-a').read(), [claim]);
        const active = { ...claim, phase: 'active' as const, startTime: '2026-10-16T11:00:00Z' };
        store.write([active]);
        assert.deepEqual(store.read(), [active]);
        assert.equal(fs.readdirSync(root).length, 1);
        if (process.platform !== 'win32')
            assert.equal(fs.statSync(path.join(root, 'course-ownership-v1.json')).mode & 0o777, 0o600);
    }));
test('another Pi, corrupt receipt and oversized receipt refuse overwrites', () =>
    fixture((root) => {
        const store = new CourseOwnershipFile(root, 'pi-a');
        store.write([claim]);
        assert.throws(() => new CourseOwnershipFile(root, 'pi-b').write([]), /identity/);
        const file = path.join(root, 'course-ownership-v1.json');
        fs.writeFileSync(file, 'broken');
        assert.throws(() => store.write([]));
        assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
        fs.writeFileSync(file, 'x'.repeat(16_385));
        assert.throws(() => store.read(), /storage/);
    }));
test('duplicate or excessive ownership claims cannot grow or replace the existing ledger', () =>
    fixture((root) => {
        const store = new CourseOwnershipFile(root, 'pi-a');
        store.write([claim]);
        assert.throws(() => store.write([claim, claim]), /Invalid/);
        assert.deepEqual(store.read(), [claim]);
        assert.throws(() => store.write(Array.from({ length: 9 }, () => claim)), /Invalid/);
    }));
