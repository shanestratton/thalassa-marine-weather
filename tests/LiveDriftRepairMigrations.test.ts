/**
 * Live drift repairs (build 126, package 126-19).
 *
 * A read-only drift scan of live on 2026-10-10 found ten things the app relies
 * on that live does not have, although most of their migrations are recorded
 * as applied: the early ones ran against tables built by hand first, so their
 * CREATE TABLE IF NOT EXISTS (and everything that leaned on it) was skipped
 * without an error. Each repair is its own small migration, safe to re-run,
 * ending in a self-check that aborts the push if the repair did not take.
 *
 * These checks pin the migration TEXT: the order, the idempotent shape, the
 * self-checks, and that each one restates exactly what its original migration
 * declared. Their effect on live is proved separately, in rolled-back replays
 * (begin ... rollback, each body applied twice, counts only).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const DIR = 'supabase/migrations';
const migrations = readdirSync(DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

/** The ten repairs, in the order they must run. */
const REPAIRS = [
    '20261010151000_recipes_updated_at_trigger.sql',
    '20261010151100_ship_documents_manuals_category_repair.sql',
    '20261010151200_inventory_items_notes_column.sql',
    '20261010151300_chat_membership_deletion_links.sql',
    '20261010151400_push_queue_instant_send.sql',
    '20261010151500_watch_assignments_realtime.sql',
    '20261010151600_slugify_trailing_numbers_repair.sql',
    '20261010151700_account_deletion_fence_coverage.sql',
    '20261010151800_log_service_anon_revoke.sql',
    '20261010151900_check_weather_alerts_reschedule.sql',
] as const;

type Repair = (typeof REPAIRS)[number];

function read(file: string): string {
    return migrations.includes(file) ? readFileSync(`${DIR}/${file}`, 'utf8') : '';
}

interface Parsed {
    sql: string;
    /** The comment block before the first statement. */
    header: string;
    /** The file with every comment removed. */
    code: string;
    /** The code on one line, whitespace collapsed. */
    body: string;
}

function parse(file: string): Parsed {
    const sql = read(file);
    const first = sql.search(/^\s*(?!--)\S/m);
    const header = first > 0 ? sql.slice(0, first) : '';
    const code = sql.replace(/--[^\n]*/g, '');
    const body = code.replace(/\s+/g, ' ').trim();
    return { sql, header, code, body };
}

const parsed = Object.fromEntries(REPAIRS.map((file) => [file, parse(file)])) as Record<Repair, Parsed>;

/** The text of one dollar-quoted DO block, by its tag. */
function doBlock(body: string, tag: string): string {
    const open = body.indexOf(`DO $${tag}$`);
    if (open < 0) return '';
    const close = body.indexOf(`$${tag}$;`, open + tag.length + 4);
    return close < 0 ? '' : body.slice(open, close + tag.length + 3);
}

/** The lines Shane said yes to, 2026-10-10 ~06:05 (1 = weather alerts back on, 2 = instant pushes). */
const SHANE_YES = '"1 - yes, 2 - yes"';

