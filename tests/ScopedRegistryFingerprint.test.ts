/**
 * Route-scoped chart-library fingerprint — Shane 2026-08-26:
 * "Your ENC chart library has changed since this route was checked" on
 * EVERY Cast Off attempt, immediately after every recheck.
 *
 * Root cause: the verification fingerprinted the WHOLE library, so his Pi
 * and cloud sync importing Mackay-area cells invalidated a Newport→Coral
 * Sea route check the moment they landed — charts hundreds of miles from
 * the route. The fingerprint is now scoped to cells intersecting the
 * route's padded bbox; writer (route check) and checker (Cast Off) derive
 * the scope from the same points with the same pad.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clearAllCellMetadata, getRegistryFingerprint, putCell } from '../services/enc/EncCellMetadata';
import { traceCastOffBlockReason, traceRegistryScope } from '../services/traceVerification';
import type { EncCell } from '../services/enc/types';

const cell = (over: Partial<EncCell> = {}): EncCell => ({
    id: 'AU5MB01P',
    sourceHO: 'AHO',
    edition: 3,
    issued: '2026-01-15',
    importedAt: '2026-08-01T00:00:00.000Z',
    bbox: [153.0, -27.5, 153.5, -27.0],
    geojsonPath: 'enc/AU5MB01P.json',
    hazardCount: 12,
    usage: 'navigation',
    ...over,
});

// Newport → Coral Sea, roughly Shane's passage.
const ROUTE = [
    { lat: -27.2, lon: 153.09 },
    { lat: -23.9, lon: 152.4 },
];

beforeEach(() => {
    localStorage.clear();
    clearAllCellMetadata();
});

describe('traceRegistryScope', () => {
    it('is the route extent plus the corridor pad, clamped to the poles', () => {
        const scope = traceRegistryScope(ROUTE);
        expect(scope).toEqual([152.4 - 0.5, -27.2 - 0.5, 153.09 + 0.5, -23.9 + 0.5]);
        expect(traceRegistryScope([])).toBeUndefined();
        expect(traceRegistryScope(undefined)).toBeUndefined();
    });
});

describe('scoped registry fingerprint', () => {
    it('a cell far from the route (the Mackay sync) does NOT move the scoped fingerprint', () => {
        putCell(cell()); // on-route cell, Moreton Bay
        const scope = traceRegistryScope(ROUTE);
        const before = getRegistryFingerprint(scope);

        // Pi/cloud sync lands a Mackay cell, hundreds of miles away.
        putCell(cell({ id: 'AU5MKY01', bbox: [149.0, -21.4, 149.5, -20.9] }));

        expect(getRegistryFingerprint(scope)).toBe(before);
        // The FULL-library fingerprint does move — that was the old blocker.
        expect(getRegistryFingerprint()).not.toBe(before);
    });

    it('a change to a cell UNDER the route still invalidates', () => {
        putCell(cell());
        const scope = traceRegistryScope(ROUTE);
        const before = getRegistryFingerprint(scope);

        putCell(cell({ edition: 4 }));

        expect(getRegistryFingerprint(scope)).not.toBe(before);
    });

    it('a manifest re-publication (cloudManifestVersion bump, same chart) does NOT move it', () => {
        // cloudCellSync re-stamps EVERY cloud cell on each manifest
        // publication — a delivery artefact, not a chart change. Including
        // it made the recheck loop survive the route-scoped fix.
        putCell(cell({ cloudManifestVersion: 3 }));
        const scope = traceRegistryScope(ROUTE);
        const before = getRegistryFingerprint(scope);

        putCell(cell({ cloudManifestVersion: 4 }));

        expect(getRegistryFingerprint(scope)).toBe(before);
        expect(getRegistryFingerprint()).toBe(getRegistryFingerprint()); // stable full-library too
    });

    it('a new cell arriving INSIDE the corridor invalidates — coverage genuinely changed', () => {
        putCell(cell());
        const scope = traceRegistryScope(ROUTE);
        const before = getRegistryFingerprint(scope);

        putCell(cell({ id: 'AU5NEW01', bbox: [152.5, -25.5, 153.0, -25.0] }));

        expect(getRegistryFingerprint(scope)).not.toBe(before);
    });
});

describe('writer and checker share the scope (source tripwires)', () => {
    const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

    it('every blocking-path fingerprint call is route-scoped', () => {
        const recheck = read('services/traceRecheck.ts');
        expect(recheck.match(/getRegistryFingerprint\(traceRegistryScope\(points\)\)/g)?.length).toBe(3);
        expect(read('services/VoyageService.ts')).toContain('getRegistryFingerprint(traceRegistryScope(points))');
        expect(read('components/map/MapHub.tsx')).toContain(
            'getEncRegistryFingerprint(traceRegistryScope(capturedCoords))',
        );
    });

    it('no blocking-path caller is left on the full-library fingerprint', () => {
        for (const rel of ['services/traceRecheck.ts', 'services/VoyageService.ts']) {
            expect(read(rel)).not.toMatch(/getRegistryFingerprint\(\)/);
        }
    });
});

describe('the block message diagnoses itself', () => {
    const context = {
        draftM: 2.0,
        draftAssumed: false,
        voyageDepartureMs: Date.parse('2026-08-27T00:00:00Z'),
        nowMs: Date.parse('2026-08-26T00:00:00Z'),
    };
    const verification = (fingerprint: string) => ({
        version: 1,
        graderVersion: 'route-tracer-v1',
        geometryKey: 'any-key',
        checkedAt: '2026-08-25T23:00:00Z',
        result: 'verified',
        legGrades: [],
        acknowledgedDangerLegs: [],
        draftM: 2.0,
        draftAssumed: false,
        encRegistryVersion: 1,
        encRegistryFingerprint: fingerprint,
        departureMs: Date.parse('2026-08-27T00:00:00Z'),
        tideWindowLabel: '',
    });

    it('an old-format stamp names the real cause: checked by an older app version', () => {
        const reason = traceCastOffBlockReason(verification('AU5MB01P@3@2026-01-15@100@cloud-7'), undefined, {
            ...context,
            encRegistryFingerprint: 'AU5MB01P@3@2026-01-15@100',
        });
        expect(reason).toContain('older app version');
    });

    it('a genuine chart change names the differing cell', () => {
        const reason = traceCastOffBlockReason(verification('AU5MB01P@3@2026-01-15@100'), undefined, {
            ...context,
            encRegistryFingerprint: 'AU5MB01P@4@2026-06-01@120',
        });
        expect(reason).toContain('AU5MB01P');
        expect(reason).toContain('Recheck');
    });
});

describe('the departure gate bites only tide-gated checks', () => {
    const base = {
        draftM: 2.0,
        draftAssumed: false,
        encRegistryFingerprint: 'AU5MB01P@3@2026-01-15@100',
        nowMs: Date.parse('2026-08-26T00:00:00Z'),
    };
    const checked = (over: Record<string, unknown> = {}) => ({
        version: 1,
        graderVersion: 'route-tracer-v1',
        geometryKey: 'any-key',
        checkedAt: '2026-08-25T23:00:00Z',
        result: 'verified',
        legGrades: [],
        acknowledgedDangerLegs: [],
        draftM: 2.0,
        draftAssumed: false,
        encRegistryVersion: 1,
        encRegistryFingerprint: 'AU5MB01P@3@2026-01-15@100',
        departureMs: Date.parse('2026-08-26T08:00:00Z'),
        tideWindowLabel: '',
        ...over,
    });

    it('a NON-tide route ignores departure drift entirely — checked at dawn, valid at dusk', () => {
        const reason = traceCastOffBlockReason(checked(), undefined, {
            ...base,
            voyageDepartureMs: Date.parse('2026-08-26T18:00:00Z'), // 10h drift
        });
        expect(reason).toBeNull();
        // Even a voyage with no departure_time at all.
        expect(traceCastOffBlockReason(checked(), undefined, { ...base, voyageDepartureMs: null })).toBeNull();
    });

    it('a TIDE-gated check still demands the plan it verified — 3h drift blocks, 10min passes', () => {
        const tideGated = (departure: string) =>
            traceCastOffBlockReason(checked({ tideWindowLabel: 'HW 09:12 · window 07:40–10:45' }), undefined, {
                ...base,
                nowMs: Date.parse('2026-08-26T07:50:00Z'),
                voyageDepartureMs: Date.parse(departure),
            });
        expect(tideGated('2026-08-26T11:00:00Z')).toContain('planned departure changed');
        expect(tideGated('2026-08-26T08:10:00Z')).toBeNull();
    });
});

describe('rechecks re-verify THE PLAN (source tripwires)', () => {
    it('a recheck inherits the prior departure instead of stamping now', () => {
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        const { resolve } = require('node:path') as typeof import('node:path');
        const recheck = readFileSync(resolve(process.cwd(), 'services/traceRecheck.ts'), 'utf8');
        expect(recheck).toContain('opts.departureMs ?? opts.priorVerification?.departureMs ?? Date.now()');
        // The ack path threads it too.
        expect(recheck).toContain('departureMs: departureMs ?? Date.now()');
        const logPage = readFileSync(resolve(process.cwd(), 'pages/LogPage.tsx'), 'utf8');
        expect(logPage).toContain('ackReport.priorDepartureMs');
    });
});
