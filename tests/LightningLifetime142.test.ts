// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { lightningRetirementFixture } from './sql/lightningRetirement142.mjs';
const read = (file: string) =>
    readFileSync(fileURLToPath(new URL('../' + file, import.meta.url)), 'utf8').replaceAll('\r\n', '\n');
describe('held lightning actual-clock and integrated retirement source boundaries', () => {
    it('keeps the exact referenced real presence/comfort table and trigger bodies', () => {
        expect(read('tests/sql/lightning-retirement142.sql')).toBe(lightningRetirementFixture());
        expect(read('tests/sql/lightning-watch142-bootstrap.sql')).toContain('\\ir lightning-retirement142.sql');
    });
    it('keeps the unchanged public source guardrail ceilings and original core assertions', () => {
        const sql = read('supabase/migrations/20261017103100_licensed_lightning_watch.sql');
        for (const original of [
            'LIMIT 32',
            'jsonb_array_length(result)>=8',
            "interval '2 minutes'",
            "interval '60 seconds'",
            "interval '15 minutes'",
            "interval '24 hours')>=6",
            "interval '24 hours')>=8",
            '<=37.04',
        ])
            expect(sql).toContain(original);
        expect((sql.match(/\$\$/g) ?? []).length).toBe(20);
        expect(sql).not.toMatch(/\b(?:AS|END) \$(?:;|\n)/);
    });
    it('refuses boat/account contention before either can acquire the reverse lock edge', () => {
        const sql = read('supabase/migrations/20261017103100_licensed_lightning_watch.sql');
        for (const name of ['configure_lightning_watch', 'lightning_watch_claim', 'lightning_watch_work']) {
            const fn = sql.slice(sql.indexOf('CREATE FUNCTION public.' + name)).split('END $$;')[0];
            expect(fn.indexOf('FOR SHARE')).toBeGreaterThan(0);
            expect(fn.indexOf('pg_try_advisory_xact_lock')).toBeGreaterThan(fn.indexOf('FOR SHARE'));
            expect(fn).not.toContain('PERFORM pg_advisory_xact_lock');
        }
    });
    it('captures final claim time after profile/attempt waits and gives both queue rows that time', () => {
        const sql = read('supabase/migrations/20261017103100_licensed_lightning_watch.sql');
        const claim = sql.slice(sql.indexOf('CREATE FUNCTION public.lightning_watch_claim')).split('END $$;')[0];
        expect(claim.indexOf('at_clock:=clock_timestamp()')).toBeGreaterThan(claim.lastIndexOf('FOR UPDATE;'));
        expect(claim).not.toContain('now()');
        expect(claim).toContain('private_lightning142.position(p_boat_id,at_clock)');
        expect(claim).toContain('private_lightning142.ready(at_clock)');
        expect(claim).toContain("'pulse_id',p_pulse_id),at_clock) RETURNING");
        expect(claim).toContain('p_source_at,expires,at_clock)');
    });
    it('durably retires real boat transitions without deleting the alert quota history', () => {
        const sql = read('supabase/migrations/20261017103100_licensed_lightning_watch.sql');
        const retire = sql.slice(sql.indexOf('CREATE FUNCTION private_lightning142.boat_retired')).split('END $$;')[0];
        expect(retire).toContain('NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id');
        expect(retire).toContain('NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at');
        expect(retire).toContain('NEW.released_at IS NOT DISTINCT FROM OLD.released_at');
        expect(retire).toContain('enabled=false,revision=gen_random_uuid()');
        expect(retire).toContain('DELETE FROM private_lightning142.attempts');
        expect(retire).not.toContain('DELETE FROM private_lightning142.deliveries');
        expect(sql).toContain(
            'CREATE TRIGGER aa_lightning_watch_boat_retirement BEFORE UPDATE OR DELETE ON public.boats',
        );
    });
    it('admits every boat update before the actual inherited blocking account fence, including no-ops', () => {
        const sql = read('supabase/migrations/20261017103100_licensed_lightning_watch.sql');
        const retire = sql.slice(sql.indexOf('CREATE FUNCTION private_lightning142.boat_retired')).split('END $$;')[0];
        expect(retire.indexOf('pg_try_advisory_xact_lock')).toBeLessThan(retire.indexOf('THEN RETURN NEW;'));
        expect('aa_lightning_watch_boat_retirement' < 'account_deletion_write_fence').toBe(true);
        expect(lightningRetirementFixture()).toContain(
            'CREATE TRIGGER account_deletion_write_fence BEFORE INSERT OR UPDATE',
        );
    });
});