describe('live drift repairs: order and shape (126-19)', () => {
    it('all ten exist, in this order, after every migration queued for 126 before them', () => {
        for (const file of REPAIRS) expect(migrations, file).toContain(file);
        const positions = REPAIRS.map((file) => migrations.indexOf(file));
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        for (const earlier of [
            '20261009172000_saved_routes_verification.sql',
            '20261010110000_crew_ids_skipper_only.sql',
            '20261010120000_pi_alarm_events.sql',
            '20261010130000_anchor_watch_keeper_heartbeat.sql',
            '20261010145000_recipes_live_schema_alignment.sql',
            '20261010150000_recipes_is_custom_repair.sql',
        ]) {
            expect(migrations).toContain(earlier);
            expect(REPAIRS[0] > earlier, `${REPAIRS[0]} after ${earlier}`).toBe(true);
        }
        // No other file shares a repair's version (the audit checks this too).
        for (const file of REPAIRS) {
            const version = file.slice(0, 14);
            expect(migrations.filter((name) => name.startsWith(`${version}_`))).toEqual([file]);
        }
    });

    it.each(REPAIRS)('%s has no transaction control and bounds its locks', (file) => {
        const { code, body, header } = parsed[file];
        expect(body.length).toBeGreaterThan(0);
        // The CLI applies the file as one batch; a rehearsal wraps it in begin ... rollback.
        expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im);
        expect(code).not.toMatch(/\bSET\s+LOCAL\s+lock_timeout\b/i);
        expect(body.startsWith("SET lock_timeout = '5s';"), 'SET lock_timeout first').toBe(true);
        expect(body.endsWith('RESET lock_timeout;'), 'RESET lock_timeout last').toBe(true);
        expect(header).toMatch(/Not pushed/);
        expect(header).toMatch(/126-19/);
    });

    it.each(REPAIRS)('%s ends with a self-check that fails the push', (file) => {
        const { body } = parsed[file];
        const check = doBlock(body, 'check');
        expect(check, 'DO $check$ block').not.toBe('');
        expect(check).toMatch(/RAISE EXCEPTION '[a-z_]+: /);
        // The self-check is the last thing before the lock reset.
        expect(body.endsWith(`${check} RESET lock_timeout;`)).toBe(true);
    });

    it.each(REPAIRS)('%s is idempotent in shape', (file) => {
        const { code } = parsed[file];
        for (const created of code.matchAll(
            /CREATE\s+TRIGGER\s+([a-z_]+)\s+[\s\S]*?\bON\s+(public\.[a-z_]+|%I\.%I|public\.%I)/gi,
        )) {
            const [, name, table] = created;
            const drop = new RegExp(`DROP TRIGGER IF EXISTS ${name} ON ${table.replace(/[.%]/g, '\\$&')}`, 'i');
            expect(code, `DROP TRIGGER IF EXISTS ${name} before CREATE`).toMatch(drop);
            expect(code.search(drop)).toBeLessThan(created.index ?? 0);
        }
        expect(code).not.toMatch(/CREATE\s+FUNCTION/i); // only CREATE OR REPLACE
        expect(code).not.toMatch(/ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i);
        expect(code).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i);
        expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|POLICY)\b/i);
        expect(code).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|INSERT\s+INTO|UPDATE\s+public\.)/i);
    });

    it.each(REPAIRS)('%s carries no ids, emails or keys (public repo)', (file) => {
        const { sql } = parsed[file];
        expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        expect(sql).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
        expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|sb_secret_|service_role_key'\s*,\s*'[^<]/);
    });

    it("the two behaviour changes record Shane's yes verbatim, and only those two", () => {
        for (const file of [REPAIRS[4], REPAIRS[9]]) {
            expect(parsed[file].header, file).toContain(SHANE_YES);
            expect(parsed[file].header, file).toContain('2026-10-10');
        }
        for (const file of REPAIRS.filter((name) => name !== REPAIRS[4] && name !== REPAIRS[9])) {
            expect(parsed[file].header, file).not.toContain(SHANE_YES);
        }
    });

    it('passes the migration audit', () => {
        const out = execFileSync(process.execPath, ['scripts/audit-supabase-migrations.mjs'], { encoding: 'utf8' });
        expect(out).toContain('Supabase migration audit passed');
    });
});

describe('151000 recipes keep a server timestamp', () => {
    const { body, header } = parsed[REPAIRS[0]];

    it('re-creates update_recipes_ts with a pinned search_path and stamps updated_at', () => {
        expect(body).toMatch(
            /CREATE OR REPLACE FUNCTION public\.update_recipes_ts\(\) RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS \$\$ BEGIN NEW\.updated_at = now\(\); RETURN NEW; END; \$\$;/,
        );
        expect(body).not.toMatch(/SECURITY DEFINER/i);
    });

    it('fires before every update of recipes, as on the other twelve binders', () => {
        expect(body).toContain('DROP TRIGGER IF EXISTS trg_recipes_updated ON public.recipes;');
        expect(body).toContain(
            'CREATE TRIGGER trg_recipes_updated BEFORE UPDATE ON public.recipes FOR EACH ROW EXECUTE FUNCTION public.update_recipes_ts();',
        );
        // The name the original migration gave it.
        expect(read('20260322090000_recipes.sql')).toMatch(
            /CREATE TRIGGER trg_recipes_updated\s+BEFORE UPDATE ON public\.recipes/,
        );
    });

    it('checks the trigger is there, enabled and calls the function', () => {
        const check = doBlock(body, 'check');
        expect(check).toContain("t.tgrelid = 'public.recipes'::regclass");
        expect(check).toContain("t.tgname = 'trg_recipes_updated'");
        expect(check).toContain("t.tgfoid = 'public.update_recipes_ts()'::regprocedure");
        expect(check).toContain("t.tgenabled <> 'D'");
    });

    it('says why it ships with 145000', () => {
        expect(header).toMatch(/B-03/);
        expect(header).toContain('20261010145000');
    });
});

