import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
    INVALID_PI_CONFIGURATION_CODE,
    PiConfigurationValidationError,
    operatorEnvironmentLines,
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

test('a config push carries forward operator keys it does not manage', () => {
    // Regression: a push rebuilds .env from the request body, so any key it does
    // not know about is dropped. That silently disabled ENC_WATCHER_ENABLED on
    // 2026-08-30 (chart imports stopped) after the same shape of bug dropped the
    // THALASSA_* flags on 2026-08-11. Carrying one prefix is not enough.
    const dir = mkdtempSync(join(tmpdir(), 'operator-env-'));
    const envPath = join(dir, '.env');
    writeFileSync(
        envPath,
        [
            '# Thalassa Pi Cache — configured by the Thalassa app',
            'PORT=3001',
            'CACHE_DIR=./cache',
            'ENC_WATCHER_ENABLED=true',
            'ENC_CHARTWORLD_DIR=/home/shanes/Charts/chartworld',
            '',
            'DIARY_RELAY_TOKEN=abc123',
        ].join('\n'),
        'utf8',
    );

    const lines = operatorEnvironmentLines(envPath);

    assert.ok(lines.includes('ENC_WATCHER_ENABLED=true'), 'ENC_ flag must survive a config push');
    assert.ok(lines.includes('ENC_CHARTWORLD_DIR=/home/shanes/Charts/chartworld'));
    assert.ok(lines.includes('DIARY_RELAY_TOKEN=abc123'), 'unprefixed operator keys must survive too');

    // Keys the push itself rewrites must not be duplicated back in.
    assert.equal(
        lines.filter((line) => line.startsWith('PORT=') || line.startsWith('CACHE_DIR=')).length,
        0,
    );
    // Comments and blank lines are not settings.
    assert.equal(lines.filter((line) => line.startsWith('#') || line === '').length, 0);
});

test('operator carry-forward reads the file, never the whole process environment', () => {
    // process.env holds PATH, HOME and the rest of the service environment;
    // writing those into .env would be a mess. Only THALASSA_* is taken from it,
    // because a unit file may set those without the file.
    const dir = mkdtempSync(join(tmpdir(), 'operator-env-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'ENC_WATCHER_ENABLED=true\n', 'utf8');

    process.env.THALASSA_PI_LAN_BIND = '1';
    try {
        const lines = operatorEnvironmentLines(envPath);
        assert.ok(lines.includes('THALASSA_PI_LAN_BIND=1'));
        assert.ok(!lines.some((line) => line.startsWith('PATH=') || line.startsWith('HOME=')));
    } finally {
        delete process.env.THALASSA_PI_LAN_BIND;
    }
});

test('operator carry-forward tolerates a missing .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'operator-env-'));
    assert.deepEqual(operatorEnvironmentLines(join(dir, 'no-such.env')), []);
});
