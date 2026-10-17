/** Exact production retirement dependencies; no whole-migration/provider replay claim. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = new URL('../../', import.meta.url);
function text(path) {
    return fs.readFileSync(new URL(path, root), 'utf8').replaceAll('\r\n', '\n');
}
function section(source, start, end) {
    const a = source.indexOf(start),
        b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, start);
    return source.slice(a, b + end.length);
}
export function crowdRetirementFixture() {
    const sources = [
        'supabase/migrations/20261017030921_boat_presence.sql',
        'supabase/migrations/20261017050550_private_passage_comfort.sql',
        'supabase/migrations/20260516120000_voyage_log_boats.sql',
        'supabase/migrations/20260806120000_account_deletion_durability.sql',
    ];
    const [p, c, b, a] = sources.map(text),
        blocks = [
            section(
                a,
                'CREATE OR REPLACE FUNCTION public.block_tombstoned_account_write()',
                'REVOKE ALL ON FUNCTION public.block_tombstoned_account_write() FROM PUBLIC, anon, authenticated;',
            ),
            section(a, 'DO $install_account_deletion_fences$', '$install_account_deletion_fences$;'),
            'CREATE SCHEMA private_presence;',
            'CREATE SCHEMA private_comfort;',
        ];
    for (const name of ['boat_presence', 'samples', 'friend_invites', 'friends'])
        blocks.push(section(p, `CREATE TABLE private_presence.${name} (`, '\n);'));
    for (const name of ['contexts', 'cohorts'])
        blocks.push(section(c, `CREATE TABLE private_comfort.${name}(`, '\n);'));
    for (const name of ['lock_only', 'retire_owner', 'boat_changed'])
        blocks.push(section(p, `CREATE FUNCTION private_presence.${name}(`, 'END $$;'));
    blocks.push(section(p, 'CREATE TRIGGER presence_boat_retirement ', 'private_presence.boat_changed();'));
    blocks.push(section(c, 'CREATE FUNCTION private_comfort.boat_retired()', 'END $$;'));
    blocks.push(section(c, 'CREATE TRIGGER comfort_boat_retirement ', 'private_comfort.boat_retired();'));
    blocks.push('ALTER TABLE public.boats ENABLE ROW LEVEL SECURITY;');
    blocks.push(section(b, 'CREATE POLICY "Owners manage their boats"', 'WITH CHECK (auth.uid() = owner_id);'));
    return (
        '-- Exact referenced presence/comfort/boat-RLS subsets.\n' +
        sources
            .map((path) => '-- ' + path + ' sha256=' + createHash('sha256').update(text(path)).digest('hex'))
            .join('\n') +
        '\n' +
        blocks.join('\n\n') +
        '\n'
    );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const path = new URL('tests/sql/crowd-retirement142.sql', root),
        expected = crowdRetirementFixture();
    assert.ok(process.argv.length === 3 && ['--write', '--check'].includes(process.argv[2]));
    if (process.argv[2] === '--write') fs.writeFileSync(path, expected);
    else assert.equal(fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n'), expected);
}
