/**
 * Account deletion could not finish for anyone who had ever ticked an item off
 * the shopping list — and what it left behind was worse than residue.
 *
 * guard_grocery_purchase_delete() fires BEFORE DELETE on shopping_list and,
 * for any purchased row, raises twice over: 42501 because it demands an
 * auth.uid() the service-role scrub does not have, and 23514 "Undo the grocery
 * purchase before deleting the item". The scrub deletes shopping_list rows by
 * user_id, so the whole transaction aborts.
 *
 * The tombstone in account_deletion_jobs is written BEFORE the destructive
 * steps and is never rolled back. So the account ends up permanently
 * write-fenced — read-only, undeletable, still signed in — with no recovery
 * short of hand-written SQL. A delete button that bricks the account is worse
 * than no delete button.
 *
 * Found by the deletion audit of 2026-08-28, ranked ahead of every residue
 * finding for exactly that reason.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = 'supabase/migrations';
const fix = readFileSync(`${DIR}/20260829020000_deletion_unblock_grocery_guard.sql`, 'utf8');
const durability = readFileSync(`${DIR}/20260806120000_account_deletion_durability.sql`, 'utf8');

describe('the grocery guard no longer blocks account deletion', () => {
    it('stands down when the deletion scrub is running', () => {
        expect(fix).toContain("current_setting('thalassa.account_deletion_scrub', true) = 'true'");
        const body = fix.slice(fix.indexOf('BEGIN'));
        // The bail-out comes FIRST — before the permission check that a
        // service-role scrub can never satisfy.
        expect(body.indexOf('account_deletion_scrub')).toBeLessThan(body.indexOf('auth.uid() IS NULL'));
    });

    it('uses the flag the scrub actually sets, not a new one', () => {
        // scrub_account_deletion_survivors() sets it transaction-locally via
        // set_config(..., true) inside a SECURITY DEFINER function, so a
        // client cannot spoof it.
        expect(durability).toContain("set_config('thalassa.account_deletion_scrub', 'true', true)");
    });

    it('keeps the guard intact for every ordinary delete', () => {
        // The guard is right in normal use: deleting a purchased row orphans
        // its deterministic Stores receipt.
        expect(fix).toContain("RAISE EXCEPTION 'Undo the grocery purchase before deleting the item'");
        expect(fix).toContain("USING ERRCODE = '23514'");
        expect(fix).toContain("RAISE EXCEPTION 'Ship''s Stores edit permission is required'");
        expect(fix).toContain("USING ERRCODE = '42501'");
    });

    it('replaces the function in place rather than dropping the trigger', () => {
        // CREATE OR REPLACE keeps trg_guard_grocery_purchase_delete bound and
        // every other caller unchanged.
        expect(fix).toContain('CREATE OR REPLACE FUNCTION public.guard_grocery_purchase_delete()');
        expect(fix).not.toContain('DROP TRIGGER');
        expect(fix).toContain('SECURITY DEFINER');
        expect(fix).toContain('SET search_path = pg_catalog, public');
    });

    it('sorts after the migration it repairs', () => {
        const names = readdirSync(DIR)
            .filter((n) => n.endsWith('.sql'))
            .sort();
        expect(names.indexOf('20260829020000_deletion_unblock_grocery_guard.sql')).toBeGreaterThan(
            names.indexOf('20260723104300_atomic_grocery_purchase.sql'),
        );
        // No LATER migration redefines the guard — that, not being last in
        // the directory, is what stops the old body coming back.
        const later = names.filter((n) => n > '20260829020000_deletion_unblock_grocery_guard.sql');
        for (const name of later) {
            // Redefinition or removal is what could bring the old body
            // back; privilege statements are fine — 20260901130000 adds
            // exactly those (REVOKE, definer hygiene).
            const sql = readFileSync(`${DIR}/${name}`, 'utf8');
            expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.guard_grocery_purchase_delete/);
            expect(sql).not.toMatch(/DROP FUNCTION (IF EXISTS )?public\.guard_grocery_purchase_delete/);
        }
    });
});

describe('no other delete guard can abort the scrub the same way', () => {
    it('has no remaining scrub-blind BEFORE DELETE trigger that raises', () => {
        // The class of bug, not just this instance: a BEFORE DELETE trigger
        // that RAISEs unconditionally will abort the deletion transaction.
        // Any new one must either honour the scrub flag or be listed here
        // with a reason.
        const offenders: string[] = [];
        for (const name of readdirSync(DIR).filter((n) => n.endsWith('.sql'))) {
            const sql = readFileSync(`${DIR}/${name}`, 'utf8');
            if (!/BEFORE DELETE/i.test(sql)) continue;
            // Functions bound to a BEFORE DELETE trigger in this file.
            const fns = [...sql.matchAll(/BEFORE DELETE\s+ON\s+([\w.]+)[\s\S]{0,200}?EXECUTE FUNCTION\s+([\w.]+)/gi)];
            for (const [, table, fn] of fns) {
                const short = fn.replace(/^public\./, '');
                const bodyStart =
                    sql.indexOf(`FUNCTION ${fn}(`) >= 0 ? sql.indexOf(`FUNCTION ${fn}(`) : sql.indexOf(short);
                if (bodyStart < 0) continue;
                const body = sql.slice(bodyStart, bodyStart + 2500);
                if (/RAISE EXCEPTION/i.test(body) && !/account_deletion_scrub/.test(body)) {
                    offenders.push(`${name}: ${fn} on ${table}`);
                }
            }
        }
        // guard_grocery_purchase_delete's ORIGINAL definition still lives in
        // its own migration and is expected to appear — it is superseded by
        // the fix above, which sorts later.
        const unexpected = offenders.filter((o) => !o.includes('guard_grocery_purchase_delete'));
        expect(unexpected, `scrub-blind BEFORE DELETE triggers:\n${unexpected.join('\n')}`).toEqual([]);
    });
});
