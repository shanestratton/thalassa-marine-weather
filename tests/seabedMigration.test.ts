/**
 * Seabed mapping migration (WRITTEN, NOT PUSHED): private by construction.
 *
 * Owner-only reads, no client write to the batch index, a bucket with no
 * storage policies, the anonymous id beyond the client's reach, the tombstone
 * fence on both tables, and the bucket inside the deletion reach. Plus a guard
 * for the trap two migrations in one day set: each redefines the deletion
 * reach in full, so the newest one must list every bucket any earlier one did.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ZONE_MAX_COUNT, ZONE_MAX_RADIUS_M, ZONE_MIN_RADIUS_M } from '../services/seabed/seabedCore';

const DIR = 'supabase/migrations';
const FILE = '20261005130000_seabed_mapping.sql';
const sql = readFileSync(`${DIR}/${FILE}`, 'utf8');
const code = sql.replace(/--.*$/gm, '');

function functionBody(text: string, fn: string): string | null {
    const at = text.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    if (at < 0) return null;
    const end = text.indexOf('$function$;', at);
    return text.slice(at, end < 0 ? undefined : end);
}

/** The buckets a deletion-reach body names: its `bucket_id IN (...)` lists and `bucket_id = '...'` branches. */
function bucketsIn(body: string): Set<string> {
    const out = new Set<string>();
    for (const list of body.matchAll(/bucket_id\s+IN\s*\(([^)]*)\)/g)) {
        for (const name of list[1].matchAll(/'([^']+)'/g)) out.add(name[1]);
    }
    for (const one of body.matchAll(/bucket_id\s*=\s*'([^']+)'/g)) out.add(one[1]);
    return out;
}

