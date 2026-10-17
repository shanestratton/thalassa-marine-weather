/** Exact referenced production table/trigger bodies for the disposable lock graph.
 * Provider position transport remains explicitly synthetic in the outer fixture.
 * This does not claim that the entire presence/comfort migration was replayed. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = new URL('../../', import.meta.url);
const sources = {
    presence: 'supabase/migrations/20261017030921_boat_presence.sql',
    comfort: 'supabase/migrations/20261017050550_private_passage_comfort.sql',
    boats: 'supabase/migrations/20260516120000_voyage_log_boats.sql',
    durability: 'supabase/migrations/20260806120000_account_deletion_durability.sql',
};
function text(file) {
    return fs.readFileSync(new URL(file, root), 'utf8').replaceAll('\r\n', '\n');
}
function section(source, start, end) {
    const a = source.indexOf(start);
    assert.ok(a >= 0, start);
    const b = source.indexOf(end, a);
    assert.ok(b > a, end);
    return source.slice(a, b + end.length);
}
export function lightningRetirementFixture() {
    const p = text(sources.presence),
        c = text(sources.comfort),
        b = text(sources.boats),
        d = text(sources.durability);
    const blocks = ['CREATE SCHEMA private_presence;', 'CREATE SCHEMA private_comfort;'];
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
    // Use the current fail-closed fence function already loaded by bootstrap,
    // while retaining the exact production installation on every auth FK.
    blocks.push(section(d, 'DO $install_account_deletion_fences$', '$install_account_deletion_fences$;'));
    const hashes = Object.values(sources).map(
        (file) => `${file} sha256=${createHash('sha256').update(text(file)).digest('hex')}`,
    );
    return (
        '-- Exact production retirement dependency subsets; no full migration/provider claim.\n' +
        hashes.map((x) => '-- ' + x).join('\n') +
        '\n' +
        blocks.join('\n\n') +
        '\n'
    );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    assert.equal(process.argv.length, 3);
    assert.ok(['--write', '--check'].includes(process.argv[2]));
    const file = new URL('tests/sql/lightning-retirement142.sql', root);
    if (process.argv[2] === '--write') fs.writeFileSync(file, lightningRetirementFixture());
    else assert.equal(fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'), lightningRetirementFixture());
    process.stdout.write('Exact referenced production retirement fixture ' + process.argv[2] + '\n');
}
