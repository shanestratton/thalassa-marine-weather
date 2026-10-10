import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The membership question, and crew removal leaving Crew Chat (20261010154000).
 *
 * can_access_chat_channel(check_channel, check_user), is_chat_moderator(check_user)
 * and is_chat_admin(check_user) run as their owner and answered for ANY
 * check_user, and every signed-in account may execute them. So any account
 * could ask "is this other person in that private crew room?" or "who are the
 * moderators?" by RPC. Every policy and function passes auth.uid(), so the
 * guard costs them nothing.
 *
 * And nothing removed channel_members when a crew membership ended: a crew
 * member the skipper removed (or who left, or whose crew was disbanded) kept
 * reading, posting and getting notifications in the boat's Crew Chat.
 *
 * Nothing behavioural shows either regression, so these checks are static:
 * they pin the newest definition of each function after every migration in
 * order, the trigger, the one-off sweep and the self-check. The rolled-back
 * live rehearsal is the real-environment proof.
 */

const MIGRATIONS_DIR = 'supabase/migrations';
const FILE = '20261010154000_chat_membership_question_and_crew_removal.sql';
const HELPERS = ['can_access_chat_channel', 'is_chat_moderator', 'is_chat_admin'] as const;

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const sqlOf = (relative: string): string => read(relative).replace(/--.*$/gm, '');
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase();

