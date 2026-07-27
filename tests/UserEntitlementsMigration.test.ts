import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20260728100000_user_entitlements.sql'),
    'utf8',
);

describe('user entitlement contract migration', () => {
    it('separates service-owned entitlement state from mutable user settings', () => {
        expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.user_entitlements');
        expect(migration).toContain("CHECK (subscription_status IN ('active', 'trial', 'expired', 'free'))");
        expect(migration).toContain('ALTER TABLE public.user_entitlements ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain('CREATE POLICY user_entitlements_read_own');
        expect(migration).toContain('USING (auth.uid() = user_id)');
        expect(migration).toContain(
            'REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_entitlements FROM authenticated',
        );
    });

    it('allows an authenticated skipper to bootstrap only their own trial once', () => {
        const functionBlock = migration.slice(
            migration.indexOf('CREATE OR REPLACE FUNCTION public.ensure_own_user_entitlement()'),
        );
        expect(functionBlock).toContain('current_user_id UUID := auth.uid()');
        expect(functionBlock).toContain("VALUES (current_user_id, 'trial', statement_timestamp())");
        expect(functionBlock).toContain('ON CONFLICT (user_id) DO NOTHING');
        expect(functionBlock).toContain('WHERE entitlement.user_id = current_user_id');
        expect(functionBlock).toContain(
            'REVOKE ALL ON FUNCTION public.ensure_own_user_entitlement() FROM PUBLIC, anon',
        );
        expect(functionBlock).toContain(
            'GRANT EXECUTE ON FUNCTION public.ensure_own_user_entitlement() TO authenticated, service_role',
        );
    });
});