describe('seabed migration', () => {
    it('keeps both tables owner-only, with no client write to the batch index', () => {
        expect(code).toMatch(/ALTER TABLE public\.seabed_platforms ENABLE ROW LEVEL SECURITY/);
        expect(code).toMatch(/ALTER TABLE public\.seabed_batches ENABLE ROW LEVEL SECURITY/);
        expect(code).toMatch(/REVOKE ALL ON TABLE public\.seabed_batches FROM PUBLIC, anon, authenticated;/);
        expect(code).toMatch(/GRANT SELECT ON TABLE public\.seabed_batches TO authenticated;/);
        const batchPolicies = [...code.matchAll(/CREATE POLICY [^;]*ON public\.seabed_batches FOR (\w+)/g)].map(
            (m) => m[1],
        );
        expect(batchPolicies).toEqual(['SELECT']);
        for (const m of code.matchAll(/CREATE POLICY[^;]*ON public\.seabed_\w+ FOR SELECT[^;]*USING \(([^;]*)\);/g)) {
            expect(m[1].trim()).toBe('owner_id = auth.uid()');
        }
        expect(code).not.toMatch(/\bTO anon\b/);
    });

    it('lets only the boat owner create or change a platform, and never its anonymous id', () => {
        expect(code).toMatch(
            /FOR INSERT TO authenticated\s+WITH CHECK \(owner_id = auth\.uid\(\) AND public\.is_boat_owner\(boat_id\)\)/,
        );
        const update = /GRANT UPDATE \(([^)]*)\) ON public\.seabed_platforms/.exec(code)?.[1] ?? '';
        const insert = /GRANT INSERT \(([^)]*)\) ON public\.seabed_platforms/.exec(code)?.[1] ?? '';
        for (const col of ['csb_uuid', 'id', 'owner_id', 'boat_id'])
            expect(update).not.toMatch(new RegExp(`\\b${col}\\b`));
        for (const col of ['csb_uuid', 'id']) expect(insert).not.toMatch(new RegExp(`\\b${col}\\b`));
        expect(code).toMatch(/csb_uuid UUID NOT NULL UNIQUE DEFAULT gen_random_uuid\(\)/);
    });

    it('fences both tables against a deleted account and cascades with it', () => {
        for (const table of ['seabed_platforms', 'seabed_batches']) {
            expect(code).toMatch(
                new RegExp(
                    `BEFORE INSERT OR UPDATE ON public\\.${table}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.block_tombstoned_account_write\\('owner_id'\\)`,
                ),
            );
        }
        expect(
            (code.match(/owner_id UUID NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/g) ?? []).length,
        ).toBe(2);
    });

    it('makes a private bucket with no storage policy at all', () => {
        expect(code).toMatch(
            /VALUES \('seabed-soundings', 'seabed-soundings', false, 2097152, ARRAY\['application\/gzip'\]/,
        );
        expect(code).not.toMatch(/ON storage\.objects/);
    });

    it('holds every batch 30 days before it can be shared, and checks zones like the app does', () => {
        expect(code).toMatch(/CHECK \(eligible_after >= t_end \+ interval '30 days'\)/);
        expect(code).toContain(`WHEN jsonb_array_length(p_zones) > ${ZONE_MAX_COUNT} THEN false`);
        expect(code).toContain(`::DOUBLE PRECISION BETWEEN ${ZONE_MIN_RADIUS_M} AND ${ZONE_MAX_RADIUS_M}`);
        expect(code).toMatch(/CHECK \(public\.seabed_zones_valid\(privacy_zones\)\)/);
    });

    it('zones carry the jitter they were made with, and the circle never shrinks below 4/3 of it', () => {
        expect(code).toContain("ARRAY['id', 'kind', 'lat', 'lon', 'radius_m', 'jitter_m']");
        expect(code).toMatch(/\(SELECT count\(\*\) FROM jsonb_object_keys\(zone\.v\)\) <> 6/);
        expect(code).toContain(
            "3 * (zone.v ->> 'radius_m')::DOUBLE PRECISION >= 4 * (zone.v ->> 'jitter_m')::DOUBLE PRECISION",
        );
    });

    it('records when the logger last changed, beyond the client, for the one-logger rule', () => {
        expect(code).toMatch(/capture_changed_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
        expect(code).toMatch(/IF NEW\.capture_device_id IS DISTINCT FROM OLD\.capture_device_id THEN/);
        expect(code).toMatch(
            /BEFORE UPDATE ON public\.seabed_platforms\s+FOR EACH ROW EXECUTE FUNCTION public\.seabed_platforms_capture_changed\(\)/,
        );
        const update = /GRANT UPDATE \(([^)]*)\) ON public\.seabed_platforms/.exec(code)?.[1] ?? '';
        const insert = /GRANT INSERT \(([^)]*)\) ON public\.seabed_platforms/.exec(code)?.[1] ?? '';
        expect(update).not.toMatch(/capture_changed_at/);
        expect(insert).not.toMatch(/capture_changed_at/);
    });

    it('puts seabed-soundings inside the deletion reach and the tombstone storage fence', () => {
        for (const fn of ['account_deletion_storage_inventory', 'block_tombstoned_storage_write']) {
            const body = functionBody(sql, fn);
            expect(body, fn).not.toBeNull();
            expect(bucketsIn(body as string).has('seabed-soundings')).toBe(true);
        }
    });

    it('the superset check below would fire if a later definition dropped seabed-soundings', () => {
        const ours = functionBody(sql, 'account_deletion_storage_inventory') as string;
        const regressed = bucketsIn(ours.replace("'seabed-soundings'", "'x'"));
        expect([...bucketsIn(ours)].filter((b) => !regressed.has(b))).toEqual(['seabed-soundings']);
    });

    it('the newest deletion-reach definition lists every bucket any earlier migration listed', () => {
        const files = readdirSync(DIR)
            .filter((f) => f.endsWith('.sql'))
            .sort();
        for (const fn of ['account_deletion_storage_inventory', 'block_tombstoned_storage_write']) {
            const defs = files
                .map((f) => ({ f, body: functionBody(readFileSync(`${DIR}/${f}`, 'utf8'), fn) }))
                .filter((d): d is { f: string; body: string } => d.body !== null);
            const newest = defs[defs.length - 1];
            const kept = bucketsIn(newest.body);
            for (const earlier of defs.slice(0, -1)) {
                for (const bucket of bucketsIn(earlier.body)) {
                    expect(kept.has(bucket), `${newest.f} drops ${bucket} that ${earlier.f} listed (${fn})`).toBe(true);
                }
            }
        }
    });
});
