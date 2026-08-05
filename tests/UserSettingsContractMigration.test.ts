import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260728090000_user_settings_contract.sql', 'utf8');
const store = readFileSync('stores/settingsStore.ts', 'utf8');

const excludedFields = [
    'vessel',
    'vesselUnits',
    'comfortParams',
    'polarData',
    'polarBoatModel',
    'polarSource_type',
    'subscriptionTier',
    'subscriptionExpiry',
    'isPro',
];

describe('user settings contract migration', () => {
    it('creates an account-private settings record with an object-only payload', () => {
        expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.user_settings/i);
        expect(migration).toMatch(/user_id\s+UUID PRIMARY KEY REFERENCES auth\.users\(id\) ON DELETE CASCADE/i);
        expect(migration).toMatch(/settings\s+JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);
        expect(migration).toMatch(/jsonb_typeof\(settings\) = 'object'/i);
        expect(migration).toMatch(/ALTER TABLE public\.user_settings ENABLE ROW LEVEL SECURITY/i);
        expect(migration).toMatch(
            /ON public\.user_settings FOR SELECT TO authenticated[\s\S]*user_id = auth\.uid\(\)/i,
        );
        expect(migration).toMatch(/REVOKE ALL ON TABLE public\.user_settings FROM anon, authenticated/i);
        expect(migration).toMatch(/GRANT SELECT ON TABLE public\.user_settings TO authenticated/i);
    });

    it('backfills only compatible legacy settings and never makes them fleet or entitlement authority', () => {
        expect(migration).toMatch(/to_regclass\('public\.profiles'\) IS NOT NULL/i);
        expect(migration).toMatch(/information_schema\.columns/i);
        expect(migration).toMatch(/column_name = 'id'/i);
        expect(migration).toMatch(/column_name = 'settings'/i);
        expect(migration).toMatch(/INNER JOIN auth\.users AS account ON account\.id = profile\.id/i);
        expect(migration).toMatch(/ON CONFLICT \(user_id\) DO NOTHING/i);

        for (const field of excludedFields) {
            expect(migration).toContain(`'${field}'`);
        }
    });

    it('accepts only an authenticated caller and funnels writes through the guarded merge RPC', () => {
        const rpc =
            migration.match(/CREATE OR REPLACE FUNCTION public\.merge_user_settings[\s\S]*?\n\$\$;/i)?.[0] ?? '';
        expect(rpc).toMatch(/caller_id UUID := auth\.uid\(\)/i);
        expect(rpc).toMatch(/auth\.role\(\) <> 'authenticated'/i);
        expect(rpc).toMatch(/Settings patch must be a JSON object/i);
        expect(rpc).toMatch(/octet_length\(p_patch::text\) > 262144/i);
        expect(rpc).toMatch(/INSERT INTO public\.user_settings AS target/i);
        expect(rpc).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/i);
        expect(rpc).toMatch(/target\.settings \|\| EXCLUDED\.settings/i);
        expect(rpc).toMatch(/'notifications'/i);
        expect(rpc).toMatch(/'units'/i);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.merge_user_settings\(JSONB\)[\s\S]*FROM PUBLIC, anon, authenticated/i,
        );
        expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.merge_user_settings\(JSONB\) TO authenticated/i);
    });

    it('uses user_settings plus identity-fenced, client-writable patches rather than profiles or full snapshots', () => {
        expect(store).toMatch(/\.from\('user_settings'\)/);
        expect(store).toMatch(/\.rpc\('merge_user_settings', \{ p_patch: settingsPatch \}\)/);
        // updateSettings strips client-authored entitlement fields before it
        // reaches the serialised merge queue. The old `patch` name described
        // the same sparse-write contract but would now bypass that boundary.
        expect(store).toMatch(/void queueSettingsSync\(scope, clientWritablePatch\)/);
        expect(store).toMatch(/if \(!supabase \|\| !scope\.userId \|\| !isAuthIdentityScopeCurrent\(scope\)\) return;/);
        expect(store).toMatch(/if \(scope\.userId && _userId === scope\.userId\) \{/);
        expect(store).not.toMatch(/void queueSettingsSync\(scope, updated\)/);
        expect(store).not.toMatch(/\.from\('profiles'\)/);

        for (const field of excludedFields) {
            expect(store).toMatch(new RegExp(`${field}: _`, 'i'));
        }
    });
});
