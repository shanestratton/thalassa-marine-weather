import { createTelegramWebhook } from './handler.ts';
import {
    privateTelegramConfirmation,
    privateTelegramSender,
    shoreBotCommand,
    shoreConfirmationData,
} from '../../../utils/shoreContacts.ts';
const secret = 'fixture_' + 'x'.repeat(40),
    now = Date.now(),
    env = {
        get: (
            k: string,
        ) => ({ TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_BOT_ID: '456', SHORE_MESSAGING_ENABLED: '1' }[k]),
    };
function eq(a: unknown, b: unknown) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Unexpected result');
}
const body = (patch: Record<string, unknown> = {}) => ({
    update_id: 1,
    message: {
        chat: { type: 'private', id: 123 },
        from: { id: 123, is_bot: false },
        text: '/where',
        date: Math.floor(now / 1000),
        ...patch,
    },
});
const req = (b: unknown, s = secret) =>
    new Request('https://edge.fixture.invalid/telegram-webhook', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': s },
        body: JSON.stringify(b),
    });
function fixture(result: unknown = { text: 'Position unavailable: no fresh receipt.' }) {
    const calls: unknown[] = [], sent: unknown[] = [];
    const handler = createTelegramWebhook(env, {
        now: () => now,
        rpc: async (name, args) => {
            calls.push({ name, args });
            return result;
        },
        send: async (chat, text, nonce) => {
            sent.push({ chat, text, ...(nonce ? { nonce } : {}) });
            return true;
        },
    });
    return { handler, calls, sent };
}
Deno.test('secret authentication precedes body/db/network', async () => {
    const f = fixture();
    eq((await f.handler(req(body(), 'wrong'))).status, 401);
    eq(f.calls, []);
    eq(f.sent, []);
});
const nonce = 'ab'.repeat(32);
const callback = () => ({
    update_id: 2,
    callback_query: {
        id: 'callback_fixture',
        from: { id: 123, is_bot: false },
        data: shoreConfirmationData(nonce),
        message: { date: Math.floor(now / 1000), from: { id: 456, is_bot: true }, chat: { type: 'private', id: 123 } },
    },
});
Deno.test('start only previews explicit anchor and position permissions; never confirms', async () => {
    for (const sharePosition of [false, true]) {
        const f = fixture({ invitation: { sharePosition } });
        await f.handler(req(body({ text: '/start ' + nonce })));
        eq((f.calls[0] as { args: Record<string, unknown> }).args.p_command, 'preview');
        const sent = f.sent[0] as { text: string; nonce: string };
        eq(sent.text.includes('anchor-watch notices'), true);
        eq(sent.text.includes(sharePosition ? 'Position sharing is ON' : 'Position sharing is OFF'), true);
        eq(sent.text.includes('Use /stop'), true);
        eq(sent.nonce, nonce);
        eq(f.calls.length, 1);
    }
});
Deno.test('explicit private callback alone confirms; callback nonce is canonical and below64bytes', async () => {
    const f = fixture({ text: 'Consent recorded.' });
    await f.handler(req(callback()));
    eq((f.calls[0] as { args: Record<string, unknown> }).args.p_command, 'confirm');
    eq(shoreConfirmationData(nonce).length, 57);
    eq(privateTelegramConfirmation(callback(), '456')?.nonce, nonce);
    eq(privateTelegramSender(callback()), null);
});
Deno.test('forwarded/group/foreignbot/mismatched/expired callback cannot confirm', async () => {
    const valid = callback();
    for (
        const c of [
            { ...valid.callback_query, from: { id: 124, is_bot: false } },
            { ...valid.callback_query, message: { ...valid.callback_query.message, chat: { id: 123, type: 'group' } } },
            { ...valid.callback_query, message: { ...valid.callback_query.message, from: { id: 457, is_bot: true } } },
            { ...valid.callback_query, inline_message_id: 'foreign_inline' },
            {
                ...valid.callback_query,
                message: { ...valid.callback_query.message, date: Math.floor(now / 1000) - 301 },
            },
            { ...valid.callback_query, data: 'shore-confirm:' + '_'.repeat(43) },
            { ...valid.callback_query, id: 'bad\ncallback' },
        ]
    ) {
        const f = fixture();
        await f.handler(req({ ...valid, callback_query: c }));
        eq(f.calls, []);
        eq(f.sent, []);
    }
});
Deno.test('verified /stop still retires consent while ordinary messaging is held', async () => {
    let calls = 0;
    const h = createTelegramWebhook({ get: (k) => k === 'SHORE_MESSAGING_ENABLED' ? '0' : env.get(k) }, {
        now: () => now,
        rpc: async (_name, args) => {
            eq((args as Record<string, unknown>).p_command, 'stop');
            calls++;
            return null;
        },
        send: async () => {
            throw new Error('No provider');
        },
    });
    eq((await h(req(body({ text: '/stop' })))).status, 200);
    eq(calls, 1);
});
Deno.test('no group/channel/username authority, bot sender or chat/user mismatch', () => {
    for (
        const patch of [
            { chat: { type: 'group', id: 123 } },
            { chat: { type: 'private', id: 124 } },
            { from: { id: 123, is_bot: true } },
            { chat: { type: 'channel', id: 123 } },
            { from: { username: 'person' } },
        ]
    ) eq(privateTelegramSender(body(patch)), null);
    eq(shoreBotCommand('/where@somebot'), null);
    eq(shoreBotCommand('/start ' + 'x'.repeat(64)), null);
});
Deno.test('old/future webhook dates do not create fresh reports or send replies', async () => {
    for (const date of [Math.floor((now - 600000) / 1000), Math.floor((now + 60000) / 1000)]) {
        const f = fixture();
        eq((await f.handler(req(body({ date })))).status, 200);
        eq(f.calls, []);
        eq(f.sent, []);
    }
});
Deno.test('known private sender forwards stable IDs and original message clock only', async () => {
    const f = fixture();
    await f.handler(req(body()));
    const c = (f.calls[0] as { args: Record<string, unknown> }).args;
    eq(c.p_chat, '123');
    eq(c.p_user, '123');
    eq(c.p_at, Math.floor(now / 1000) * 1000);
    eq(c.p_command, 'where');
    eq(JSON.stringify(f.calls).includes('username'), false);
});
Deno.test('unknown or malformed/overlarge message creates no command', async () => {
    for (
        const b of [body({ text: 'raw boat command' }), body({ text: '/where' + 'x'.repeat(9000) }), {
            ...body(),
            update_id: -1,
        }]
    ) {
        const f = fixture();
        await f.handler(req(b));
        eq(f.calls, []);
        eq(f.sent, []);
    }
});
