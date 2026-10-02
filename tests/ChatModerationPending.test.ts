/**
 * Audit item 5, second half: chat messages publish only after server-side
 * moderation, and the pipeline fails CLOSED.
 *
 * Three halves must agree — the migration (pending default, author-only
 * visibility, service-owned state), the Edge Function (never approves what it
 * did not classify; every write guarded against the trigger/sweep race), and
 * the client (no longer classifies its own message; tells the author what is
 * happening). Comments are stripped before every source assertion.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAwaitingModeration, moderationHint } from '../services/chat/messagePolicy';

const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripSql = (s: string) => s.replace(/--[^\n]*/g, '');

describe('migration 20260905130000', () => {
    const sql = stripSql(readFileSync('supabase/migrations/20260905130000_chat_moderation_pending.sql', 'utf8'));

    it('backfills history as approved BEFORE new rows default to pending', () => {
        const backfill = sql.indexOf("moderation_status text NOT NULL DEFAULT 'approved'");
        const newDefault = sql.indexOf("ALTER COLUMN moderation_status SET DEFAULT 'pending'");
        expect(backfill).toBeGreaterThan(0);
        expect(newDefault).toBeGreaterThan(backfill);
        expect(sql).toContain("CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'held'))");
    });

    it('shows pending rows only to their author and to moderators', () => {
        const policy = sql.slice(sql.indexOf('CREATE POLICY "chat_messages_visible"'));
        const body = policy.slice(0, policy.indexOf(';'));
        expect(body).toContain('public.can_access_chat_channel(channel_id, auth.uid())');
        expect(body).toContain("moderation_status = 'approved'");
        expect(body).toContain('OR user_id = auth.uid()');
        expect(body).toContain('OR public.is_chat_moderator(auth.uid())');
    });

    it('a client can only insert an untouched pending row, with every prior insert rule intact', () => {
        const policy = sql.slice(sql.indexOf('CREATE POLICY "chat_messages_create"'));
        const body = policy.slice(0, policy.indexOf(';'));
        for (const clause of [
            'user_id = auth.uid()',
            'char_length(message) BETWEEN 1 AND 4000',
            'char_length(display_name) BETWEEN 1 AND 120',
            'public.can_access_chat_channel(channel_id, auth.uid())',
            'COALESCE(r.is_blocked, false) OR r.muted_until > now()',
            "moderation_status = 'pending'",
            'moderation_attempts = 0',
            'moderated_at IS NULL',
            'moderation_reason IS NULL',
        ]) {
            expect(body, clause).toContain(clause);
        }
    });

    it('moderation state is writable only by the service or an internal context — never a client JWT', () => {
        const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.protect_chat_message_update()'));
        const body = fn.slice(0, fn.indexOf('$function$;'));
        const guard = body.indexOf('NEW.moderation_status IS DISTINCT FROM OLD.moderation_status');
        expect(guard).toBeGreaterThan(0);
        const branch = body.slice(
            guard,
            body.indexOf("RAISE EXCEPTION 'Moderation state is set by the moderation service'"),
        );
        expect(branch).toContain("COALESCE(auth.role(), '') = 'service_role' OR auth.uid() IS NULL");
        // A rejection is a soft delete: the body must still leave the row.
        expect(branch).toContain("NEW.message := '[removed]'");
        // And the moderation guard runs BEFORE the immutability rules, or the
        // service's own UPDATE would be refused as a content change.
        expect(guard).toBeLessThan(body.indexOf("RAISE EXCEPTION 'Message identity and content are immutable'"));
    });

    it('dispatches every new pending row and re-dispatches the stuck ones', () => {
        expect(sql).toMatch(/CREATE TRIGGER on_chat_message_insert_moderate\s+AFTER INSERT ON public\.chat_messages/);
        expect(sql).toContain("WHEN (NEW.moderation_status = 'pending')");
        expect((sql.match(/\/functions\/v1\/moderate-chat-message/g) ?? []).length).toBe(2);
        expect(sql).toContain("cron.schedule(\n    'chat-moderation-retry',\n    '* * * * *'");
    });

    it('holds — never approves — what will not classify', () => {
        const sweep = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.retry_pending_chat_moderation()'));
        const body = sweep.slice(0, sweep.indexOf('$$;'));
        expect(body).toContain("SET moderation_status = 'held'");
        expect(body).toContain("moderation_attempts >= 5 OR created_at < now() - interval '10 minutes'");
        expect(body).not.toContain("'approved'");
        // Missing secrets fail closed, loudly.
        expect(sql).toContain("RAISE WARNING 'Chat moderation dispatch skipped");
    });
});

