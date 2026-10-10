import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * anon keeps only what a policy gives it (20261010155000).
 *
 * The public (anon) key ships inside the app. On 2026-10-09 anon still held
 * full table privileges (DML, TRUNCATE, REFERENCES, TRIGGER) on the chat
 * tables, vessel_crew, guardian_profiles, push_notification_queue and many
 * more, and the default privileges handed it every privilege on each new
 * table. Row Level Security was the only thing in the way; one dropped or
 * drifted policy (the lockdown found four) turns a grant into a hole.
 *
 * The file revokes everything from anon and PUBLIC on every relation in
 * public that is not an extension's, grants back SELECT on the tables whose
 * policies give anon rows today, and changes the default privileges so a new
 * table gives anon nothing unless a migration grants it.
 *
 * The allowlist must be exactly what the policies give anon. These checks
 * recompute it from every migration's policies in order, so a future policy
 * for signed-out readers that the allowlist forgot fails here, not on a phone.
 */

const MIGRATIONS_DIR = 'supabase/migrations';
const FILE = '20261010155000_anon_privileges_lockdown.sql';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const sqlOf = (relative: string): string => read(relative).replace(/--.*$/gm, '');
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase();

const migrationFiles = fs
    .readdirSync(path.join(process.cwd(), MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.sql'))
    .sort();

const header = fs.existsSync(path.join(process.cwd(), MIGRATIONS_DIR, FILE)) ? read(`${MIGRATIONS_DIR}/${FILE}`) : '';
const migration = squash(header.replace(/--.*$/gm, ''));

const AUTH = /auth\.(uid|role|jwt)\(\)/;

interface Policy {
    table: string;
    name: string;
    statement: string;
}

/** Every policy in public after every migration in order (DROP POLICY and DROP TABLE remove). */
function finalPolicies(): Policy[] {
    const policies = new Map<string, Policy>();
    const statement =
        /(create|drop) policy (?:if exists )?(?:"([^"]+)"|([a-z0-9_]+)) on (?:(public|storage)\.)?"?([a-z0-9_]+)"?\b[^;]*;/g;
    for (const file of migrationFiles) {
        const sql = squash(sqlOf(`${MIGRATIONS_DIR}/${file}`));
        for (const match of sql.matchAll(/drop table (?:if exists )?(?:public\.)?"?([a-z0-9_]+)"?/g)) {
            for (const [key, policy] of policies) if (policy.table === match[1]) policies.delete(key);
        }
        for (const match of sql.matchAll(statement)) {
            const [whole, verb, quoted, bare, schema, table] = match;
            if (schema === 'storage') continue;
            const name = quoted ?? bare;
            const key = `${table}|${name}`;
            if (verb === 'drop') policies.delete(key);
            else policies.set(key, { table, name, statement: whole });
        }
    }
    return [...policies.values()];
}

/** The newest body of every public function, to tell an auth.uid()-gated helper from an open one. */
function functionBodies(): Map<string, string> {
    const bodies = new Map<string, string>();
    for (const file of migrationFiles) {
        const sql = squash(sqlOf(`${MIGRATIONS_DIR}/${file}`));
        for (const match of sql.matchAll(
            /create (?:or replace )?function (?:public\.)?([a-z0-9_]+)\([\s\S]*? as (\$[a-z_]*\$)([\s\S]*?)\2/g,
        )) {
            bodies.set(match[1], match[3]);
        }
    }
    return bodies;
}

/**
 * The (table, command) pairs anon can actually use: a policy for anon or
 * PUBLIC with a branch (split on OR at any depth, as the file's own pre-check
 * splits it) that neither asks who is signed in nor calls a helper that does.
 */
function anonPolicyGrants(): string[] {
    const bodies = functionBodies();
    const gated = (branch: string): boolean => {
        if (AUTH.test(branch)) return true;
        for (const call of branch.matchAll(/([a-z_][a-z0-9_]*)\s*\(/g)) {
            if (AUTH.test(bodies.get(call[1]) ?? '')) return true;
        }
        return false;
    };
    const pairs = new Set<string>();
    for (const policy of finalPolicies()) {
        const to = policy.statement.match(/ to ([a-z_, ]+?) (?:using|with check)\b/);
        const roles = to ? to[1].split(',').map((role) => role.trim()) : ['public'];
        if (!roles.some((role) => role === 'anon' || role === 'public')) continue;
        const command = policy.statement.match(/ for (select|insert|update|delete|all)\b/)?.[1] ?? 'all';
        const expressions = policy.statement.slice(policy.statement.search(/ (using|with check) /));
        const open = expressions
            .split(/\bor\b/)
            .filter((branch) => branch.replace(/[\s()]/g, '').length > 0)
            .some((branch) => !gated(branch));
        if (open) pairs.add(`${policy.table}:${command}`);
    }
    return [...pairs].sort();
}

/** Each `allowlist CONSTANT TEXT[] := ARRAY[...]` in the file, as a sorted list. */
function allowlistsInFile(): string[][] {
    return [...migration.matchAll(/allowlist constant text\[\] := array\[([^\]]*)\]/g)].map((match) =>
        [...match[1].matchAll(/'([a-z0-9_]+)'/g)].map((name) => name[1]).sort(),
    );
}

describe('anon privileges lockdown (20261010155000)', () => {
    it('is stamped last among the 126 files, after every table they create', () => {
        expect(migrationFiles).toContain(FILE);
        expect(FILE > '20261010154500_one_crew_room_per_skipper.sql').toBe(true);
        // 126-11a's stores_boxes (20261010153000) and every earlier 126 file sort before it.
        expect(FILE > '20261010153000').toBe(true);
        for (const file of migrationFiles.filter((name) => name.startsWith('20261010') && name !== FILE)) {
            expect(file < FILE, file).toBe(true);
        }
    });

    it('keeps for anon exactly the reads the policies give it: the allowlist equals the policies', () => {
        const fromPolicies = anonPolicyGrants();
        // Every open policy for signed-out readers is a SELECT; nothing lets anon write.
        expect(fromPolicies.every((pair) => pair.endsWith(':select'))).toBe(true);
        const tables = fromPolicies.map((pair) => pair.split(':')[0]).sort();
        expect(tables).toEqual([
            'amsa_register',
            'australian_ports',
            'community_recipes',
            'recipe_ratings',
            'vessel_metadata',
            'wx_point_forecasts',
        ]);
        // The pre-check, the grant and the self-check all carry the same list.
        const lists = allowlistsInFile();
        expect(lists).toHaveLength(3);
        for (const list of lists) expect(list).toEqual(tables);
        // ... and grant it back as SELECT only, table-level.
        expect(migration).toContain("execute format('grant select on table public.%i to anon', relation);");
        expect(migration).not.toMatch(/grant (insert|update|delete|all|truncate)[^;]* to [^;]*\banon\b/);
    });

    it('takes everything from anon and PUBLIC on every non-extension relation, at table AND column level', () => {
        const revoke = migration.slice(migration.indexOf('do $revoke$'), migration.indexOf('$revoke$;'));
        // Every table, partitioned table, view, materialized view, foreign table and sequence in public ...
        expect(revoke).toContain("c.relnamespace = 'public'::regnamespace");
        expect(revoke).toContain("c.relkind in ('r', 'p', 'v', 'm', 'f', 's')");
        // ... except an extension's own (PostGIS's views and spatial_ref_sys stay as the extension made them).
        expect(revoke).toContain(
            "not exists ( select 1 from pg_depend as d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e' )",
        );
        expect(revoke).toContain("execute format('revoke all on sequence %s from public, anon', rel.name);");
        expect(revoke).toContain("execute format('revoke all on table %s from public, anon', rel.name);");
        expect(revoke).toContain(
            "execute format('revoke all (%i) on table %s from public, anon', col.attname, rel.name);",
        );
        // What PUBLIC held moves to authenticated and the service role first, so neither loses a read.
        expect(revoke).toContain('to authenticated, service_role');
        expect(revoke.indexOf('to authenticated, service_role')).toBeLessThan(
            revoke.indexOf("'revoke all on table %s from public, anon'"),
        );
    });

    it('takes TRUNCATE, REFERENCES and TRIGGER (and MAINTAIN on 17+) from authenticated app-wide', () => {
        const revoke = migration.slice(migration.indexOf('do $revoke$'), migration.indexOf('$revoke$;'));
        expect(revoke).toContain(
            "execute format('revoke truncate, references, trigger on table %s from authenticated', rel.name);",
        );
        expect(revoke).toContain(
            "execute format('revoke references (%i) on table %s from authenticated', col.attname, rel.name);",
        );
        expect(revoke).toContain("current_setting('server_version_num')::int >= 170000");
        expect(revoke).toContain("execute format('revoke maintain on table %s from authenticated', rel.name);");
        // authenticated keeps everything PostgREST uses: nothing else is revoked from it.
        expect(migration).not.toMatch(/revoke (all|select|insert|update|delete)[^;]* from [^;]*authenticated/);
    });

    it('changes the default privileges for TABLES and SEQUENCES, not FUNCTIONS', () => {
        expect(migration).toContain(
            'alter default privileges for role postgres in schema public revoke all on tables from public, anon;',
        );
        expect(migration).toContain(
            'alter default privileges for role postgres in schema public revoke all on sequences from public, anon;',
        );
        expect(migration).toContain(
            'alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from authenticated;',
        );
        expect(migration).toContain(
            "execute 'alter default privileges for role postgres in schema public revoke maintain on tables from authenticated';",
        );
        expect(migration).not.toMatch(/alter default privileges[^;']* on (functions|routines|types|schemas)/);
        // Functions are out of this build, and the header says why.
        expect(header).toContain('Functions are not in this file');
        expect(migration).not.toMatch(/(revoke|grant) [^;]* on (all )?functions? /);
    });

    it('stops before changing anything if a signed-out read or write would be lost', () => {
        const precheck = migration.slice(migration.indexOf('do $precheck$'), migration.indexOf('$precheck$;'));
        expect(migration.indexOf('do $precheck$')).toBeLessThan(migration.indexOf('do $revoke$'));
        // Policies anon or PUBLIC can use, split on OR, gated by auth.* or a helper that asks it.
        expect(precheck).toContain("p.roles && array['anon', 'public']::name[]");
        expect(precheck).toContain("regexp_split_to_table(lower(e.expr), '\\yor\\y')");
        expect(precheck).toContain("b.branch ~ 'auth\\.(uid|role|jwt)\\(\\)'");
        expect(precheck).toContain("pr.prosrc ~ 'auth\\.(uid|role|jwt)\\(\\)'");
        // RLS-off tables, definer views, materialized views and foreign tables give anon rows with no policy.
        expect(precheck).toContain("r.relkind in ('r', 'p') and not r.relrowsecurity");
        expect(precheck).toContain('security_invoker=(true|on|yes|1)');
        expect(precheck).toContain(
            "raise exception 'anon privileges lockdown: this would take away a signed-out read or write; nothing changed: %'",
        );
    });

    it('fails the push unless anon, authenticated and the defaults end exactly as stated, and can be re-run', () => {
        const check = migration.slice(migration.indexOf('do $check$'));
        expect(check).toContain("raise exception 'anon privileges lockdown: anon still holds %'");
        expect(check).toContain("raise exception 'anon privileges lockdown: anon lost a signed-out read: %'");
        expect(check).toContain("raise exception 'anon privileges lockdown: authenticated still holds %'");
        expect(check).toContain("raise exception 'anon privileges lockdown: default privileges still give %'");
        expect(check).toContain('has_any_column_privilege(');
        expect(check).toContain('has_sequence_privilege(');
        expect(migration).not.toMatch(/(^|;)\s*(begin|commit)\s*;/);
        expect(migration).not.toContain('set local');
        expect(migration.startsWith("set lock_timeout = '5s';")).toBe(true);
        expect(migration.endsWith('reset lock_timeout;')).toBe(true);
    });

    it('says in its header who authorised it, what Codex needs to know, and how to undo it', () => {
        expect(header).toContain('"yes to db changes"');
        expect(header).toContain('Never pushed by an agent');
        expect(header).toContain('Codex');
        expect(header).toContain('Undo');
        expect(header).toContain('supabase_admin');
    });

    it("says plainly what it leaves open: PostGIS's spatial_ref_sys, and the follow-up", () => {
        const prose = header.replace(/^--\s?/gm, '').replace(/\s+/g, ' ');
        const notHere = prose.slice(prose.indexOf('Not here'), prose.indexOf('For Codex'));
        expect(notHere).toContain('spatial_ref_sys has RLS off');
        expect(notHere).toContain('anon may still hold INSERT, UPDATE, DELETE and TRUNCATE on it');
        expect(notHere).toContain("the pre-flight's extension_members_anon");
        expect(notHere).toContain('move PostGIS to the extensions schema');
        // Not a claim the file cannot keep.
        expect(prose).not.toContain('keep the privileges the extension set');
    });
});
