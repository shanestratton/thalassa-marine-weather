/**
 * The punter's own chart library survived their account deletion — and the
 * deletion said it hadn't.
 *
 * Personal ENC cells live in the `enc-cells` bucket at `u/<uid>/…`: imported
 * S-63 charts, up to 16 MB each, hundreds of them, with the auth uid in the
 * object path, offered to the skipper in Settings as chart backup.
 *
 * account_deletion_storage_inventory() reached objects three ways — storage
 * owner_id, a chat-avatars case, and six buckets matched on the FIRST path
 * segment. enc-cells was in none, and adding it to that list would not have
 * helped: its uid is at segment TWO, behind the literal 'u'. The personal
 * prefix was created one day after the inventory was written.
 *
 * The sting is the verifier. verify_account_deletion_storage_empty() re-runs
 * the same inventory and calls storage clean when it returns nothing — so a
 * bucket it cannot see is certified empty rather than flagged. That is the
 * false all-clear this whole feature exists to prevent.
 *
 * Found by the deletion audit, 2026-08-28.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = 'supabase/migrations';
const fix = readFileSync(`${DIR}/20260829030000_deletion_reach_enc_cells.sql`, 'utf8');
const durability = readFileSync(`${DIR}/20260806120000_account_deletion_durability.sql`, 'utf8');
const personal = readFileSync(`${DIR}/20260807093000_personal_enc_cells.sql`, 'utf8');

const fnBody = (sql: string, fn: string) => {
    const i = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}`);
    return i < 0 ? '' : sql.slice(i, sql.indexOf('\n$$;', i));
};

describe('the inventory can see personal chart cells', () => {
    it('matches the uid at segment two, behind the u prefix', () => {
        const inv = fnBody(fix, 'account_deletion_storage_inventory');
        expect(inv).toContain("object.bucket_id = 'enc-cells'");
        expect(inv).toContain("split_part(object.name, '/', 1) = 'u'");
        expect(inv).toContain("split_part(object.name, '/', 2) = p_user_id::TEXT");
    });

    it('matches the layout the uploader actually writes', () => {
        // Not a guess about the path: this is the prefix the policies enforce.
        expect(personal).toContain("(storage.foldername(name))[1] = 'u'");
    });

    it('adds nothing else — the body is the original plus the branch', () => {
        const before = fnBody(durability, 'account_deletion_storage_inventory');
        const after = fnBody(fix, 'account_deletion_storage_inventory');
        // Every line of the original survives, in order.
        const beforeLines = before.split('\n').filter((l) => l.trim());
        for (const line of beforeLines) expect(after).toContain(line);
        expect(after.split('\n').length).toBeGreaterThan(before.split('\n').length);
    });
});

describe('the write fence covers them too', () => {
    it('derives the owner from the same path shape', () => {
        const fence = fnBody(fix, 'block_tombstoned_storage_write');
        expect(fence).toContain("WHEN NEW.bucket_id = 'enc-cells'");
        expect(fence).toContain("AND split_part(NEW.name, '/', 1) = 'u'");
        expect(fence).toContain("THEN split_part(NEW.name, '/', 2)");
    });

    it('keeps every bucket the fence already covered', () => {
        const before = fnBody(durability, 'block_tombstoned_storage_write');
        const after = fnBody(fix, 'block_tombstoned_storage_write');
        for (const line of before.split('\n').filter((l) => l.trim())) expect(after).toContain(line);
    });
});

describe('why this one needed fixing rather than noting', () => {
    it('the verifier re-runs the inventory, so a blind spot reads as clean', () => {
        const verify = durability.slice(durability.indexOf('verify_account_deletion_storage_empty'));
        expect(verify.slice(0, 2000)).toContain('account_deletion_storage_inventory');
    });

    it('is not undone by anything later', () => {
        const names = readdirSync(DIR)
            .filter((n) => n.endsWith('.sql'))
            .sort();
        const later = names.filter((n) => n > '20260829030000_deletion_reach_enc_cells.sql');
        for (const name of later) {
            // Redefinition or removal undoes the fix; privilege statements
            // do not — 20260901130000 adds REVOKEs (definer hygiene).
            const sql = readFileSync(`${DIR}/${name}`, 'utf8');
            expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.account_deletion_storage_inventory/);
            expect(sql).not.toMatch(/DROP FUNCTION (IF EXISTS )?public\.account_deletion_storage_inventory/);
            expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.block_tombstoned_storage_write/);
            expect(sql).not.toMatch(/DROP FUNCTION (IF EXISTS )?public\.block_tombstoned_storage_write/);
        }
    });
});
