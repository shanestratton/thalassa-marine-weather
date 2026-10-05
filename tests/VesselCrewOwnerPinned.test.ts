/**
 * Migration 20261005140000_vessel_crew_owner_pinned.sql (WRITTEN, NOT
 * PUSHED): nobody is their own crew, and nobody with a JWT moves a membership
 * to another skipper or person. Before it, a self-invite (owner = crew = me)
 * then a PATCH of owner_id to a victim with status 'accepted' passed every
 * policy and guard, and made the attacker accepted crew of the victim's boat.
 * Text contracts; the rolled-back replay acts it out before the push.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FILE =
    process.env.VESSEL_CREW_MIGRATION_UNDER_TEST ?? 'supabase/migrations/20261005140000_vessel_crew_owner_pinned.sql';
const sql = readFileSync(FILE, 'utf8');
const code = sql.replace(/--[^\n]*\n/g, '\n');
const flat = code.replace(/\s+/g, ' ');

const before = readFileSync('supabase/migrations/20260723100000_crew_manifest_hardening.sql', 'utf8');

function body(text: string): string {
    const at = text.indexOf('CREATE OR REPLACE FUNCTION public.guard_vessel_crew_member_update()');
    expect(at).toBeGreaterThan(-1);
    return text.slice(at, text.indexOf('$$;', at));
}

/** The crew-only branch, from its comment to the END IF that closes it. */
function crewBranch(text: string): string {
    const b = body(text);
    const at = b.indexOf('-- Captains manage their own rows.');
    expect(at).toBeGreaterThan(-1);
    return b.slice(at, b.indexOf('RETURN NEW;', at));
}

describe('vessel_crew: a membership keeps its skipper and its crew member', () => {
    it('refuses a self-membership with a CHECK, re-runnably', () => {
        expect(flat).toContain('ALTER TABLE public.vessel_crew DROP CONSTRAINT IF EXISTS vessel_crew_not_self;');
        expect(flat).toContain(
            'ALTER TABLE public.vessel_crew ADD CONSTRAINT vessel_crew_not_self CHECK (owner_id <> crew_user_id);',
        );
    });

    it('refuses any JWT caller who changes owner_id or crew_user_id, before anything else', () => {
        const guard = body(code).replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')');
        expect(guard).toContain(
            'BEGIN IF auth.uid() IS NOT NULL AND (NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.crew_user_id IS DISTINCT FROM OLD.crew_user_id) THEN RAISE EXCEPTION',
        );
    });

    it('keeps the crew-only rule of 20260723100000 exactly', () => {
        expect(crewBranch(sql)).toBe(crewBranch(before));
    });

    it('pins search_path, stays invoker-rights, and does not re-create the trigger (no trigger lock)', () => {
        const guard = body(code);
        expect(guard).toContain('SET search_path = pg_catalog, public, pg_temp');
        expect(guard).not.toMatch(/SECURITY DEFINER/);
        expect(flat).toContain(
            'REVOKE ALL ON FUNCTION public.guard_vessel_crew_member_update() FROM PUBLIC, anon, authenticated;',
        );
        expect(code).not.toMatch(/DROP TRIGGER|CREATE TRIGGER/);
        expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
        expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    });

    it('goes up after the live seabed migration and before sightings, whose crew feed trusts it', () => {
        const name = FILE.split('/').pop() as string;
        expect(name > '20261005130000_seabed_mapping.sql').toBe(true);
        expect(name < '20261005150000_sightings.sql').toBe(true);
    });
});
