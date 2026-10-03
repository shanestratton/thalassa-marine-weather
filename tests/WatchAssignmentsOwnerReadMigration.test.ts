import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Shane 2026-10-03, about crew still being able to read assigned crew emails
// from the watch schedule: "yes place on your list". watch_assignments_crew_read
// let crew holding the passage checklist permission SELECT whole rows over REST,
// assigned_crew_email included. After this the raw rows are the passage
// owner's, plus each crew member's OWN assigned rows (only ever their own
// address, so a build without the by-name read keeps its pre-watch alarms),
// and crew read the bill BY NAME through one SECURITY DEFINER function.
// Written, not pushed: Shane says 'yes, push it' first.
const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/20261003140000_watch_assignments_owner_read.sql'),
    'utf8',
);
const sql = migration
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
const body = sql.match(/AS \$\$([\s\S]+?)\$\$;/)?.[1] ?? '';
const guard = sql.match(/DO \$\$([\s\S]+?)\$\$;/)?.[1] ?? '';
const ownPolicy = sql.match(/CREATE POLICY watch_assignments_crew_read_own([\s\S]+?);/)?.[1] ?? '';

describe('watch_assignments owner-only read migration', () => {
    it('creates one SECURITY DEFINER read with a fixed search_path', () => {
        expect(sql).toMatch(
            /CREATE OR REPLACE FUNCTION public\.get_crew_watch_bill\(p_voyage_id TEXT\)\s+RETURNS JSONB/i,
        );
        expect(sql).toMatch(/SECURITY DEFINER/);
        expect(sql).toMatch(/SET search_path = pg_catalog, public, pg_temp/);
        expect(sql).toMatch(/\bSTABLE\b/);
        expect(sql.match(/CREATE (OR REPLACE )?FUNCTION/gi)).toHaveLength(1);
    });

    it('lets authenticated users execute it, and nobody else', () => {
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_crew_watch_bill\(TEXT\) FROM PUBLIC, anon;/);
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_crew_watch_bill\(TEXT\) TO authenticated;/);
        expect(sql).not.toMatch(/GRANT[^;]*get_crew_watch_bill[^;]*\b(anon|PUBLIC)\b/i);
        expect(sql).not.toMatch(/GRANT[^;]*ON TABLE/i);
    });

    it('answers NULL, never an error, unless the dropped policy would have shown the rows', () => {
        expect(body).toMatch(/caller UUID := auth\.uid\(\);/);
        expect(body).toMatch(/IF caller IS NULL OR p_voyage_id IS NULL THEN\s+RETURN NULL;/);
        // The same gate as watch_assignments_crew_read (20260723104000): the
        // voyages row, and the checklist permission on it. The owner passes too.
        const gate = body.match(/FROM public\.voyages AS voyage([\s\S]+?)LIMIT 1;/)?.[1] ?? '';
        expect(gate).toContain('voyage.id::TEXT = p_voyage_id');
        expect(gate).toContain("public.can_access_passage(voyage.user_id, voyage.id, 'can_view_passage_checklist')");
        expect(body).toMatch(/IF passage_id IS NULL THEN\s+RETURN NULL;/);
        expect(body).not.toMatch(/RAISE/i);
    });

    it('returns watches by index, label, time, assigned, self and name parts only', () => {
        const built = body.match(/jsonb_build_object\(\s*'watchIndex'([\s\S]+?)\)\s*\)\s+ORDER BY/)?.[0] ?? '';
        expect([...built.matchAll(/'([a-zA-Z]+)',/g)].map((m) => m[1])).toEqual([
            'watchIndex',
            'watchLabel',
            'watchTimeLabel',
            'assigned',
            'isSelf',
            'prefix',
            'firstName',
            'nickname',
            'lastName',
        ]);
        expect(body).toMatch(/jsonb_build_object\('version', 1, 'watches', COALESCE\(watches, '\[\]'::JSONB\)\)/);
        // No email, no user id, no assigner leaves the function.
        expect(body).not.toMatch(/'[a-zA-Z]*(email|Email|userId|user_id|UserId|assignedBy|assigned_by)[a-zA-Z]*'/);
        expect(body).not.toMatch(/to_jsonb\(\s*w\s*\)|row_to_json|w\.\*/i);
    });

    it('reads the email only to decide assigned and self, never to name anyone', () => {
        // assigned is the skipper's own card's rule: the email is present.
        expect(body).toMatch(/NULLIF\(btrim\(w\.assigned_crew_email\), ''\) IS NOT NULL/);
        // self: by user id, or by the caller's OWN address (the alarm's match).
        expect(body).toMatch(
            /SELECT lower\(btrim\(u\.email\)\)\s+INTO caller_address\s+FROM auth\.users AS u\s+WHERE u\.id = caller;/,
        );
        expect(body).toContain('w.assigned_crew_user_id = caller');
        expect(body).toContain('lower(btrim(w.assigned_crew_email)) = caller_address');
        expect(body.match(/assigned_crew_email/g)).toHaveLength(2);
        // Every stored name falls back to the email's local part, so none is read.
        expect(body).not.toMatch(/assigned_crew_name|user_name_parts|display_name|split_part|initcap/i);
    });

    it("names only the owner and the owner's accepted crew, from their own name records", () => {
        const people = body.match(/WITH people AS \(([\s\S]+?)\)\s*SELECT/)?.[1] ?? '';
        expect(people).toContain('SELECT passage_owner AS person_id');
        expect(people).toContain('m.owner_id = passage_owner');
        expect(people).toContain("m.status = 'accepted'");
        expect(body).not.toMatch(/'pending'|'declined'/);
        // boat_members on one of the owner's live hulls, the voyage's own first.
        const hull = body.match(/FROM public\.boat_members AS bm([\s\S]+?)LIMIT 1/)?.[1] ?? '';
        expect(hull).toContain('JOIN public.boats AS boat');
        expect(hull).toContain('bm.user_id = people.person_id');
        expect(hull).toContain('boat.owner_id = passage_owner');
        expect(hull).toContain('boat.archived_at IS NULL');
        expect(hull).toMatch(/ORDER BY \(boat\.id = passage_boat\) DESC NULLS LAST, boat\.updated_at DESC, boat\.id/);
        // Else the person's own name metadata.
        expect(body).toMatch(/FROM auth\.users AS u\s+WHERE u\.id = people\.person_id/);
        expect(body).toContain('u.raw_user_meta_data');
    });

    it('creates the crew reads BEFORE it drops the crew policy, and leaves the owner policy alone', () => {
        const create = sql.search(/CREATE OR REPLACE FUNCTION public\.get_crew_watch_bill/);
        const own = sql.search(/CREATE POLICY watch_assignments_crew_read_own\b/);
        const drop = sql.search(/DROP POLICY IF EXISTS watch_assignments_crew_read ON public\.watch_assignments;/);
        expect(create).toBeGreaterThan(-1);
        expect(own).toBeGreaterThan(create);
        expect(drop).toBeGreaterThan(own);
        expect(sql.match(/CREATE POLICY/gi)).toHaveLength(1);
        expect(sql).toMatch(/DROP POLICY IF EXISTS watch_assignments_crew_read_own ON public\.watch_assignments;/);
        expect(sql).not.toMatch(/DROP POLICY[^;]*watch_assignments_owner_all/i);
        expect(sql).not.toMatch(/ALTER TABLE|ALTER POLICY/i);
        expect(sql).not.toMatch(/REVOKE[^;]*ON TABLE/i);
    });

    it('lets crew keep reading their OWN assigned rows, which only ever carry their own address', () => {
        expect(ownPolicy).toMatch(/^\s+ON public\.watch_assignments FOR SELECT TO authenticated\s+USING \(/);
        const using = ownPolicy.replace(/\s+/g, ' ');
        // Exactly the rows get_crew_watch_bill marks isSelf: assigned, and
        // naming the caller by user id or by the caller's own address.
        expect(using).toContain(
            "NULLIF(btrim(assigned_crew_email), '') IS NOT NULL AND ( assigned_crew_user_id = auth.uid() OR lower(btrim(assigned_crew_email)) = lower(NULLIF(btrim(auth.jwt() ->> 'email'), '')) ) AND EXISTS (",
        );
        // The dropped policy's own gate, so removed crew read nothing.
        expect(using).toContain(
            "WHERE voyage.id::TEXT = watch_assignments.voyage_id AND public.can_access_passage(voyage.user_id, voyage.id, 'can_view_passage_checklist')",
        );
        // No other way in: one OR, inside the self clause.
        expect(using.match(/\bOR\b/g)).toHaveLength(1);
        expect(ownPolicy).not.toMatch(/WITH CHECK|vessel_crew|assigned_by/i);
    });

    it('refuses to finish unless the owner still reads and writes, and nobody else reads', () => {
        expect(guard).toContain("to_regprocedure('public.get_crew_watch_bill(text)') IS NULL");
        expect(guard).toContain("relation.oid = 'public.watch_assignments'::regclass");
        expect(guard).toContain('relation.relrowsecurity');
        expect(guard).toMatch(/policy\.policyname = 'watch_assignments_owner_all'\s+AND policy\.cmd = 'ALL'/);
        expect(guard).toContain("policy.qual ~ 'voyages\\.user_id = auth\\.uid\\(\\)'");
        expect(guard).toContain("policy.with_check ~ 'voyages\\.user_id = auth\\.uid\\(\\)'");
        // The crew's own-rows read is there, SELECT only, and still self-limited.
        expect(guard).toMatch(
            /policy\.policyname = 'watch_assignments_crew_read_own'\s+AND policy\.cmd = 'SELECT'\s+AND policy\.permissive = 'PERMISSIVE'\s+AND policy\.roles = ARRAY\['authenticated'\]::NAME\[\]/,
        );
        expect(guard).toContain("policy.qual ~ 'assigned_crew_user_id = auth\\.uid\\(\\)'");
        expect(guard).toContain("policy.qual ~ 'auth\\.jwt\\(\\) ->> ''email'''");
        expect(guard).toContain(
            "policy.qual ~ 'can_access_passage\\(voyage\\.user_id, voyage\\.id, ''can_view_passage_checklist'''",
        );
        // Nothing else reads: no third policy, and the owner's has no crew gate.
        expect(guard).toMatch(/policy\.cmd IN \('SELECT', 'ALL'\)/);
        expect(guard).toContain(
            "policy.policyname NOT IN ('watch_assignments_owner_all', 'watch_assignments_crew_read_own')",
        );
        expect(guard).toMatch(/can_access_passage\|vessel_crew/);
        expect(guard.match(/RAISE EXCEPTION/g)?.length).toBeGreaterThanOrEqual(5);
    });
});
