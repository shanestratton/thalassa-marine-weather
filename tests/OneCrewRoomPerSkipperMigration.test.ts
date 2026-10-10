import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * One Crew Chat per skipper, held by the database (20261010154500).
 *
 * Build 125 finds the skipper's room by owner and reads it back after a
 * create, so two phones racing land in the oldest room. Nothing stopped a
 * second active private 👥 room per skipper, though: a build 102-124 phone, or
 * two creates that both miss the find, could still make one. A unique partial
 * index makes the second create fail with 23505, which crewChatRoom.ts treats
 * as "another phone made it" and reads the room back.
 *
 * The duplicate rooms of 2026-10-09 were already deleted by Shane; this file
 * deletes nothing. If any skipper still has two, it stops with a count.
 */

const MIGRATIONS_DIR = 'supabase/migrations';
const FILE = '20261010154500_one_crew_room_per_skipper.sql';
const INDEX = 'chat_channels_one_crew_room_per_owner';
const PREDICATE = "is_private and icon = '👥' and status = 'active'";

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase();
const codeOf = (relative: string): string =>
    read(relative)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

const migrationFiles = fs
    .readdirSync(path.join(process.cwd(), MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.sql'))
    .sort();

const header = fs.existsSync(path.join(process.cwd(), MIGRATIONS_DIR, FILE)) ? read(`${MIGRATIONS_DIR}/${FILE}`) : '';
const migration = squash(header.replace(/--.*$/gm, ''));

describe('one crew room per skipper (20261010154500)', () => {
    it('is stamped after the membership file and before the anon lockdown, which runs last', () => {
        expect(migrationFiles).toContain(FILE);
        expect(FILE > '20261010154000_chat_membership_question_and_crew_removal.sql').toBe(true);
        expect(FILE < '20261010155000').toBe(true);
    });

    it('builds a UNIQUE index on owner_id, partial on private, 👥 and active', () => {
        expect(migration).toContain(
            `create unique index if not exists ${INDEX} on public.chat_channels (owner_id) where ${PREDICATE};`,
        );
        // Only the one index; no CONCURRENTLY (the CLI applies a file in one transaction).
        expect(migration.match(/create (unique )?index/g)).toHaveLength(1);
        expect(migration).not.toContain('concurrently');
    });

    it('checks first and stops with a count rather than deleting anything', () => {
        const precheck = migration.slice(migration.indexOf('do $precheck$'), migration.indexOf('$precheck$;'));
        expect(precheck).toContain(
            `select count(*) into crowded from ( select owner_id from public.chat_channels where ${PREDICATE} and owner_id is not null group by owner_id having count(*) > 1 ) as owners;`,
        );
        expect(precheck).toContain(
            "if crowded > 0 then raise exception 'one crew room per skipper: % skipper(s) already have more than one active crew chat; nothing was deleted or changed', crowded;",
        );
        expect(migration.indexOf('do $precheck$')).toBeLessThan(migration.indexOf('create unique index'));
        expect(migration).not.toMatch(/\bdelete from\b/);
        expect(migration).not.toMatch(/\bupdate public\.chat_channels\b/);
        expect(migration).not.toMatch(/\bdrop (table|policy)\b/);
    });

    it('fails the push unless the index is unique, valid, partial and on owner_id alone', () => {
        const check = migration.slice(migration.indexOf('do $check$'));
        expect(check).toContain(`to_regclass('public.${INDEX}')`);
        expect(check).toContain('i.indisunique');
        expect(check).toContain('i.indisvalid');
        expect(check).toContain('i.indnatts = 1');
        expect(check).toContain('i.indpred is not null');
        expect(check).toContain("raise exception 'one crew room per skipper: % is missing or wrong'");
        expect(migration).not.toMatch(/(^|;)\s*(begin|commit)\s*;/);
        expect(migration).not.toContain('set local');
        expect(migration.startsWith("set lock_timeout = '5s';")).toBe(true);
        expect(migration.endsWith('reset lock_timeout;')).toBe(true);
    });

    it('matches the room the app finds and makes, and the app reads the room back on 23505', () => {
        const room = codeOf('services/crew/crewChatRoom.ts');
        const find = room.slice(room.indexOf('const find = () =>'), room.indexOf('const rooms ='));
        expect(find).toContain(".eq('owner_id', userId)");
        expect(find).toContain(".eq('is_private', true)");
        expect(find).toContain(".eq('status', 'active')");
        expect(find).toContain(".eq('icon', '👥')");
        const create = room.slice(room.indexOf(".from('chat_channels')\n                .insert("));
        expect(create.slice(0, 600)).toMatch(/icon: '👥',[\s\S]*is_private: true,[\s\S]*status: 'active'/);
        // The create's 23505 goes on to the read-back, and the code names the index.
        expect(read('services/crew/crewChatRoom.ts')).toContain(INDEX);
        expect(room).toMatch(/created\.error && field\(created\.error, 'code'\) !== '23505'/);
    });

    it('says in its header who authorised it, what older builds see, and how to undo it', () => {
        expect(header).toContain('"yes to db changes"');
        expect(header).toContain('Never pushed by an agent');
        expect(header).toContain('builds 102-124');
        expect(header).toContain('23505');
        expect(header).toContain(`DROP INDEX IF EXISTS public.${INDEX};`);
    });
});