const migrationFiles = fs
    .readdirSync(path.join(process.cwd(), MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.sql'))
    .sort();

const header = fs.existsSync(path.join(process.cwd(), MIGRATIONS_DIR, FILE)) ? read(`${MIGRATIONS_DIR}/${FILE}`) : '';
const migration = squash(header.replace(/--.*$/gm, ''));

/** A function's definition in one file (comments dropped, squashed): its header (before AS) and its body. */
function definitionIn(file: string, fn: string): { file: string; header: string; body: string } | null {
    const create = new RegExp(String.raw`create (?:or replace )?function public\.${fn}\(`);
    const sql = squash(sqlOf(`${MIGRATIONS_DIR}/${file}`));
    const at = sql.search(create);
    if (at < 0) return null;
    const rest = sql.slice(at);
    const open = rest.match(/ as (\$[a-z_]*\$)/) as RegExpMatchArray;
    const bodyStart = (open.index as number) + open[0].length;
    return {
        file,
        header: rest.slice(0, open.index),
        body: rest.slice(bodyStart, rest.indexOf(open[1], bodyStart)),
    };
}

/** The newest definition of a function after every migration: the file, its header (before AS) and its body. */
function latestDefinition(fn: string): { file: string; header: string; body: string } {
    for (const file of [...migrationFiles].reverse()) {
        const found = definitionIn(file, fn);
        if (found) return found;
    }
    throw new Error(`no migration defines public.${fn}`);
}

/** A function's body exactly as the file sends it (what pg_proc.prosrc holds), comments and all. */
function rawBody(file: string, fn: string): string {
    const text = read(`${MIGRATIONS_DIR}/${file}`);
    const at = text.search(new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${fn}\(`));
    expect(at, `${file} defines ${fn}`).toBeGreaterThanOrEqual(0);
    const open = text.indexOf('AS $$', at) + 'AS $$'.length;
    return text.slice(open, text.indexOf('$$', open));
}

/** The drift guard's fingerprint: md5 of the body with every run of whitespace squashed to one space. */
const fingerprint = (body: string): string =>
    crypto.createHash('md5').update(body.replace(/\s+/g, ' ').trim(), 'utf8').digest('hex');

/** The turn each skipper's crew changes take (forget_crew_chat_membership and join_accepted_crew_channels). */
const TURN = (owner: string): string =>
    `perform pg_advisory_xact_lock(hashtextextended('crew_chat_membership:' || ${owner}::text, 0));`;

/** Every call `name(...)` in a text, with its argument list (balanced parentheses). */
function callsOf(text: string, name: string): string[] {
    const calls: string[] = [];
    const pattern = new RegExp(String.raw`\b${name}\(`, 'g');
    for (const match of text.matchAll(pattern)) {
        let depth = 0;
        const start = (match.index as number) + match[0].length;
        for (let i = start - 1; i < text.length; i += 1) {
            if (text[i] === '(') depth += 1;
            if (text[i] === ')') depth -= 1;
            if (depth === 0) {
                calls.push(text.slice(start, i).trim());
                break;
            }
        }
    }
    return calls;
}

/** The guard each helper must open with: about yourself, the service role, or a direct database session. */
const SELF_FIRST = 'case when check_user is not distinct from auth.uid()';
const SERVICE = "or auth.role() = 'service_role'";
const DIRECT =
    "or (session_user <> 'authenticator' and coalesce(current_setting('role', true), 'none') not in ('anon', 'authenticated'))";

describe('the membership question and crew removal (20261010154000)', () => {
    it('is stamped after the newest live migration and every 126 file before it, and before the other two', () => {
        expect(migrationFiles).toContain(FILE);
        // Live's newest on 2026-10-09 was 20261009172000; 126-11a's stores_boxes is 20261010153000.
        expect(FILE > '20261009172000').toBe(true);
        expect(FILE > '20261010153000').toBe(true);
        expect(FILE < '20261010154500').toBe(true);
        expect(FILE < '20261010155000').toBe(true);
    });

    it('says in its header who authorised it, what it changes, and how to undo it', () => {
        expect(header).toContain('"yes to db changes"');
        expect(header).toContain('"ok,  start on 126?"');
        expect(header).toContain('Undo');
        expect(header).toContain('Never pushed by an agent');
        expect(header.replace(/^--\s?/gm, '').replace(/\s+/g, ' ')).toContain(
            'recreate join_accepted_crew_channels as 20260723090000 wrote it',
        );
        // fictional data only: no address, no account id
        expect(header).not.toMatch(/@(?!example\.invalid)[a-z0-9-]+\.[a-z]/i);
        expect(header).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });

    it.each(HELPERS)(
        '%s: the newest definition answers only about yourself, the service role or a direct session',
        (fn) => {
            const { file, header: head, body } = latestDefinition(fn);
            expect(file).toBe(FILE);
            // Same signature, still a stable SECURITY DEFINER with its search_path pinned.
            if (fn === 'can_access_chat_channel') {
                expect(head).toMatch(/\(\s*check_channel uuid, check_user uuid default auth\.uid\(\) \)/);
            } else {
                expect(head).toContain(`${fn}(check_user uuid default auth.uid())`);
            }
            expect(head).toContain('returns boolean');
            expect(head).toContain('language sql');
            expect(head).toContain('stable');
            expect(head).toContain('security definer');
            expect(head).toContain('set search_path = public');

            // The guard: cheap self-check first, then the service role, then a
            // direct database session that has not taken an API role.
            expect(body.trim().startsWith(`select ${SELF_FIRST}`)).toBe(true);
            const self = body.indexOf(SELF_FIRST);
            const service = body.indexOf(SERVICE);
            const direct = body.indexOf(DIRECT);
            expect(self).toBeGreaterThanOrEqual(0);
            expect(service).toBeGreaterThan(self);
            expect(direct).toBeGreaterThan(service);
            // Anyone else gets false, and nothing ever raises inside a policy.
            expect(body).toMatch(/ else false end;?\s*$/);
            expect(body).not.toContain('raise');
        },
    );

    it('can_access_chat_channel also answers a chat moderator, and keeps every access rule', () => {
        const { body } = latestDefinition('can_access_chat_channel');
        const guard = body.slice(0, body.indexOf(' then '));
        expect(guard).toContain(`${DIRECT} or public.is_chat_moderator(auth.uid())`);
        const answer = body.slice(body.indexOf(' then '));
        expect(answer).toContain('where c.id = check_channel');
        expect(answer).toContain('not coalesce(c.is_private, false)');
        expect(answer).toContain('or c.owner_id = check_user');
        expect(answer).toContain('where cm.channel_id = c.id and cm.user_id = check_user');
        // A moderator asking about someone else gets the exact answer: the
        // moderator test of check_user is inline, not through the guarded helper.
        expect(answer).toContain(
            "from public.chat_roles r where r.user_id = check_user and r.role in ('admin', 'moderator') and not coalesce(r.is_blocked, false)",
        );
        expect(answer).not.toContain('is_chat_moderator(check_user)');
    });

    it('is_chat_moderator and is_chat_admin have no moderator branch, and keep their role tests', () => {
        for (const fn of ['is_chat_moderator', 'is_chat_admin'] as const) {
            const { body } = latestDefinition(fn);
            expect(body, fn).not.toContain('is_chat_moderator(');
            expect(body, fn).not.toContain('is_chat_admin(');
            expect(body, fn).toContain('where user_id = check_user');
            expect(body, fn).toContain('and not coalesce(is_blocked, false)');
        }
        expect(latestDefinition('is_chat_moderator').body).toContain("and role in ('admin', 'moderator')");
        expect(latestDefinition('is_chat_admin').body).toContain("and role = 'admin'");
    });

    it('keeps EXECUTE for authenticated and the service role only', () => {
        expect(migration).toContain('revoke all on function public.is_chat_moderator(uuid) from public, anon;');
        expect(migration).toContain('revoke all on function public.is_chat_admin(uuid) from public, anon;');
        expect(migration).toContain(
            'revoke all on function public.can_access_chat_channel(uuid, uuid) from public, anon;',
        );
        expect(migration).toContain(
            'grant execute on function public.is_chat_moderator(uuid) to authenticated, service_role;',
        );
        expect(migration).toContain(
            'grant execute on function public.is_chat_admin(uuid) to authenticated, service_role;',
        );
        expect(migration).toContain(
            'grant execute on function public.can_access_chat_channel(uuid, uuid) to authenticated, service_role;',
        );
    });

    it('costs no caller anything: every policy and function asks about auth.uid(), and no app code asks by RPC', () => {
        for (const file of migrationFiles) {
            const sql = squash(sqlOf(`${MIGRATIONS_DIR}/${file}`));
            for (const fn of HELPERS) {
                for (const args of callsOf(sql, fn)) {
                    // The definitions themselves, and the guarded bodies' own self-call.
                    if (/check_user uuid default auth\.uid\(\)/.test(args)) continue;
                    if (/^uuid(,\s*uuid)?$/.test(args)) continue; // REVOKE/GRANT signatures
                    const user = fn === 'can_access_chat_channel' ? args.split(',').slice(1).join(',').trim() : args;
                    if (file === FILE || file === '20260723090000_security_hardening_core.sql') {
                        // Inside the helpers: check_user is the argument being guarded.
                        if (user === 'check_user') continue;
                    }
                    expect(user, `${file}: ${fn}(${args})`).toBe('auth.uid()');
                }
            }
        }
        const clientDirs = [
            'services',
            'components',
            'hooks',
            'context',
            'utils',
            'pages',
            'src',
            'supabase/functions',
        ];
        const offenders: string[] = [];
        const walk = (relative: string): void => {
            const absolute = path.join(process.cwd(), relative);
            if (!fs.existsSync(absolute)) return;
            for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
                const child = `${relative}/${entry.name}`;
                if (entry.isDirectory()) walk(child);
                else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
                    const code = read(child);
                    if (/\.rpc\(\s*['"](can_access_chat_channel|is_chat_moderator|is_chat_admin)['"]/.test(code)) {
                        offenders.push(child);
                    }
                }
            }
        };
        clientDirs.forEach(walk);
        expect(offenders).toEqual([]);
    });

    it('forget_crew_chat_membership: a guarded, never-raising trigger on the end of an accepted membership', () => {
        const { file, header: head, body } = latestDefinition('forget_crew_chat_membership');
        expect(file).toBe(FILE);
        expect(head).toContain('returns trigger');
        expect(head).toContain('language plpgsql');
        expect(head).toContain('security definer');
        expect(head).toContain('set search_path = pg_catalog, public, pg_temp');

        // Only the end of an ACCEPTED membership; an Accept or an untouched pair returns at once.
        expect(body).toContain(
            "if old.crew_user_id is null or old.owner_id is null or old.status is distinct from 'accepted' then return null; end if;",
        );
        expect(body).toContain(
            "if tg_op = 'update' then if new.status = 'accepted' and new.crew_user_id = old.crew_user_id and new.owner_id = old.owner_id then return null; end if; end if;",
        );
        // One skipper's crew changes take turns before the "another accepted row
        // remains" test: two of a pair's rows deleted in parallel transactions
        // (Leave on a boat with a passage row) would each still see the other's
        // row and both keep the membership. Inside the exception block, after
        // the cheap returns.
        const turn = TURN('old.owner_id');
        expect(body).toContain(turn);
        expect(body.split(turn)).toHaveLength(2);
        expect(body.indexOf(turn)).toBeGreaterThan(body.indexOf("if tg_op = 'update' then"));
        expect(body.indexOf(turn)).toBeLessThan(body.indexOf('if exists ('));
        expect(body.trim().startsWith('begin begin ')).toBe(true);
        // Another accepted row for the same skipper and person (per-passage rows) keeps them in.
        expect(body).toContain(
            "if exists ( select 1 from public.vessel_crew as m where m.owner_id = old.owner_id and m.crew_user_id = old.crew_user_id and m.status = 'accepted' ) then return null; end if;",
        );
        // Only that person's rows, only in that skipper's private 👥 rooms, never the owner's own row.
        expect(body).toContain(
            "delete from public.channel_members as cm using public.chat_channels as c where cm.channel_id = c.id and cm.user_id = old.crew_user_id and c.owner_id = old.owner_id and c.is_private and c.icon = '👥' and cm.user_id is distinct from c.owner_id;",
        );
        expect(body.match(/delete from/g)).toHaveLength(1);
        // A chat hiccup never blocks a crew removal: it warns.
        expect(body).toContain("exception when others then raise warning 'forget_crew_chat_membership: %', sqlerrm;");
        expect(body).not.toContain('raise exception');
        expect(body.trim().endsWith('return null; end;')).toBe(true);

        expect(migration).toContain(
            'revoke all on function public.forget_crew_chat_membership() from public, anon, authenticated;',
        );
        expect(migration).not.toMatch(/grant [^;]* on function public\.forget_crew_chat_membership/);
    });

    it('fires AFTER UPDATE OF status, crew_user_id, owner_id OR DELETE, FOR EACH ROW, re-created idempotently', () => {
        expect(migration).toContain(
            'drop trigger if exists trg_vessel_crew_forget_chat_membership on public.vessel_crew; create trigger trg_vessel_crew_forget_chat_membership after update of status, crew_user_id, owner_id or delete on public.vessel_crew for each row execute function public.forget_crew_chat_membership();',
        );
    });

    it('join_accepted_crew_channels takes the same turn first, and otherwise joins exactly as it always did', () => {
        const join = latestDefinition('join_accepted_crew_channels');
        expect(join.file).toBe(FILE);
        const before = definitionIn('20260723090000_security_hardening_core.sql', 'join_accepted_crew_channels');
        expect(before).not.toBeNull();
        // Same signature, return type, language, definer and search_path.
        expect(join.header).toBe(before?.header);
        // The turn comes first, before the crew test reads vessel_crew, so a
        // join and a removal committing at the same moment cannot cross.
        const turn = TURN('p_owner_id');
        expect(join.body.trim().startsWith(`declare joined_count integer; begin ${turn}`)).toBe(true);
        // Nothing else changed.
        expect(join.body.replace(` ${turn}`, '')).toBe(before?.body);
        // join adds to the owner's ACTIVE private 👥 rooms; removal covers those and archived ones too.
        expect(join.body).toContain(
            "where c.owner_id = p_owner_id and c.is_private and c.status = 'active' and c.icon = '👥'",
        );
        // The same EXECUTE as 20260723090000: signed-in sailors only.
        expect(migration).toContain(
            'revoke all on function public.join_accepted_crew_channels(uuid) from public, anon;',
        );
        expect(migration).toContain(
            'grant execute on function public.join_accepted_crew_channels(uuid) to authenticated;',
        );
    });

    it('refuses to replace a join_accepted_crew_channels that drifted on live, before anything changes', () => {
        const guard = migration.slice(migration.indexOf('do $join_drift$'), migration.indexOf('$join_drift$;'));
        expect(guard.length).toBeGreaterThan(100);
        // The first thing the file does: nothing has changed yet when it refuses.
        expect(migration.indexOf('do $join_drift$')).toBeGreaterThan(0);
        expect(migration.indexOf('do $join_drift$')).toBeLessThan(migration.indexOf('create or replace function'));
        // It accepts the body 20260723090000 wrote, or this file's own (a re-run), and nothing else.
        const written = fingerprint(
            rawBody('20260723090000_security_hardening_core.sql', 'join_accepted_crew_channels'),
        );
        const ours = fingerprint(rawBody(FILE, 'join_accepted_crew_channels'));
        expect(written).not.toBe(ours);
        expect(guard).toContain(`not in ('${written}', '${ours}')`);
        expect(guard).toContain("md5(btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g')))");
        expect(guard).toContain("to_regprocedure('public.join_accepted_crew_channels(uuid)')");
        expect(guard).toContain(
            "raise exception 'crew removal: join_accepted_crew_channels here is not the one 20260723090000 wrote; refusing to replace it, nothing changed'",
        );
    });

    it('sweeps today’s orphans with the trigger’s own conditions, counting first and refusing a surprise', () => {
        const sweep = migration.slice(migration.indexOf('do $sweep$'), migration.indexOf('$sweep$;') + 8);
        expect(sweep.length).toBeGreaterThan(100);
        const predicate =
            "c.is_private and c.icon = '👥' and c.owner_id is not null and cm.user_id is distinct from c.owner_id and not exists ( select 1 from public.vessel_crew as m where m.owner_id = c.owner_id and m.crew_user_id = cm.user_id and m.status = 'accepted' )";
        // The count and the delete use one predicate, the trigger's own.
        expect(sweep.split(predicate)).toHaveLength(3);
        expect(sweep.indexOf('select count(*) into orphans')).toBeLessThan(sweep.indexOf('delete from'));
        expect(sweep.indexOf('if orphans > 10 then raise exception')).toBeLessThan(sweep.indexOf('delete from'));
        expect(sweep).toContain(
            "raise notice 'chat membership: removed % crew-room membership(s) with no accepted crew row', orphans;",
        );
    });

    it('fails the push unless the end state is right, and can be re-run', () => {
        const check = migration.slice(migration.indexOf('do $check$'));
        expect(check).toContain("raise exception 'chat membership question: % is missing its guard'");
        expect(check).toContain(
            "raise exception 'chat membership question: % lost security definer or its search_path'",
        );
        expect(check).toContain("raise exception 'chat membership question: execute on % is wrong'");
        expect(check).toContain(
            "raise exception 'crew removal: forget_crew_chat_membership is missing, not a definer, or callable by clients'",
        );
        expect(check).toContain(
            "raise exception 'crew removal: trg_vessel_crew_forget_chat_membership is missing or wrong'",
        );
        expect(check).toContain("raise exception 'crew removal: % orphan membership(s) remain'");
        expect(check).toContain("raise exception 'crew removal: forget_crew_chat_membership does not take its turn'");
        expect(check).toContain(
            "raise exception 'crew removal: join_accepted_crew_channels is missing, does not take its turn, or has the wrong execute'",
        );
        expect(check).toContain(
            "position('pg_advisory_xact_lock(hashtextextended(''crew_chat_membership:'' || old.owner_id::text, 0))' in",
        );
        expect(check).toContain(
            "position('pg_advisory_xact_lock(hashtextextended(''crew_chat_membership:'' || p_owner_id::text, 0))' in",
        );

        // Idempotent and replayable inside a rolled-back transaction.
        expect(migration).not.toMatch(/(^|;)\s*(begin|commit)\s*;/);
        expect(migration).not.toContain('set local');
        expect(migration.startsWith("set lock_timeout = '5s';")).toBe(true);
        expect(migration.endsWith('reset lock_timeout;')).toBe(true);
        expect(migration).not.toMatch(/create function /);
        expect(migration).not.toMatch(/create trigger (?!trg_vessel_crew_forget_chat_membership)/);
    });
});
