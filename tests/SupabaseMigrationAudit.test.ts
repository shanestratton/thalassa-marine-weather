// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = resolve('scripts/audit-supabase-migrations.mjs');
const definition = (name: string, args = 'boat uuid', replace = false, pinned = true) =>
    `CREATE ${replace ? 'OR REPLACE ' : ''}FUNCTION ${name}(${args}) RETURNS integer LANGUAGE sql SECURITY DEFINER ${pinned ? "SET search_path=''" : ''} AS $$ SELECT 1 $$;`;
function audit(...migrations: string[]) {
    const temporaryRoot = resolve(tmpdir());
    const root = mkdtempSync(join(temporaryRoot, 'thalassa-migration-audit-'));
    if (!resolve(root).startsWith(temporaryRoot + sep)) throw new Error('Unexpected fixture directory');
    try {
        mkdirSync(join(root, 'supabase/migrations'), { recursive: true });
        migrations.forEach((sql, index) =>
            writeFileSync(join(root, 'supabase/migrations', `2026101700000${index}_fixture.sql`), sql),
        );
        const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
        return { status: result.status, output: result.stdout + result.stderr };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

describe('migration definer ACL audit', () => {
    it('refuses a new public or private definer with inherited PUBLIC execution', () => {
        for (const name of ['public.inspect', 'private_watch.inspect']) {
            const result = audit(definition(name));
            expect(result.status).toBe(1);
            expect(result.output).toContain(name + '() is SECURITY DEFINER with no REVOKE/GRANT');
        }
    });

    it('accepts deliberate signature-free public grants and same-schema blanket revokes', () => {
        expect(
            audit(definition('public.inspect') + ' GRANT EXECUTE ON FUNCTION public.inspect TO authenticated;').status,
        ).toBe(0);
        expect(
            audit(
                definition('private_watch.inspect') +
                    ' REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_watch FROM PUBLIC,anon,authenticated;',
            ).status,
        ).toBe(0);
    });

    it('never credits a grant or blanket revoke for another schema', () => {
        for (const acl of [
            'GRANT EXECUTE ON FUNCTION private_other.inspect(uuid) TO authenticated;',
            'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_other FROM PUBLIC,anon,authenticated;',
        ])
            expect(audit(definition('private_watch.inspect') + acl).status).toBe(1);
        expect(
            audit(
                definition('public.inspect') +
                    ' GRANT EXECUTE ON FUNCTION private_other.inspect(uuid) TO authenticated;',
            ).status,
        ).toBe(1);
    });

    it('recognizes a replacement retaining the previously audited exact overload ACL', () => {
        const original =
            definition('private_watch.inspect') +
            ' REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_watch FROM PUBLIC,anon,authenticated;';
        expect(audit(original, definition('private_watch.inspect', 'boat uuid', true)).status).toBe(0);
        expect(audit(original, definition('private_watch.inspect', 'boat uuid, extra text', true)).status).toBe(1);
    });

    it('requires a new ACL after a function or schema was dropped', () => {
        const original =
            definition('private_watch.inspect') + ' REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_watch FROM PUBLIC;';
        for (const drop of ['DROP FUNCTION private_watch.inspect(uuid);', 'DROP SCHEMA private_watch CASCADE;']) {
            expect(audit(original, drop + definition('private_watch.inspect', 'boat uuid', true)).status).toBe(1);
        }
    });

    it('still requires a pinned search path on a replacement with preserved ACL', () => {
        const original =
            definition('private_watch.inspect') + ' REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_watch FROM PUBLIC;';
        const result = audit(original, definition('private_watch.inspect', 'boat uuid', true, false));
        expect(result.status).toBe(1);
        expect(result.output).toContain('without SET search_path');
    });
});
