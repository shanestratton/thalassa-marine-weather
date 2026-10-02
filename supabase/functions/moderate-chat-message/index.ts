/**
 * Service-role-only chat moderation. New posts stay pending until a complete
 * classifier verdict approves/rejects them; unavailable checks fail closed.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY,
 * CHAT_MODERATION_GEMINI_MODEL (optional; defaults to gemini-3.6-flash).
 * Held rows are never automatically reprocessed. An exact-service request can
 * use healthcheck:true (synthetic, no DB), or retry_unavailable_hold:true + id
 * for a single CAS-claimed unavailable hold in the pinned General channel.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createChatModerationHandler } from './worker.ts';

Deno.serve(createChatModerationHandler({
    env: (name) => Deno.env.get(name),
    createGateway(url, serviceKey) {
        const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
        return {
            async lookup(id) {
                const { data, error } = await admin.from('chat_messages')
                    .select(
                        'id, message, moderation_status, moderation_attempts, moderation_reason, deleted_at, channel_id, user_id, created_at',
                    )
                    .eq('id', id).maybeSingle();
                return { row: data, error };
            },
            async updatePending(id, patch) {
                const { error } = await admin.from('chat_messages').update(patch)
                    .eq('id', id).eq('moderation_status', 'pending');
                return { error };
            },
            async claimUnavailableHold(row) {
                const { data, error } = await admin.from('chat_messages').update({ moderation_attempts: 6 })
                    .eq('id', row.id).eq('channel_id', row.channel_id).eq('user_id', row.user_id)
                    .eq('message', row.message).eq('created_at', row.created_at)
                    .eq('moderation_status', 'held').eq('moderation_attempts', 5)
                    .eq('moderation_reason', 'Moderation unavailable').is('deleted_at', null)
                    .select('id').maybeSingle();
                return { matched: data?.id === row.id, error };
            },
            async settleUnavailableHold(row, patch) {
                const { data, error } = await admin.from('chat_messages').update(patch)
                    .eq('id', row.id).eq('channel_id', row.channel_id).eq('user_id', row.user_id)
                    .eq('message', row.message).eq('created_at', row.created_at)
                    .eq('moderation_status', 'held').eq('moderation_attempts', 6)
                    .eq('moderation_reason', 'Moderation unavailable').is('deleted_at', null)
                    .select('id').maybeSingle();
                return { matched: data?.id === row.id, error };
            },
        };
    },
    diagnostic: (event) => console.warn('[moderate-chat-message]', JSON.stringify(event)),
}));