describe('moderate-chat-message Function', () => {
    const edge = stripTs(readFileSync('supabase/functions/moderate-chat-message/index.ts', 'utf8'));
    const worker = stripTs(readFileSync('supabase/functions/moderate-chat-message/worker.ts', 'utf8'));

    it('demands an exact service-role POST before any database or Gemini work', () => {
        const guard = worker.indexOf('requireServiceRolePost(req, serviceKey)');
        expect(guard).toBeGreaterThan(0);
        expect(guard).toBeLessThan(worker.indexOf('dependencies.createGateway('));
        expect(guard).toBeLessThan(worker.indexOf('await classifyChatMessage('));
        expect(edge).toContain('Deno.serve(createChatModerationHandler(');
        expect(edge.indexOf('createClient(')).toBeGreaterThan(edge.indexOf('createGateway(url, serviceKey)'));
    });

    it('a classifier failure never approves: attempts are counted, then the row is held', () => {
        const failure = worker.slice(
            worker.lastIndexOf("if (classification.status !== 'ok') {"),
            worker.indexOf('const verdict = classification.value'),
        );
        expect(failure).not.toContain("'approved'");
        expect(failure).toContain("moderation_status: 'held'");
        expect(failure).toContain('attempts >= MAX_CHAT_MODERATION_ATTEMPTS');
        expect(worker).toContain('const MAX_CHAT_MODERATION_ATTEMPTS = 5;');
        // HTTP/verdict failures and all resulting state transitions are executed
        // in ChatModerationWorker.test.ts, not inferred from these wiring checks.
    });

    it('the deployed normal state-write adapter predicates every update on the id and pending status', () => {
        const pending = edge.slice(edge.indexOf('async updatePending('), edge.indexOf('async claimUnavailableHold('));
        expect((pending.match(/\.update\(/g) ?? []).length).toBe(1);
        expect(pending).toContain(".eq('id', id).eq('moderation_status', 'pending')");
        expect(worker).toContain("row.moderation_status !== 'pending') return jsonResponse({ skipped: true }, 200)");
    });

    it('the one-off held rescue uses full snapshot CAS predicates at attempts five and six', () => {
        const claim = edge.slice(
            edge.indexOf('async claimUnavailableHold('),
            edge.indexOf('async settleUnavailableHold('),
        );
        const settle = edge.slice(edge.indexOf('async settleUnavailableHold('));
        for (const source of [claim, settle]) {
            expect((source.match(/\.update\(/g) ?? []).length).toBe(1);
            for (const field of ['id', 'channel_id', 'user_id', 'message', 'created_at']) {
                expect(source).toContain(`.eq('${field}', row.${field})`);
            }
            expect(source).toContain(".eq('moderation_status', 'held')");
            expect(source).toContain(".eq('moderation_reason', 'Moderation unavailable').is('deleted_at', null)");
            expect(source).toContain(".select('id').maybeSingle()");
            expect(source).toContain('matched: data?.id === row.id');
        }
        expect(claim).toContain('.update({ moderation_attempts: 6 })');
        expect(claim).toContain(".eq('moderation_attempts', 5)");
        expect(settle).toContain(".eq('moderation_attempts', 6)");
        expect(worker).toContain("RECOVERY_GENERAL_CHANNEL_ID = '7bdf6903-0b8c-4c21-9c85-d7ca351251ce'");
    });

    it('rejects by soft-deleting with a reason the author can read', () => {
        const reject = worker.slice(worker.indexOf("moderation_status: 'rejected'"));
        expect(reject.slice(0, 400)).toContain('deleted_at: now');
        expect(reject.slice(0, 400)).toContain('moderation_reason:');
    });

    it('is declared credentialless in config.toml, like the other pg_net service POSTs', () => {
        const config = readFileSync('supabase/config.toml', 'utf8');
        const at = config.indexOf('[functions.moderate-chat-message]');
        expect(at).toBeGreaterThan(0);
        expect(config.slice(at, at + 400)).toContain('verify_jwt = false');
    });
});

describe('client', () => {
    it('no longer classifies its own channel message after sending', () => {
        const svc = stripTs(readFileSync('services/ChatService.ts', 'utf8'));
        expect(svc).not.toContain('moderateMessage(');
        expect(svc).not.toContain("from './ContentModerationService'");
    });

    it('carries the moderation fields on the message type', () => {
        const types = stripTs(readFileSync('services/chat/types.ts', 'utf8'));
        expect(types).toContain("moderation_status?: 'pending' | 'approved' | 'rejected' | 'held';");
        expect(types).toContain('moderation_reason?: string | null;');
    });

    it('renders the author hint from the one helper', () => {
        const list = stripTs(readFileSync('components/chat/ChatMessageList.tsx', 'utf8'));
        expect(list).toContain('moderationHint(msg, isSelf)');
    });
});

describe('moderationHint', () => {
    const base = { deleted_at: null as string | null, moderation_reason: null as string | null };

    it("says nothing for other people's messages and for approved ones", () => {
        expect(moderationHint({ ...base, moderation_status: 'pending' }, false)).toBeNull();
        expect(moderationHint({ ...base, moderation_status: 'approved' }, true)).toBeNull();
        expect(moderationHint({ ...base, moderation_status: undefined }, true)).toBeNull();
    });

    it('tells the author their message is being checked, and shows the ellipsis instead of the tick', () => {
        expect(moderationHint({ ...base, moderation_status: 'pending' }, true)).toEqual({
            text: 'Checking…',
            tone: 'muted',
        });
        expect(isAwaitingModeration({ moderation_status: 'pending' })).toBe(true);
        expect(isAwaitingModeration({ moderation_status: 'approved' })).toBe(false);
    });

    it('tells the author plainly when a message was held or not posted, with the reason', () => {
        expect(moderationHint({ ...base, moderation_status: 'held' }, true)?.tone).toBe('warn');
        expect(moderationHint({ ...base, moderation_status: 'held' }, true)?.text).toContain('Not delivered');
        expect(
            moderationHint(
                { deleted_at: 'x', moderation_status: 'rejected', moderation_reason: 'Personal attack' },
                true,
            ),
        ).toEqual({ text: 'Not posted — Personal attack', tone: 'warn' });
        expect(
            moderationHint({ deleted_at: 'x', moderation_status: 'rejected', moderation_reason: null }, true)?.text,
        ).toBe('Not posted — removed by moderation');
    });
});