describe('151100 Manuals documents reach the server', () => {
    const { body, header } = parsed[REPAIRS[1]];
    const SIX = ['Registration', 'Insurance', 'Crew Visas/IDs', 'Radio/MMSI', 'Customs Clearances', 'User Manuals'];

    it('allows exactly the categories the app offers', () => {
        const union = readFileSync('types/vessel.ts', 'utf8').match(/export type DocumentCategory =([^;]+);/);
        expect(union, 'DocumentCategory in types/vessel.ts').not.toBeNull();
        const offered = [...(union as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
        expect(offered).toEqual(SIX);
        const check = body.match(/ADD CONSTRAINT ship_documents_category_check CHECK \(category IN \(([^)]+)\)\);/);
        expect(check, 'the CHECK').not.toBeNull();
        expect([...(check as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(SIX);
        // The same six the original migration declared.
        const original = read('20260301090000_ship_documents_add_manuals_category.sql').replace(/\s+/g, ' ');
        for (const value of SIX) expect(original).toContain(`'${value}'`);
    });

    it('replaces the constraint only when User Manuals is missing', () => {
        const repair = doBlock(body, 'repair');
        expect(repair).toContain("position('''User Manuals''' IN pg_get_constraintdef(c.oid)) > 0");
        expect(repair.indexOf('IF NOT EXISTS')).toBeLessThan(repair.indexOf('DROP CONSTRAINT IF EXISTS'));
        expect(repair.indexOf('DROP CONSTRAINT IF EXISTS ship_documents_category_check')).toBeLessThan(
            repair.indexOf('ADD CONSTRAINT ship_documents_category_check'),
        );
    });

    it('checks all six are allowed', () => {
        const check = doBlock(body, 'check');
        for (const value of SIX) expect(check).toContain(`'${value}'`);
        expect(check).toContain('quote_literal(wanted)');
    });

    it('says why', () => {
        expect(header).toMatch(/A1/);
        expect(header).toMatch(/23514/);
        expect(header).toContain('20260301090000');
    });
});

describe('151200 Cooking Mode leftovers sync', () => {
    const { body, header } = parsed[REPAIRS[2]];

    it('adds a nullable notes text column, nothing else', () => {
        expect(body).toContain('ALTER TABLE public.inventory_items ADD COLUMN IF NOT EXISTS notes TEXT;');
        expect(body).not.toMatch(/notes TEXT (NOT NULL|DEFAULT)/i);
        expect(body).toContain("NOTIFY pgrst, 'reload schema';");
    });

    it('is the column the leftovers insert sends', () => {
        const meal = readFileSync('services/MealPlanService.ts', 'utf8');
        const insert = meal.slice(meal.indexOf('transaction.insert(STORES_TABLE'));
        expect(insert.slice(0, insert.indexOf('});'))).toMatch(/\bnotes,/);
    });

    it('checks the column and that the app can write it', () => {
        const check = doBlock(body, 'check');
        expect(check).toContain("column_name = 'notes'");
        expect(check).toContain("has_column_privilege('authenticated', 'public.inventory_items', 'notes', 'INSERT')");
        expect(check).toContain("has_column_privilege('authenticated', 'public.inventory_items', 'notes', 'UPDATE')");
    });

    it('is the only column the leftovers insert sends that live lacks', () => {
        // live's inventory_items, from the read-only drift scan of 2026-10-10 (names only).
        const live = [
            'id',
            'user_id',
            'barcode',
            'item_name',
            'description',
            'category',
            'quantity',
            'min_quantity',
            'location_zone',
            'location_specific',
            'created_at',
            'updated_at',
            'expiry_date',
            'unit',
            'currency',
            'unit_value',
            'unit_system',
        ];
        const meal = readFileSync('services/MealPlanService.ts', 'utf8');
        const insert = meal.slice(meal.indexOf('transaction.insert(STORES_TABLE'));
        const literal = insert.slice(insert.indexOf('{') + 1, insert.indexOf('});'));
        const sent = [...literal.matchAll(/^\s*([a-z_]+)\s*[:,]/gm)].map((match) => match[1]);
        expect(sent).toContain('expiry_date');
        expect(sent.filter((column) => !live.includes(column))).toEqual(['notes']);
    });

    it('says why, and that notes alone unblocks leftovers', () => {
        expect(header).toMatch(/A3/);
        expect(header).toMatch(/PGRST204/);
        expect(header).toMatch(/notes is the only column the insert sends that live lacks/);
        expect(header).toMatch(/live already has that/);
        expect(header).not.toMatch(/lacks too|once both are in/);
    });
});

describe('151300 account deletion removes crew-room memberships', () => {
    const { body, header } = parsed[REPAIRS[3]];
    const original = read('20260723090000_security_hardening_core.sql').replace(/\s+/g, ' ');

    it('adds the foreign keys exactly as 20260723090000 declared them', () => {
        // The declarations it restates.
        expect(original).toContain(
            'CREATE TABLE IF NOT EXISTS public.channel_members ( channel_id UUID NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,',
        );
        expect(original).toMatch(
            /channel_join_requests \( .*? user_id UUID NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE,/,
        );
        expect(original).toContain('reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL');
        expect(original).toContain(
            'ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL',
        );
        expect(original).toContain(
            'ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES public.chat_channels(id) ON DELETE SET NULL',
        );

        const repair = doBlock(body, 'repair');
        for (const [table, constraint, definition] of [
            [
                'channel_members',
                'channel_members_user_id_fkey',
                'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
            ],
            [
                'channel_join_requests',
                'channel_join_requests_user_id_fkey',
                'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
            ],
            [
                'channel_join_requests',
                'channel_join_requests_reviewed_by_fkey',
                'FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL',
            ],
            [
                'chat_channels',
                'chat_channels_owner_id_fkey',
                'FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL',
            ],
            [
                'chat_channels',
                'chat_channels_parent_id_fkey',
                'FOREIGN KEY (parent_id) REFERENCES public.chat_channels(id) ON DELETE SET NULL',
            ],
        ]) {
            expect(repair).toContain(`ALTER TABLE public.${table} ADD CONSTRAINT ${constraint} ${definition};`);
        }
    });

    it('guards every add, and swaps parent_id only when it is not already SET NULL', () => {
        const repair = doBlock(body, 'repair');
        for (const constraint of [
            'channel_members_user_id_fkey',
            'channel_join_requests_user_id_fkey',
            'channel_join_requests_reviewed_by_fkey',
            'channel_join_requests_status_check',
            'chat_channels_owner_id_fkey',
        ]) {
            const guard = repair.indexOf(`conname = '${constraint}') THEN`);
            expect(guard, `${constraint} guard`).toBeGreaterThan(-1);
            expect(guard).toBeLessThan(repair.indexOf(`ADD CONSTRAINT ${constraint}`));
        }
        expect(repair).toContain("conname = 'chat_channels_parent_id_fkey' AND confdeltype = 'n') THEN");
        expect(repair.indexOf('DROP CONSTRAINT IF EXISTS chat_channels_parent_id_fkey')).toBeLessThan(
            repair.indexOf('ADD CONSTRAINT chat_channels_parent_id_fkey'),
        );
    });

    it('adds the status check with the original three values, and no NOT NULL tightening', () => {
        expect(original).toContain(
            "status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected'))",
        );
        expect(body).toContain(
            "ALTER TABLE public.channel_join_requests ADD CONSTRAINT channel_join_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected'));",
        );
        expect(body).not.toMatch(/SET NOT NULL/i);
    });

    it('fences both tables on user_id against a tombstoned account', () => {
        for (const table of ['channel_members', 'channel_join_requests']) {
            expect(body).toContain(`DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.${table};`);
            expect(body).toContain(
                `CREATE TRIGGER account_deletion_write_fence BEFORE INSERT OR UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');`,
            );
        }
        // Not chat_channels: a fence on owner_id would refuse other sailors' writes to a room.
        expect(body).not.toMatch(/account_deletion_write_fence BEFORE INSERT OR UPDATE ON public\.chat_channels/);
    });

    it('checks every key, its ON DELETE rule and both fences', () => {
        const check = doBlock(body, 'check');
        for (const [constraint, rule] of [
            ['channel_members_user_id_fkey', 'c'],
            ['channel_join_requests_user_id_fkey', 'c'],
            ['channel_join_requests_reviewed_by_fkey', 'n'],
            ['chat_channels_owner_id_fkey', 'n'],
            ['chat_channels_parent_id_fkey', 'n'],
        ]) {
            expect(check).toMatch(new RegExp(`'${constraint}', '${rule}'\\)`));
        }
        expect(check).toContain('c.convalidated');
        expect(check).toContain("conname = 'channel_join_requests_status_check'");
        expect(check).toMatch(/tgname = 'account_deletion_write_fence'[^;]*\) <> 2 THEN/);
    });

    it('says why, and what it depends on live', () => {
        expect(header).toMatch(/B-06/);
        expect(header).toMatch(/0 orphans/);
        expect(header).toMatch(/23503/);
    });

    it('names the reviewer limit for the scrub AND the new cascade', () => {
        // The trigger it describes: any UPDATE of a decided request raises.
        expect(original).toContain("OR OLD.status <> 'pending'");
        expect(original).toContain("RAISE EXCEPTION 'Only a pending request decision may be updated';");
        // The reviewed_by key this file adds is SET NULL, so its cascade is an UPDATE.
        expect(body).toContain('FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL');
        const limit = header.slice(header.indexOf('Known limit'));
        expect(limit).toMatch(/scrub's own UPDATE/);
        expect(limit).toMatch(/from this file on, the auth cascade too/);
        expect(limit).toMatch(/auth\.admin\.deleteUser/);
        expect(limit).not.toMatch(/with or without this file \(live holds/);
    });
});

describe('151400 pushes go out the moment they are queued', () => {
    const { body, header } = parsed[REPAIRS[4]];

    it('checks its two helpers exist before anything else', () => {
        const pre = doBlock(body, 'precheck');
        expect(body.indexOf('DO $precheck$')).toBeLessThan(body.indexOf('DROP TRIGGER'));
        expect(pre).toContain("to_regprocedure('public.invoke_edge_function(text,integer,jsonb)') IS NULL");
        expect(pre).toContain("to_regprocedure('public.claim_push_notification(uuid)') IS NULL");
    });

    it('drops the 2026-03-06 trigger that never landed', () => {
        expect(body).toContain('DROP TRIGGER IF EXISTS on_push_queue_insert ON public.push_notification_queue;');
        expect(body).toContain('DROP FUNCTION IF EXISTS public.notify_push_queue();');
    });

    it('posts only the row id to send-push through the vault helper, and never fails an insert', () => {
        const fn = body.slice(
            body.indexOf('CREATE OR REPLACE FUNCTION public.push_queue_send_now()'),
            body.indexOf('$$;', body.indexOf('CREATE OR REPLACE FUNCTION public.push_queue_send_now()')) + 3,
        );
        expect(fn).toContain(
            'RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$',
        );
        expect(fn).toContain(
            "PERFORM public.invoke_edge_function('send-push', 30000, jsonb_build_object('record', jsonb_build_object('id', NEW.id)));",
        );
        expect(fn).toMatch(/EXCEPTION WHEN OTHERS THEN RAISE WARNING 'push_queue_send_now: %[^']*', SQLERRM;/);
        expect(fn).toContain('RETURN NULL;');
        // No row contents in the request, and no second credential path.
        expect(fn).not.toMatch(/row_to_json|to_jsonb\(NEW\)|net\.http_post|vault\./);
        expect(body).toContain('REVOKE ALL ON FUNCTION public.push_queue_send_now() FROM PUBLIC, anon, authenticated;');
    });

    it('fires after each insert of an unsent row', () => {
        expect(body).toContain('DROP TRIGGER IF EXISTS push_queue_send_now ON public.push_notification_queue;');
        expect(body).toContain(
            'CREATE TRIGGER push_queue_send_now AFTER INSERT ON public.push_notification_queue FOR EACH ROW WHEN (NEW.sent_at IS NULL) EXECUTE FUNCTION public.push_queue_send_now();',
        );
    });

    it('relies on send-push claiming by id, so the minute drain can never double-send', () => {
        const sendPush = readFileSync('supabase/functions/send-push/index.ts', 'utf8');
        expect(sendPush).toContain('const { record: webhookRecord } = await req.json();');
        expect(sendPush).toMatch(/rpc\('claim_push_notification', \{\s*p_id: webhookRecord\.id,/);
        const claim = read('20260723090000_security_hardening_core.sql');
        expect(claim).toMatch(
            /WHERE id = p_id\s+AND sent_at IS NULL\s+AND \(processing_at IS NULL OR processing_at < now\(\) - interval '5 minutes'\)/,
        );
    });

    it('leaves the minute drain as the fallback, and checks the result', () => {
        expect(body).not.toMatch(/cron\.(schedule|unschedule|alter_job)/);
        const check = doBlock(body, 'check');
        expect(check).toContain("tgname = 'on_push_queue_insert'");
        expect(check).toContain("tgname = 'push_queue_send_now' AND NOT tgisinternal AND tgenabled <> 'D'");
        expect(check).toContain("jobname = 'retry-pending-push' AND active");
    });

    it('records the approval and the measured wait', () => {
        expect(header).toMatch(/B-04/);
        expect(header).toMatch(/36 s/);
        expect(header).toMatch(/2 = send pushes instantly/);
    });
});

describe('151500 watch-schedule edits reach open screens', () => {
    const { body, header } = parsed[REPAIRS[5]];

    it('publishes watch_assignments only when it is not already', () => {
        const publish = doBlock(body, 'publish');
        expect(publish).toContain(
            "pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'watch_assignments'",
        );
        expect(publish).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE public.watch_assignments;');
        expect(publish.indexOf('IF NOT EXISTS (SELECT 1 FROM pg_publication_tables')).toBeLessThan(
            publish.indexOf('ALTER PUBLICATION'),
        );
        expect(body).not.toMatch(/DROP TABLE|SET TABLE|REPLICA IDENTITY/i);
    });

    it('is the table the schedule screen listens to', () => {
        const service = readFileSync('services/WatchAssignmentService.ts', 'utf8');
        expect(service).toMatch(/'postgres_changes',\s*\{[^}]*table: 'watch_assignments'/);
    });

    it('checks the member is there (and passes where there is no publication)', () => {
        const check = doBlock(body, 'check');
        expect(check).toContain("tablename = 'watch_assignments'");
        expect(check).toMatch(/RAISE NOTICE/);
    });

    it('says why', () => {
        expect(header).toMatch(/A10/);
        expect(header).toContain('20261002150000');
    });
});

describe('151600 new voyage-log handles use the intended slug rule', () => {
    const { body, header } = parsed[REPAIRS[6]];
    const original = read('20260517100000_slugify_glue_trailing_numbers.sql');

    function functionText(sql: string): string {
        const code = sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
        const start = code.indexOf('CREATE OR REPLACE FUNCTION public.slugify(input TEXT)');
        return code.slice(start, code.indexOf('LANGUAGE sql IMMUTABLE;', start) + 'LANGUAGE sql IMMUTABLE;'.length);
    }

    it('re-creates slugify verbatim from 20260517100000', () => {
        expect(functionText(original).length).toBeGreaterThan(100);
        expect(functionText(parsed[REPAIRS[6]].sql)).toBe(functionText(original));
    });

    // The examples the original file lists, as its header states them.
    const EXAMPLES: Array<[string, string]> = [...original.matchAll(/^--\s+"([^"]+)"\s+→\s+(\S+)/gm)].map((m) => [
        m[1],
        m[2],
    ]);

    it('self-checks the seven examples the original lists', () => {
        expect(EXAMPLES).toHaveLength(7);
        expect(EXAMPLES).toContainEqual(['Serenity 3', 'serenity3']);
        const check = doBlock(body, 'check');
        for (const [input, output] of EXAMPLES) expect(check).toContain(`ARRAY['${input}', '${output}']`);
        expect(check).toMatch(/public\.slugify\(pair\[1\]\) IS DISTINCT FROM pair\[2\]/);
    });

    it('the examples hold for the rule as written (a wrong expectation would abort the push)', () => {
        // The function, step for step: lower, glue a trailing number or short roman, hyphenate, trim.
        const slugify = (input: string) =>
            input
                .toLowerCase()
                .replace(/([a-z])\s+(\d+|i{1,3}|i?v|vi{1,3}|i?x|xi{1,3})$/g, '$1$2')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
        for (const [input, output] of EXAMPLES) expect(slugify(input), input).toBe(output);
        // Boat names from anywhere: a trailing number or roman glues on whatever the language,
        // and a letter outside a-z is a separator, as it is in the database.
        expect(slugify('Kia Ora IV')).toBe('kia-oraiv');
        expect(slugify('Étoile 2')).toBe('toile2');
    });

    it('rewrites no existing handle', () => {
        expect(body).not.toMatch(/voyage_log_configs|UPDATE/i);
        expect(header).toMatch(/B-12/);
        expect(header).toMatch(/[Ee]xisting handles/);
    });
});

describe('151700 the deletion fence covers three more tables', () => {
    const { body, header } = parsed[REPAIRS[7]];

    it('fences ais_watch, log_passage_memberships and vessel_telemetry on their owner column', () => {
        const fence = doBlock(body, 'fence');
        expect(fence).toContain(
            "FROM (VALUES ('ais_watch', 'user_id'), ('log_passage_memberships', 'user_id'), ('vessel_telemetry', 'owner_id')) AS t(tbl, owner_col)",
        );
        expect(fence).toContain(
            "EXECUTE format('DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.%I', target.tbl);",
        );
        expect(fence).toContain(
            "EXECUTE format('CREATE TRIGGER account_deletion_write_fence BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write(%L)', target.tbl, target.owner_col);",
        );
        expect(fence).toContain("to_regclass(format('public.%I', target.tbl)) IS NULL");
    });

    it('names the owner columns those tables really have', () => {
        expect(read('20260823120000_ais_watch_ledger.sql')).toMatch(
            /user_id\s+UUID PRIMARY KEY REFERENCES auth\.users\(id\)/,
        );
        expect(read('20260923120000_log_passage_display.sql')).toMatch(
            /user_id uuid NOT NULL REFERENCES auth\.users\(id\)/,
        );
        expect(read('20260906170000_vessel_telemetry.sql')).toMatch(
            /owner_id\s+UUID PRIMARY KEY REFERENCES auth\.users\(id\)/,
        );
    });

    it('leaves the broadcast fan-out and the admin list alone, and says why', () => {
        expect(body).not.toMatch(/guardian_alert_recipients|founding_skipper_reviewers/);
        expect(header).toMatch(/guardian_alert_recipients/);
        expect(header).toMatch(/founding_skipper_reviewers/);
        expect(header).toMatch(/C11/);
    });

    it('checks all three fences installed', () => {
        const check = doBlock(body, 'check');
        for (const table of ['ais_watch', 'log_passage_memberships', 'vessel_telemetry']) {
            expect(check).toContain(`'public.${table}'::regclass`);
        }
        expect(check).toMatch(/\) <> 3 THEN/);
    });
});

describe('151800 anon loses log_service', () => {
    const { body, header } = parsed[REPAIRS[8]];

    it('revokes EXECUTE from anon only, when the function exists', () => {
        const revoke = doBlock(body, 'revoke');
        expect(revoke).toContain(
            "IF to_regprocedure('public.log_service(uuid,integer,text,numeric)') IS NOT NULL THEN",
        );
        expect(revoke).toContain(
            'REVOKE EXECUTE ON FUNCTION public.log_service(uuid, integer, text, numeric) FROM anon;',
        );
        expect(body).not.toMatch(/FROM (PUBLIC, )?(anon, )?authenticated/i);
        expect(body).not.toMatch(/\bGRANT\b/);
    });

    it('checks anon cannot and the app still can', () => {
        const check = doBlock(body, 'check');
        expect(check).toContain(
            "has_function_privilege('anon', 'public.log_service(uuid,integer,text,numeric)', 'EXECUTE')",
        );
        expect(check).toContain(
            "NOT has_function_privilege('authenticated', 'public.log_service(uuid,integer,text,numeric)', 'EXECUTE')",
        );
        // The app calls it signed in.
        expect(readFileSync('services/MaintenanceService.ts', 'utf8')).toContain(".rpc('log_service'");
    });

    it('says why', () => {
        expect(header).toMatch(/C10/);
        expect(header).toContain('20260728150000');
    });
});

describe('151900 background weather alerts run again', () => {
    const { body, header } = parsed[REPAIRS[9]];
    const declared = read('20260813060000_edge_cron_vault_credentials.sql');

    it('schedules the job exactly as 20260813060000 declared it', () => {
        const row = declared.match(
            /\('check-weather-alerts',\s+'check-weather-alerts',\s+'(\*\/30 \* \* \* \*)',\s+(\d+)\)/,
        );
        expect(row, 'the 20260813060000 row').not.toBeNull();
        const [, schedule, timeout] = row as RegExpMatchArray;
        // format('SELECT public.invoke_edge_function(%L, %s)', function_name, timeout_ms)
        const command = `SELECT public.invoke_edge_function('check-weather-alerts', ${timeout})`;
        const block = doBlock(body, 'schedule');
        expect(block).toContain(`job_name CONSTANT TEXT := 'check-weather-alerts';`);
        expect(block).toContain(`want_schedule CONSTANT TEXT := '${schedule}';`);
        expect(block).toContain(`want_command CONSTANT TEXT := '${command.replace(/'/g, "''")}';`);
        expect(block).toContain('PERFORM cron.schedule(job_name, want_schedule, want_command);');
        expect(readFileSync('supabase/functions/check-weather-alerts/index.ts', 'utf8').length).toBeGreaterThan(0);
    });

    it('is idempotent: an exact active job is left alone, a paused one stays paused, drift is replaced', () => {
        const block = doBlock(body, 'schedule');
        expect(block).toContain("to_regprocedure('public.invoke_edge_function(text,integer,jsonb)') IS NULL");
        const paused = block.indexOf('IF paused > 0 THEN');
        const exact = block.indexOf('IF total = 1 AND exact = 1 THEN RETURN;');
        const unschedule = block.indexOf('FOR existing IN SELECT jobid FROM cron.job WHERE jobname = job_name LOOP');
        const schedule = block.indexOf('PERFORM cron.schedule(');
        expect(paused).toBeGreaterThan(-1);
        expect(exact).toBeGreaterThan(paused);
        expect(unschedule).toBeGreaterThan(exact);
        expect(schedule).toBeGreaterThan(unschedule);
        expect(block).toContain('PERFORM cron.unschedule(existing.jobid);');
        expect((body.match(/cron\.schedule\(/g) ?? []).length).toBe(1);
        expect((body.match(/cron\.unschedule\(/g) ?? []).length).toBe(1);
        expect(body).not.toMatch(/cron\.alter_job/);
        // Only its own job, by name.
        expect(body).not.toMatch(
            /'(scrape-vessel-metadata|sweep-stale-ais-vessels|cleanup-weather-alerts-log|retry-pending-push)'/,
        );
    });

    it('checks the job is there once, on the vault helper, every 30 minutes', () => {
        const check = doBlock(body, 'check');
        expect(check).toContain("jobname = 'check-weather-alerts'");
        expect(check).toContain("schedule = '*/30 * * * *'");
        expect(check).toContain(
            "regexp_replace(btrim(command), '\\s+', ' ', 'g') = 'SELECT public.invoke_edge_function(''check-weather-alerts'', 150000)'",
        );
        expect(check).toMatch(/IF total <> 1 OR declared <> 1 THEN/);
    });

    it('records the approval and the promise Settings makes', () => {
        expect(header).toMatch(/B-05/);
        expect(header).toMatch(/1 = turn the background weather alerts back on/);
        expect(header).toContain('2026-08-12');
        expect(header).toMatch(/AlertsTab/);
    });
});
