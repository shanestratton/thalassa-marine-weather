import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The crewing view (Shane 2026-10-03): crew see the boat they were invited on,
// its people by name and role, and a crew-safe brief for a Mayday. One
// SECURITY DEFINER read, not a peer SELECT policy: RLS is row-level, so a peer
// policy on vessel_crew would hand every crew member the others' emails and
// permissions. Written, not pushed: Shane says 'yes, push it' first.
const migration = readFileSync(join(process.cwd(), 'supabase/migrations/20261003120000_crew_vessel_view.sql'), 'utf8');
const sql = migration
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
const body = sql.match(/AS \$\$([\s\S]+?)\$\$;/)?.[1] ?? '';

describe('get_crew_vessel_view migration', () => {
    it('creates one SECURITY DEFINER function with a fixed search_path, and no policy', () => {
        expect(sql).toMatch(
            /CREATE OR REPLACE FUNCTION public\.get_crew_vessel_view\(p_owner_id UUID\)\s+RETURNS JSONB/i,
        );
        expect(sql).toMatch(/SECURITY DEFINER/);
        expect(sql).toMatch(/SET search_path = pg_catalog, public, pg_temp/);
        expect(sql).toMatch(/\bSTABLE\b/);
        expect(sql).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER TABLE/i);
        expect(sql.match(/CREATE (OR REPLACE )?FUNCTION/gi)).toHaveLength(1);
    });

    it('lets authenticated users execute it, and nobody else', () => {
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_crew_vessel_view\(UUID\) FROM PUBLIC, anon;/);
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_crew_vessel_view\(UUID\) TO authenticated;/);
        expect(sql).not.toMatch(/GRANT[^;]*get_crew_vessel_view[^;]*\b(anon|PUBLIC)\b/i);
    });

    it('answers NULL (never an error) for a signed-out caller or anyone not accepted crew', () => {
        expect(body).toMatch(/caller UUID := auth\.uid\(\);/);
        expect(body).toMatch(/IF caller IS NULL OR p_owner_id IS NULL THEN\s+RETURN NULL;/);
        const gate = body.match(/IF caller <> p_owner_id AND NOT EXISTS \(([\s\S]+?)\) THEN\s+RETURN NULL;/)?.[1] ?? '';
        expect(gate).toContain('FROM public.vessel_crew AS m');
        expect(gate).toContain('m.owner_id = p_owner_id');
        expect(gate).toContain('m.crew_user_id = caller');
        expect(gate).toContain("m.status = 'accepted'");
        // Vessel-level crew, as the binders read it: voyage_id is ignored.
        expect(sql).not.toMatch(/voyage_id/);
        expect(body).not.toMatch(/RAISE/i);
    });

    it("picks the hull the caller is a member of, else the owner's live hull by the bridge rule", () => {
        const hull = body.match(/FROM public\.boats AS boat([\s\S]+?)LIMIT 1;/)?.[1] ?? '';
        expect(hull).toContain('LEFT JOIN public.boat_members AS me');
        expect(hull).toContain('me.user_id = caller');
        expect(hull).toContain('LEFT JOIN public.user_active_vessels AS active');
        expect(hull).toContain('boat.owner_id = p_owner_id');
        expect(hull).toContain('boat.archived_at IS NULL');
        expect(hull).toMatch(
            /ORDER BY \(me\.user_id IS NOT NULL\) DESC, \(active\.boat_id IS NOT NULL\) DESC, boat\.updated_at DESC, boat\.id/,
        );
    });

    it('reads the profile through an allow-list only, and never names the private fields', () => {
        const textKeys = body.match(/text_keys CONSTANT TEXT\[\] := ARRAY\[([^\]]+)\]/)?.[1] ?? '';
        const numberKeys = body.match(/number_keys CONSTANT TEXT\[\] := ARRAY\[([^\]]+)\]/)?.[1] ?? '';
        const unitKeys = body.match(/unit_keys CONSTANT TEXT\[\] := ARRAY\[([^\]]+)\]/)?.[1] ?? '';
        const list = (value: string) => [...value.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort();
        expect(list(textKeys)).toEqual(
            [
                'type',
                'model',
                'riggingType',
                'hullType',
                'hullColor',
                'trimColor',
                'hullMaterial',
                'hailingPort',
                'registration',
                'mmsi',
                'callSign',
                'phoneticName',
                'sailNumber',
                'radiosMonitored',
                'prominentFeatures',
                'tenderDescription',
                'liferaftServiceDate',
                'flaresExpiry',
            ].sort(),
        );
        expect(list(numberKeys)).toEqual(
            [
                'length',
                'beam',
                'draft',
                'airDraft',
                'displacement',
                'cruisingSpeed',
                'crewCount',
                'liferaftCapacity',
                // The boat's own limits: a crew member's weather window on the
                // skipper's passage scores against the skipper's boat.
                'maxWindSpeed',
                'maxWaveHeight',
            ].sort(),
        );
        expect(list(unitKeys)).toEqual(['beam', 'displacement', 'draft', 'length', 'volume']);
        // Each profile entry passes only by key AND type.
        expect(body).toMatch(/entry\.key = ANY \(text_keys\) AND jsonb_typeof\(entry\.value\) = 'string'/);
        expect(body).toMatch(/entry\.key = ANY \(number_keys\) AND jsonb_typeof\(entry\.value\) = 'number'/);
        expect(body).not.toMatch(/SELECT\s+[^;]*\bprofile\.\*/i);
        expect(body).not.toMatch(/to_jsonb\(\s*(p|profile|bp)\s*\)/i);
        for (const forbidden of [
            'crew_email',
            'owner_email',
            'permissions',
            'shared_registers',
            'epirbHexId',
            'shoreContact',
            'contactPhone',
            'satPhone',
            'safetyNotes',
            'polar',
            'comfort',
            'email',
        ]) {
            expect(sql).not.toContain(forbidden);
        }
        expect(sql).not.toMatch(/['"]age['"]|\bage\b/);
    });

    it('returns roster name and rank only, capped at the crew count', () => {
        const roster = body.match(/jsonb_array_elements\(prof->'crewRoster'\)[\s\S]+?;/)?.[0] ?? '';
        expect(roster).toContain('ord <= roster_cap');
        const built =
            body.match(
                /jsonb_agg\(\s*jsonb_strip_nulls\(\s*jsonb_build_object\(\s*'name'([\s\S]+?)\)\s*\)\s+ORDER BY ord/,
            )?.[1] ?? '';
        expect(built).toContain("'rank'");
        expect([...built.matchAll(/'([a-zA-Z]+)',/g)].map((m) => m[1])).toEqual(['rank']);
    });

    it('builds the manifest from accepted rows only, most senior role per person, names and roles only', () => {
        expect(body).toMatch(/m\.status = 'accepted'/);
        expect(body).not.toMatch(/'pending'|'declined'/);
        expect(body).toMatch(
            /WHEN 'co-skipper' THEN 4 WHEN 'navigator' THEN 3 WHEN 'deckhand' THEN 2 WHEN 'punter' THEN 1 ELSE 0/,
        );
        // Names: the caller's own hull's boat_members row (what RLS already
        // shows), else the person's own name metadata. Never
        // user_name_parts: it falls back to the email's local part, which
        // RLS never showed across hulls.
        expect(body).not.toContain('user_name_parts');
        expect(body).toMatch(/ON bm\.boat_id = hull_id\s+AND bm\.user_id = people\.person_id/);
        expect(body).toMatch(/FROM auth\.users AS u\s+WHERE u\.id = people\.person_id/);
        expect(body).toContain('u.raw_user_meta_data');
        expect(body).not.toMatch(/split_part|initcap/i);
        const entryKeys = body.match(/'isSkipper'[\s\S]+?'lastName'[^)]*\)/)?.[0] ?? '';
        expect([...entryKeys.matchAll(/'([a-zA-Z]+)',/g)].map((m) => m[1])).toEqual([
            'isSkipper',
            'isSelf',
            'role',
            'prefix',
            'firstName',
            'nickname',
            'lastName',
        ]);
        // No user id leaves the function.
        expect(body).not.toMatch(/'(userId|user_id|ownerId|owner_id|crewUserId)'/);
    });
});
