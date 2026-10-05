/**
 * crew_float_plan_details (2026-10-04): an invitee's own name, phone and age
 * for their skipper's float plan. The person writes their own row; the
 * skippers they are accepted crew for read it; nobody else does.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261004120000_crew_float_plan_details.sql', 'utf8');
const body = sql
    .replace(/--[^\n]*\n/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')');

describe('crew_float_plan_details migration', () => {
    it('holds one bounded row per person, removed with the account and fenced after deletion', () => {
        expect(body).toContain('CREATE TABLE IF NOT EXISTS public.crew_float_plan_details (');
        expect(body).toContain('user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE');
        expect(body).toContain('full_name TEXT CHECK (full_name IS NULL OR char_length(full_name) BETWEEN 1 AND 120)');
        expect(body).toContain('phone TEXT CHECK (phone IS NULL OR char_length(phone) BETWEEN 1 AND 40)');
        expect(body).toContain('age SMALLINT CHECK (age IS NULL OR age BETWEEN 1 AND 120)');
        expect(body).toContain("EXECUTE FUNCTION public.block_tombstoned_account_write('user_id')");
        // Exactly the columns the app writes and reads, nothing else.
        expect(body).not.toMatch(/email|epirb|shore|owner_id UUID/i);
    });

    it('is closed to anon and opened to signed-in users only through RLS', () => {
        expect(body).toContain('ALTER TABLE public.crew_float_plan_details ENABLE ROW LEVEL SECURITY');
        expect(body).toContain('REVOKE ALL ON TABLE public.crew_float_plan_details FROM PUBLIC, anon, authenticated');
        expect(body).toContain(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crew_float_plan_details TO authenticated',
        );
        expect(body).not.toMatch(/TO anon|TO PUBLIC/i);
        expect(body).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
    });

    it('lets the person read, write and delete only their own row, and write only while accepted crew', () => {
        expect(body).toMatch(/FOR SELECT TO authenticated USING \(user_id = auth\.uid\(\)\)/);
        expect(body).toMatch(/FOR DELETE TO authenticated USING \(user_id = auth\.uid\(\)\)/);
        const accepted =
            "user_id = auth.uid() AND EXISTS (SELECT 1 FROM public.vessel_crew AS m WHERE m.crew_user_id = auth.uid() AND m.status = 'accepted')";
        expect(body).toContain(`FOR INSERT TO authenticated WITH CHECK (${accepted})`);
        expect(body).toContain(`FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (${accepted})`);
    });

    it("lets a skipper read his accepted crew's rows, and no other crew member", () => {
        expect(body).toContain(
            "FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.vessel_crew AS m WHERE m.owner_id = auth.uid() AND m.crew_user_id = crew_float_plan_details.user_id AND m.status = 'accepted'))",
        );
        // Exactly two read policies: your own, and your skipper's.
        expect(body.match(/FOR SELECT/g)).toHaveLength(2);
        expect(body.match(/CREATE POLICY/g)).toHaveLength(5);
    });

    it('forgets the row when the last accepted membership ends, and never blocks a crew change', () => {
        expect(body).toMatch(
            /CREATE OR REPLACE FUNCTION public\.forget_crew_float_plan_details\(\) RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS \$\$/,
        );
        expect(body).toContain(
            "AND NOT EXISTS (SELECT 1 FROM public.vessel_crew AS m WHERE m.crew_user_id = OLD.crew_user_id AND m.status = 'accepted')",
        );
        expect(body).toContain(
            "EXCEPTION WHEN OTHERS THEN RAISE WARNING 'forget_crew_float_plan_details: %', SQLERRM;",
        );
        expect(body).toContain(
            'REVOKE ALL ON FUNCTION public.forget_crew_float_plan_details() FROM PUBLIC, anon, authenticated;',
        );
        expect(body).toContain(
            'AFTER UPDATE OF status, crew_user_id OR DELETE ON public.vessel_crew FOR EACH ROW EXECUTE FUNCTION public.forget_crew_float_plan_details();',
        );
        // The forget trigger is AFTER only; the one BEFORE trigger here is the acceptance guard.
        expect(body.match(/BEFORE [A-Za-z_ ,]*ON public\.vessel_crew/g)).toEqual([
            'BEFORE INSERT OR UPDATE OF status, crew_user_id ON public.vessel_crew',
        ]);
    });

    it('lets only the invited person make a membership accepted, so a skipper cannot forge one to read details', () => {
        const fn = body
            .slice(
                body.indexOf('CREATE OR REPLACE FUNCTION public.guard_vessel_crew_acceptance()'),
                body.indexOf('REVOKE ALL ON FUNCTION public.guard_vessel_crew_acceptance()'),
            )
            .trim();
        expect(fn).toMatch(
            /^CREATE OR REPLACE FUNCTION public\.guard_vessel_crew_acceptance\(\) RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS \$\$/,
        );
        // Invoker rights: it only reads the caller's own JWT.
        expect(fn).not.toMatch(/SECURITY DEFINER/);
        // Server writes (no JWT), the invited person (Accept, redeeming a crew code) and
        // anything not becoming accepted pass untouched.
        expect(fn).toContain(
            "IF actor IS NULL OR actor = NEW.crew_user_id OR NEW.status IS DISTINCT FROM 'accepted' THEN RETURN NEW; END IF;",
        );
        // Anyone else: no new accepted row, no pending/declined -> accepted, no moving an accepted row to someone else.
        expect(fn).toContain("IF TG_OP = 'INSERT' THEN RAISE EXCEPTION");
        expect(fn).toContain(
            "IF OLD.status IS DISTINCT FROM 'accepted' OR OLD.crew_user_id IS DISTINCT FROM NEW.crew_user_id THEN RAISE EXCEPTION",
        );
        expect(fn.match(/USING ERRCODE = '42501'/g)).toHaveLength(2);
        expect(body).toContain(
            'REVOKE ALL ON FUNCTION public.guard_vessel_crew_acceptance() FROM PUBLIC, anon, authenticated;',
        );
        expect(body).toContain(
            'CREATE TRIGGER trg_guard_vessel_crew_acceptance BEFORE INSERT OR UPDATE OF status, crew_user_id ON public.vessel_crew FOR EACH ROW EXECUTE FUNCTION public.guard_vessel_crew_acceptance();',
        );
    });

    it('cannot fail or block a crew change, and returns before touching anything on an Accept', () => {
        const fn = body
            .slice(
                body.indexOf('CREATE OR REPLACE FUNCTION public.forget_crew_float_plan_details()'),
                body.indexOf('REVOKE ALL ON FUNCTION public.forget_crew_float_plan_details()'),
            )
            .trim();
        // One guarded block holds every statement: the outer body is BEGIN BEGIN ... EXCEPTION ... END; RETURN NULL; END.
        expect(fn).toMatch(
            /AS \$\$ BEGIN BEGIN IF OLD\.crew_user_id IS NULL OR OLD\.status IS DISTINCT FROM 'accepted' THEN RETURN NULL; END IF;/,
        );
        expect(fn).toMatch(/EXCEPTION WHEN OTHERS THEN RAISE WARNING '[^']*', SQLERRM; END; RETURN NULL; END; \$\$;$/);
        // NEW is read only on an UPDATE (it is NULL on a DELETE).
        expect(fn).toContain(
            "IF TG_OP = 'UPDATE' THEN IF NEW.status = 'accepted' AND NEW.crew_user_id = OLD.crew_user_id THEN RETURN NULL; END IF; END IF;",
        );
        expect(fn).not.toMatch(/RAISE EXCEPTION/);
    });

    it('is safe to re-run', () => {
        expect(body.match(/CREATE TRIGGER (\w+)/g)).toEqual([
            'CREATE TRIGGER trg_crew_float_plan_details_updated_at',
            'CREATE TRIGGER account_deletion_write_fence',
            'CREATE TRIGGER trg_guard_vessel_crew_acceptance',
            'CREATE TRIGGER trg_vessel_crew_forget_float_plan_details',
        ]);
        for (const trigger of [
            'trg_crew_float_plan_details_updated_at ON public.crew_float_plan_details',
            'account_deletion_write_fence ON public.crew_float_plan_details',
            'trg_guard_vessel_crew_acceptance ON public.vessel_crew',
            'trg_vessel_crew_forget_float_plan_details ON public.vessel_crew',
        ]) {
            expect(body).toContain(`DROP TRIGGER IF EXISTS ${trigger};`);
        }
        const policies = [...body.matchAll(/CREATE POLICY "([^"]+)"/g)].map((match) => match[1]);
        for (const policy of policies) {
            expect(body).toContain(`DROP POLICY IF EXISTS "${policy}" ON public.crew_float_plan_details;`);
        }
        expect(body).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
        expect(body).not.toMatch(/CREATE FUNCTION/);
        // Never drops the table or anything of vessel_crew's own.
        expect(body).not.toMatch(/DROP TABLE|DROP FUNCTION|DROP POLICY IF EXISTS "[^"]+" ON public\.vessel_crew/);
    });

    it('waits at most a few seconds for vessel_crew and never ends the transaction it runs in', () => {
        // DROP TRIGGER IF EXISTS takes an ACCESS EXCLUSIVE lock on vessel_crew even when the
        // trigger is absent; a bounded wait keeps app readers from queueing behind the push.
        expect(body.trimStart().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
        // The pre-push replay runs this file inside BEGIN ... ROLLBACK: a COMMIT here would make it live.
        expect(body).not.toMatch(/\bCOMMIT\b|\bROLLBACK\b|\bBEGIN;|START TRANSACTION/i);
    });

    it('records the approval and how the app behaves before it is live', () => {
        expect(sql).toContain('Push approved by Shane 2026-10-05 ("yes push it, finish the float plan")');
        expect(sql).toContain('PGRST205 / 42P01 (and PGRST202 / 42883)');
    });
});
