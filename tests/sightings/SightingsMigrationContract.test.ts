/**
 * Migration 20261005150000_sightings.sql: who can read and write a sighting,
 * and the public path that is three hours late and on a grid. These are text
 * contracts; the rolled-back production replay (the workflow's replay plan)
 * proves the same lines as owner, crew, other crew, stranger and anon before
 * the push.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIGHTING_MUTABLE_COLUMNS } from '../../services/sightings/types';

const FILE = process.env.SIGHTINGS_MIGRATION_UNDER_TEST ?? 'supabase/migrations/20261005150000_sightings.sql';
const sql = readFileSync(FILE, 'utf8');
const code = sql.replace(/--[^\n]*\n/g, '\n');
const flat = code.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')');

function fn(name: string, source = code): string {
    const at = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(at, `${name} must be defined`).toBeGreaterThan(-1);
    const end = source.indexOf('$$;', at);
    const endAlt = source.indexOf('$function$;', at);
    const stop = [end, endAlt].filter((i) => i > -1).sort((a, b) => a - b)[0];
    return source.slice(at, stop);
}

function flatten(text: string): string {
    return text.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')');
}

function tableColumns(): string[] {
    const body = code.slice(code.indexOf('CREATE TABLE IF NOT EXISTS public.sightings ('));
    const end = body.indexOf('\n);');
    return [...body.slice(0, end).matchAll(/^\s{4}([a-z_]+) [A-Z]/gm)].map((m) => m[1]);
}

describe('shape and safety', () => {
    it('is replayable inside a rolled-back transaction and re-runnable', () => {
        expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
        expect(code).toContain("SET LOCAL lock_timeout = '5s';");
        expect(code).toContain('CREATE TABLE IF NOT EXISTS public.sightings (');
        expect(code).toContain('CREATE TABLE IF NOT EXISTS public.sighting_taxa (');
        for (const m of code.matchAll(/CREATE POLICY "([^"]+)"\s+ON ([a-z_.]+)/g)) {
            expect(code, m[1]).toContain(`DROP POLICY IF EXISTS "${m[1]}" ON ${m[2]};`);
        }
        for (const m of code.matchAll(/CREATE TRIGGER ([a-z_]+)\s+BEFORE [A-Z ]+ ON ([a-z_.]+)/g)) {
            expect(code, m[1]).toContain(`DROP TRIGGER IF EXISTS ${m[1]} ON ${m[2]};`);
        }
    });

    it('stores Darwin Core shaped rows, removed with the observer and kept (boat-less) when a skipper goes', () => {
        expect(flat).toContain('id UUID PRIMARY KEY');
        expect(flat).toContain('observer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE');
        expect(flat).toContain('vessel_owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL');
        expect(flat).toContain('boat_id UUID REFERENCES public.boats(id) ON DELETE SET NULL');
        for (const column of [
            'scientific_name',
            'vernacular_name',
            'individual_count',
            'event_date',
            'decimal_latitude',
            'decimal_longitude',
            'coordinate_uncertainty_in_meters',
            'basis_of_record',
            'sampling_protocol',
            'occurrence_remarks',
        ]) {
            expect(tableColumns(), column).toContain(column);
        }
        expect(flat).toContain(
            "basis_of_record TEXT NOT NULL DEFAULT 'HumanObservation' CHECK (basis_of_record = 'HumanObservation')",
        );
        expect(flat).toContain('CHECK (cardinality(photo_paths) <= 4)');
    });

    it('never lets fish be public, and Crew needs a boat', () => {
        expect(flat).toContain(
            "CONSTRAINT sightings_fish_never_public CHECK (NOT (taxon_group = 'fish' AND visibility = 'public'))",
        );
        expect(flat).toContain(
            "CONSTRAINT sightings_crew_needs_a_boat CHECK (visibility <> 'crew' OR vessel_owner_id IS NOT NULL)",
        );
        expect(fn('get_public_sightings')).toContain("s.taxon_group <> 'fish'");
    });

    it('is closed to anon and open to signed-in users only through RLS', () => {
        expect(flat).toContain('ALTER TABLE public.sightings ENABLE ROW LEVEL SECURITY');
        expect(flat).toContain('ALTER TABLE public.sighting_taxa ENABLE ROW LEVEL SECURITY');
        expect(flat).toContain('REVOKE ALL ON TABLE public.sightings FROM PUBLIC, anon, authenticated');
        expect(flat).toContain('GRANT SELECT, INSERT, DELETE ON TABLE public.sightings TO authenticated');
        expect(flat).not.toMatch(/\bTO anon\b|\bTO PUBLIC\b|GRANT [^;]* anon/i);
        expect(flat).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
    });

    it("limits UPDATE to the app's mutable columns, exactly", () => {
        const grant = /GRANT UPDATE \(([^)]*)\) ON TABLE public\.sightings TO authenticated/.exec(flat);
        expect(grant).not.toBeNull();
        const columns = (grant?.[1] ?? '').split(',').map((c) => c.trim());
        expect(columns).toEqual([...SIGHTING_MUTABLE_COLUMNS]);
    });
});

describe('row level security', () => {
    it('reads: your own, or a Crew/Public row of a boat you skipper or are accepted crew on; nothing else', () => {
        expect(flat).toContain(
            "ON public.sightings FOR SELECT TO authenticated USING (observer_id = auth.uid() OR (visibility IN ('crew', 'public') AND vessel_owner_id IS NOT NULL AND public.sighting_vessel_member(vessel_owner_id)))",
        );
        // Exactly one read policy: other boats' public rows only through the RPC.
        expect(flat.match(/ON public\.sightings FOR SELECT/g)).toHaveLength(1);
    });

    it('writes: as yourself, against your own boat or an accepted-crew boat', () => {
        expect(flat).toContain(
            'ON public.sightings FOR INSERT TO authenticated WITH CHECK (observer_id = auth.uid() AND (vessel_owner_id IS NULL OR public.sighting_vessel_member(vessel_owner_id)))',
        );
        expect(flat).toContain(
            "ON public.sightings FOR UPDATE TO authenticated USING (observer_id = auth.uid()) WITH CHECK (observer_id = auth.uid() AND (vessel_owner_id IS NULL OR visibility = 'private' OR public.sighting_vessel_member(vessel_owner_id)))",
        );
        expect(flat).toContain('ON public.sightings FOR DELETE TO authenticated USING (observer_id = auth.uid())');
    });

    it('membership means the owner or ACCEPTED crew, read from vessel_crew', () => {
        const member = flatten(fn('sighting_vessel_member'));
        expect(member).toContain('SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp');
        expect(member).toContain('p_owner_id = auth.uid()');
        expect(member).toContain(
            "FROM public.vessel_crew AS m WHERE m.owner_id = p_owner_id AND m.crew_user_id = auth.uid() AND m.status = 'accepted'",
        );
        expect(flat).toContain('REVOKE ALL ON FUNCTION public.sighting_vessel_member(UUID) FROM PUBLIC, anon');
    });
});

describe('the write guard', () => {
    const guard = flatten(fn('sightings_before_write'));

    it('stamps server time, refuses another observer, and checks the boat on insert', () => {
        expect(guard).toContain('NEW.created_at := now();');
        expect(guard).toContain('IF actor IS NOT NULL AND NEW.observer_id IS DISTINCT FROM actor THEN RAISE EXCEPTION');
        expect(guard).toContain(
            "IF NEW.event_date < now() - INTERVAL '60 days' OR NEW.event_date > now() + INTERVAL '5 minutes' THEN",
        );
        expect(guard).toContain('IF actor IS NOT NULL AND NOT public.sighting_vessel_member(NEW.vessel_owner_id) THEN');
        expect(guard).toContain('b.owner_id = NEW.vessel_owner_id AND b.archived_at IS NULL');
        expect(guard).toContain(
            'ORDER BY (me.user_id IS NOT NULL) DESC, (active.boat_id IS NOT NULL) DESC, boat.updated_at DESC, boat.id',
        );
    });

    it('caps writes per hour of event time and per day of server time', () => {
        expect(guard).toContain(
            "s.event_date BETWEEN NEW.event_date - INTERVAL '30 minutes' AND NEW.event_date + INTERVAL '30 minutes'; IF nearby >= 60",
        );
        expect(guard).toContain("s.created_at > now() - INTERVAL '24 hours'; IF nearby >= 1000");
    });

    it('fixes where, when and the context after insert, and only lets the boat go to NULL', () => {
        const immutable = [
            ...guard.matchAll(/NEW\.([a-z_]+) IS DISTINCT FROM OLD\.\1 (?:OR|THEN RAISE EXCEPTION 'Where)/g),
        ].map((m) => m[1]);
        // Every stored column is: mutable by the observer, fixed here, or owned by the server/FK rules.
        const handled = new Set([
            ...SIGHTING_MUTABLE_COLUMNS,
            ...immutable,
            'id',
            'observer_id',
            'vessel_owner_id',
            'boat_id',
            'created_at',
            'updated_at',
            'vernacular_name',
            'taxon_rank',
            'basis_of_record',
            'ever_sensitive',
        ]);
        for (const column of tableColumns()) expect(handled.has(column), column).toBe(true);
        for (const column of ['event_date', 'decimal_latitude', 'decimal_longitude', 'position_source', 'voyage_id']) {
            expect(immutable, column).toContain(column);
        }
        expect(guard).toContain('NEW.observer_id := OLD.observer_id; NEW.created_at := OLD.created_at;');
        expect(guard).toContain(
            'IF NEW.vessel_owner_id IS DISTINCT FROM OLD.vessel_owner_id THEN IF NEW.vessel_owner_id IS NOT NULL THEN RAISE EXCEPTION',
        );
        expect(guard).toContain("IF NEW.visibility = 'crew' THEN NEW.visibility := 'private';");
    });

    it('takes species only from the catalogue, in the right group, and copies its names', () => {
        expect(guard).toContain('FROM public.sighting_taxa AS t WHERE t.scientific_name = NEW.scientific_name;');
        expect(guard).toContain('IF NOT FOUND OR taxon_group_found IS DISTINCT FROM NEW.taxon_group THEN');
        expect(guard).toContain('NEW.vernacular_name := taxon_vernacular;');
    });

    it('keeps ever_sensitive sticky and out of every client: once named threatened, always coarse', () => {
        expect(flat).toContain('ever_sensitive BOOLEAN NOT NULL DEFAULT false');
        expect(guard).toContain('NEW.created_at := now(); NEW.ever_sensitive := false;');
        expect(guard).toContain('NEW.ever_sensitive := OLD.ever_sensitive;');
        expect(guard).toContain('IF taxon_sensitive THEN NEW.ever_sensitive := true; END IF;');
        // Never false again once true: no other assignment.
        expect(guard.match(/NEW\.ever_sensitive :=/g)).toHaveLength(3);
        expect(SIGHTING_MUTABLE_COLUMNS as readonly string[]).not.toContain('ever_sensitive');
    });

    it('lets a row list only its own photos: <observer>/<this id>/<0-3>.jpg', () => {
        expect(guard).toContain("u.p !~ ('^' || NEW.observer_id::TEXT || '/' || NEW.id::TEXT || '/[0-3]\\.jpg$')");
    });

    it('is fenced for deleted accounts', () => {
        expect(flat).toContain(
            "CREATE TRIGGER account_deletion_write_fence BEFORE INSERT OR UPDATE ON public.sightings FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('observer_id')",
        );
        expect(flat).toContain(
            'REVOKE ALL ON FUNCTION public.sightings_before_write() FROM PUBLIC, anon, authenticated',
        );
    });
});

describe('the public read', () => {
    const rpc = flatten(fn('get_public_sightings'));

    it('is three hours late by server time AND event time', () => {
        expect(rpc).toContain("cutoff TIMESTAMPTZ := now() - INTERVAL '3 hours';");
        expect(rpc).toContain('AND s.created_at <= cutoff AND s.event_date <= cutoff');
        expect(rpc).toContain("WHERE s.visibility = 'public'");
    });

    it('shows a row only once its whole bucket is 3 h old, so the moment it appears says no more than its floored time', () => {
        expect(rpc).toContain('greatest(s.created_at, s.event_date) AS c_seen');
        expect(rpc).toContain("CASE WHEN c.c_coarse THEN INTERVAL '1 hour' ELSE INTERVAL '10 minutes' END AS c_bucket");
        expect(rpc).toContain(
            "WHERE date_bin(b.c_bucket, b.c_seen, TIMESTAMPTZ '2000-01-01 00:00:00+00') + b.c_bucket <= cutoff",
        );
    });

    it('tests the box on the fuzzed point; the raw coordinates only pre-filter one coarse cell wider', () => {
        expect(rpc).toContain('AND s.decimal_latitude BETWEEN p_south - 0.1 AND p_north + 0.1');
        expect(rpc).toContain('AND s.decimal_longitude BETWEEN p_west - 0.1 AND p_east + 0.1');
        expect(rpc).toContain('WHERE f.f_lat BETWEEN p_south AND p_north AND f.f_lon BETWEEN p_west AND p_east');
        expect(rpc).toContain('public.sighting_fuzz(b.c_lat, b.c_coarse) AS f_lat');
        expect(rpc).toContain('public.sighting_fuzz(b.c_lon, b.c_coarse) AS f_lon');
        // Pages on the floored time and the public id, never the exact time or the row id.
        expect(rpc).toContain('(f.f_time, f.f_id) < (p_before,');
        expect(rpc).toContain('ORDER BY f.f_time DESC, f.f_id DESC');
    });

    it('generalises threatened, once-threatened and every group-only row to 0.1 deg, the rest to 0.01 deg, and floors time', () => {
        expect(rpc).toContain(
            '(s.scientific_name IS NULL OR s.ever_sensitive OR COALESCE(t.sensitive, true)) AS c_coarse',
        );
        expect(flatten(fn('sighting_fuzz'))).toContain('CASE WHEN p_coarse THEN 0.1 ELSE 0.01 END');
        expect(rpc).toContain("WHEN b.c_coarse THEN date_trunc('hour', b.c_event, 'UTC')");
        expect(rpc).toContain("ELSE date_bin(INTERVAL '10 minutes', b.c_event,");
    });

    it('returns a per-precision id, never the row id, so a fine and a coarse copy of one sighting cannot be linked', () => {
        expect(rpc).toContain(
            "md5(b.c_id::TEXT || CASE WHEN b.c_coarse THEN ':coarse' ELSE ':fine' END)::UUID AS f_id",
        );
        expect(rpc).toMatch(/\)\s*SELECT f\.f_id,/);
        expect(rpc).not.toMatch(/SELECT f\.c_id,/);
    });

    it('returns no photos, remarks, observer, boat or voyage, and nothing to signed-out callers', () => {
        const returns = /RETURNS TABLE \(([^)]*)\)/.exec(rpc)?.[1] ?? '';
        expect(returns).not.toMatch(/photo|remark|observer|boat|voyage|display/);
        expect(rpc).toContain('IF auth.uid() IS NULL THEN RETURN;');
        expect(flat).toMatch(/REVOKE ALL ON FUNCTION public\.get_public_sightings\([^)]*\) FROM PUBLIC, anon;/);
        expect(flat).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_public_sightings\([^)]*\) TO authenticated;/);
    });

    it("credits only the observer's own enabled voyage-log handle, when they ticked it, and never on a coarse row", () => {
        expect(rpc).toContain(
            'WHEN f.c_credit AND NOT f.c_coarse THEN (SELECT cfg.handle FROM public.voyage_log_configs AS cfg WHERE cfg.owner_id = f.c_observer AND cfg.enabled AND cfg.handle IS NOT NULL',
        );
        expect(rpc.match(/cfg\.handle/g)).toHaveLength(2);
    });
});

describe('realtime and photos', () => {
    it('joins the realtime publication once, guarded', () => {
        expect(flat).toContain(
            "IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sightings') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.sightings;",
        );
    });

    it('keeps photos in a private 2 MB JPEG-only bucket, uploaded only into your own folder', () => {
        expect(flat).toContain(
            "VALUES ('sighting-photos', 'sighting-photos', false, 2097152, ARRAY['image/jpeg']::TEXT[])",
        );
        expect(flat).toContain('SET public = false,');
        const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
        expect(flat).toContain(
            `ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'sighting-photos' AND split_part(name, '/', 1) = auth.uid()::TEXT AND name ~ '^${uuid}/${uuid}/[0-3]\\.jpg$')`,
        );
        expect(flat).not.toMatch(/FOR UPDATE[^;]*sighting-photos/);
    });

    it("lets readers of a row open only that row's own photos", () => {
        expect(flat).toContain(
            "WHERE s.id = split_part(objects.name, '/', 2)::UUID AND s.observer_id = split_part(objects.name, '/', 1)::UUID AND objects.name = ANY (s.photo_paths)",
        );
        // The uuid casts sit behind a CASE, so a stray object name cannot error the policy.
        expect(flat).toMatch(/OR CASE WHEN name ~ '[^']+' THEN EXISTS \(SELECT 1 FROM public\.sightings AS s/);
    });
});

describe('account deletion reach and push order', () => {
    it('sorts after the live seabed migration, so a plain db push takes it', () => {
        const name = FILE.split('/').pop() as string;
        expect(name > '20261005130000_seabed_mapping.sql').toBe(true);
        expect(name > '20261005140000_vessel_crew_owner_pinned.sql').toBe(true);
    });

    it('does not redefine the deletion reach, so it can never drop a bucket a later migration added', () => {
        expect(code).not.toMatch(/FUNCTION public\.account_deletion_storage_inventory/);
        expect(code).not.toMatch(/FUNCTION public\.block_tombstoned_storage_write/);
    });

    it('relies on the newest deletion reach, which already lists sighting-photos', () => {
        const dir = 'supabase/migrations';
        for (const name of ['account_deletion_storage_inventory', 'block_tombstoned_storage_write']) {
            const newest = readdirSync(dir)
                .filter((f) => f.endsWith('.sql'))
                .sort()
                .map((f) => readFileSync(`${dir}/${f}`, 'utf8'))
                .filter((text) => text.includes(`CREATE OR REPLACE FUNCTION public.${name}(`))
                .pop() as string;
            expect(fn(name, newest), name).toContain("'sighting-photos'");
            expect(fn(name, newest), name).toContain("'seabed-soundings'");
        }
    });
});
