import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';
import {
    privateTelegramConfirmation,
    privateTelegramSender,
    shoreBotCommand,
    shoreRecord,
} from '../../../utils/shoreContacts.ts';
import {
    answerShoreTelegram,
    type Environment,
    nonceHash,
    sendShoreTelegram,
    shoreBackend,
} from '../anchor-alert-messaging/transport.ts';
export interface TelegramDependencies {
    rpc(name: string, args: unknown): Promise<unknown>;
    send(chat: string, text: string, confirmationNonce?: string): Promise<boolean>;
    answer?(callbackId: string): Promise<boolean>;
    now(): number;
}
export function createTelegramWebhook(env: Environment, overrides?: TelegramDependencies, fetcher = fetch) {
    return async (req: Request): Promise<Response> => {
        if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405, { Allow: 'POST' });
        const secret = env.get('TELEGRAM_WEBHOOK_SECRET');
        if (
            !secret || !/^[A-Za-z\d_-]{32,256}$/.test(secret) ||
            req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret
        ) return jsonResponse({ error: 'Unauthorized' }, 401);
        if (new URL(req.url).search) {
            return jsonResponse({ error: 'Webhook held' }, 503);
        }
        try {
            const body = await readJsonObject(req, 8192),
                confirmation = privateTelegramConfirmation(body, env.get('TELEGRAM_BOT_ID')),
                sender = confirmation ?? privateTelegramSender(body),
                command = confirmation
                    ? { kind: 'confirm' as const, nonce: confirmation.nonce }
                    : sender && 'text' in sender
                    ? shoreBotCommand(sender.text)
                    : null;
            const deps = overrides ??
                {
                    rpc: shoreBackend(env, fetcher).rpc,
                    send: (chat: string, text: string, nonce?: string) =>
                        sendShoreTelegram(env, fetcher, chat, text, nonce),
                    answer: (id: string) => answerShoreTelegram(env, fetcher, id),
                    now: Date.now,
                };
            if (
                !sender || !command || (command.kind !== 'stop' && env.get('SHORE_MESSAGING_ENABLED') !== '1') ||
                sender.at > deps.now() || (command.kind !== 'stop' && sender.at < deps.now() - 300_000)
            ) {
                return jsonResponse({ accepted: false });
            }
            const result = await deps.rpc('shore_telegram_command', {
                p_bot: env.get('TELEGRAM_BOT_ID'),
                p_chat: sender.chatId,
                p_user: sender.userId,
                p_update: sender.updateId,
                p_at: sender.at,
                p_command: command.kind,
                p_hash: command.kind === 'confirm' || command.kind === 'preview'
                    ? await nonceHash(command.nonce)
                    : null,
            });
            // A failed progress-spinner acknowledgement must not suppress the consent result reply.
            if (confirmation && deps.answer) await deps.answer(confirmation.callbackId).catch(() => false);
            if (!shoreRecord(result)) return jsonResponse({ accepted: true });
            let text: string | null = typeof result.text === 'string' && result.text.length <= 1000
                ? result.text
                : null;
            if (shoreRecord(result.position)) {
                const p = result.position;
                if (
                    typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 &&
                    typeof p.lon === 'number' && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180 &&
                    typeof p.at === 'number' && Number.isSafeInteger(p.at) && p.at <= deps.now() &&
                    p.at > deps.now() - 900_000
                ) {
                    text = `Explicitly shared vessel position: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}. Measured ${
                        new Date(p.at).toISOString()
                    }. This is a saved report, not live tracking. Use /stop to revoke.`;
                }
            }
            let previewNonce: string | undefined;
            if (
                command.kind === 'preview' && shoreRecord(result.invitation) &&
                Object.keys(result.invitation).length === 1 && typeof result.invitation.sharePosition === 'boolean'
            ) {
                text = 'This invitation requests consent for personal anchor-watch notices. ' +
                    (result.invitation.sharePosition
                        ? 'Position sharing is ON: /where may show a fresh saved report from the explicitly registered vessel. '
                        : 'Position sharing is OFF. ') +
                    'These notices are not an emergency service or a delivery guarantee. Confirm only if you know the sender and agree. ' +
                    'The owner must separately enable notices. Use /stop to revoke. This confirmation expires in five minutes.';
                previewNonce = command.nonce;
            }
            if (text) await deps.send(sender.chatId, text, previewNonce);
            return jsonResponse({ accepted: true });
        } catch {
            return jsonResponse({ error: 'Webhook unavailable' }, 503);
        }
    };
}
