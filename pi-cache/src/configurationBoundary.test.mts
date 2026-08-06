import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
    INVALID_PI_CONFIGURATION_CODE,
    PiConfigurationValidationError,
    piEnvironmentLine,
    validatePiConfigurationFields,
    writeEnvironmentFileAtomic,
} from './configurationBoundary.js';

const VALID_USER_ID = 'eb8805ce-2b5e-4ae9-b75d-ccf10acbfcbe';

test('valid configuration fields preserve their typed values', () => {
    assert.deepEqual(
        validatePiConfigurationFields({
            supabaseUrl: 'https://pcisdplnodrphauixcau.supabase.co',
            supabaseAnonKey: 'public-anon-key',
            prefetchLat: -27.2,
            prefetchLon: 153.1,
            prefetchRadius: 5,
            userId: VALID_USER_ID,
        }),
        {
            supabaseUrl: 'https://pcisdplnodrphauixcau.supabase.co',
            supabaseAnonKey: 'public-anon-key',
            prefetchLat: -27.2,
            prefetchLon: 153.1,
            prefetchRadius: 5,
            userId: VALID_USER_ID,
        },
    );
});

test('dotenv newline and control-character injection is rejected', () => {
    for (const value of [
        { userId: `${VALID_USER_ID}\nTHALASSA_PI_LAN_BIND=1` },
        { supabaseAnonKey: 'public-key\nNODE_OPTIONS=--require=/tmp/attack.js' },
        { supabaseUrl: 'https://example.test\rTHALASSA_UNSAFE_ADMIN_API=1' },
        { supabaseAnonKey: 'public-key\u0000suffix' },
        { supabaseAnonKey: 'public-key\u2028INJECTED=1' },
    ]) {
        assert.throws(
            () => validatePiConfigurationFields(value),
            (error: unknown) =>
                error instanceof PiConfigurationValidationError && error.code === INVALID_PI_CONFIGURATION_CODE,
        );
    }
    assert.throws(() => piEnvironmentLine('PREFETCH_USER_ID', `safe\nINJECTED=1`), PiConfigurationValidationError);
});

test('user id, WGS84 coordinates, and prefetch radius are strictly bounded', () => {
    for (const value of [
        { userId: 'not-a-uuid' },
        { prefetchLat: -27.2 },
        { prefetchLon: 153.1 },
        { prefetchLat: 91, prefetchLon: 153.1 },
        { prefetchLat: -27.2, prefetchLon: 181 },
        { prefetchLat: '-27.2', prefetchLon: 153.1 },
        { prefetchLat: -27.2, prefetchLon: 153.1, prefetchRadius: 0 },
        { prefetchLat: -27.2, prefetchLon: 153.1, prefetchRadius: 31 },
        { prefetchRadius: 5 },
    ]) {
        assert.throws(
            () => validatePiConfigurationFields(value),
            PiConfigurationValidationError,
            JSON.stringify(value),
        );
    }
});

test('atomic environment replacement preserves mode and complete contents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-config-boundary-'));
    const filePath = join(directory, '.env');
    writeFileSync(filePath, 'OLD=1\n', { mode: 0o640 });
    chmodSync(filePath, 0o640);

    writeEnvironmentFileAtomic(filePath, 'PORT=3001\nCACHE_DIR=./cache\n');

    assert.equal(readFileSync(filePath, 'utf8'), 'PORT=3001\nCACHE_DIR=./cache\n');
    assert.equal(lstatSync(filePath).mode & 0o777, 0o640);
});

test('atomic environment replacement refuses symlinks without touching their target', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-config-symlink-'));
    const targetPath = join(directory, 'target');
    const filePath = join(directory, '.env');
    writeFileSync(targetPath, 'UNCHANGED=1\n');
    symlinkSync(targetPath, filePath);

    assert.throws(() => writeEnvironmentFileAtomic(filePath, 'ATTACKED=1\n'), /non-regular/);
    assert.equal(readFileSync(targetPath, 'utf8'), 'UNCHANGED=1\n');
    assert.equal(lstatSync(filePath).isSymbolicLink(), true);
});
