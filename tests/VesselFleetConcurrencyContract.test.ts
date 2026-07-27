/**
 * Fleet concurrency contracts that are easier to regress through a harmless
 * refactor than to reproduce with the native/cloud stack in a unit test.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const storeSource = readFileSync('stores/settingsStore.ts', 'utf8');
const migrationSource = readFileSync('supabase/migrations/20260727120000_hardened_vessel_fleet.sql', 'utf8');

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    const end = start === -1 ? -1 : source.indexOf(endMarker, start + startMarker.length);
    return start === -1 || end === -1 ? '' : source.slice(start, end);
}

describe('vessel fleet concurrency contract', () => {
    it('pins an edit to the boat selected when the edit began', () => {
        const patchAction = sourceBlock(
            storeSource,
            'patchActiveVesselProfile: async (input) => {',
            '\n    _setUserId:',
        );

        expect(patchAction).toMatch(/const localActiveId = beforeEdit\.activeVesselId;/);
        expect(patchAction).toMatch(/let activeId = localActiveId;/);
        expect(patchAction).not.toMatch(/let activeId = get\(\)\.activeVesselId;/);
    });

    it('leaves the legacy identity projection to the database fleet triggers', () => {
        const fleetActions = sourceBlock(storeSource, 'syncVesselFleet: async () => {', '\n    _setUserId:');

        expect(fleetActions).not.toMatch(/saveIdentity\(/);
    });

    it('uses a server-locked idempotent first-vessel bootstrap', () => {
        const bootstrap = sourceBlock(
            migrationSource,
            'CREATE OR REPLACE FUNCTION public.bootstrap_owned_vessel_profile(',
            '\n-- Internal helpers are trigger/RPC implementation details.',
        );

        expect(bootstrap).toMatch(/pg_advisory_xact_lock/);
        expect(bootstrap).toMatch(/FROM public\.create_owned_vessel_profile/);
        expect(bootstrap).toMatch(/IF existing_boat_id IS NOT NULL THEN/);
    });

    it('backfills legacy vessel settings only when the retired profiles table is genuinely compatible', () => {
        const settingsAccessor = sourceBlock(
            migrationSource,
            'CREATE OR REPLACE FUNCTION public._fleet_legacy_settings_20260727120000(',
            '\nINSERT INTO public.boat_profiles (',
        );
        const backfill = sourceBlock(
            migrationSource,
            '-- Backfill each boat profile.',
            '\n-- A few legacy boat rows used free-form type labels.',
        );

        expect(settingsAccessor).toMatch(/to_regclass\('public\.profiles'\) IS NOT NULL/);
        expect(settingsAccessor).toMatch(/information_schema\.columns/);
        expect(settingsAccessor).toMatch(/column_name = 'id'/);
        expect(settingsAccessor).toMatch(/column_name = 'settings'/);
        expect(settingsAccessor).toMatch(/EXECUTE 'SELECT settings::jsonb FROM public\.profiles WHERE id = \$1'/);
        expect(settingsAccessor).toMatch(/RETURN COALESCE\(legacy_settings, '\{\}'::JSONB\)/);

        expect(backfill).toMatch(/CROSS JOIN LATERAL/);
        expect(backfill).toMatch(/_fleet_legacy_settings_20260727120000\(boat\.owner_id\)/);
        expect(backfill).not.toMatch(/LEFT JOIN public\.profiles AS account/);
        expect(backfill).toMatch(/LEFT JOIN public\.vessel_polars AS polars/);
        expect(backfill).toMatch(/polars\.user_id = boat\.owner_id/);
        expect(backfill).toMatch(/WHEN active\.boat_id = boat\.id THEN COALESCE\(/);
        expect(backfill).toMatch(/polars\.polar_data/);
        expect(backfill).toMatch(/polars\.boat_model/);
        expect(backfill).toMatch(/polars\.source/);
        expect(backfill).toMatch(/DROP FUNCTION public\._fleet_legacy_settings_20260727120000\(UUID\)/);
    });
});
