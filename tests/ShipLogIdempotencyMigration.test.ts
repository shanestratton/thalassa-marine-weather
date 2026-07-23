import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260724092000_ship_log_idempotency.sql', 'utf8');

describe('ship-log idempotency migration', () => {
    it('is additive for existing rows and enforces owner-scoped operation uniqueness', () => {
        expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS client_operation_id TEXT/i);
        expect(migration).toMatch(
            /UNIQUE INDEX IF NOT EXISTS ship_logs_owner_operation_uidx[\s\S]*user_id,\s*client_operation_id/i,
        );
        // A non-partial unique index is deliberate: PostgREST's
        // on_conflict=user_id,client_operation_id can infer it directly,
        // while PostgreSQL still permits all pre-migration NULL keys.
        expect(migration).not.toMatch(/WHERE client_operation_id IS NOT NULL/i);
    });

    it('bounds operation ids to the client format used by offline replay', () => {
        expect(migration).toContain("client_operation_id ~ '^[A-Za-z0-9_-]{1,128}$'");
    });
});
