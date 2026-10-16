import { createShoreHandler, type ShoreDependencies } from './handler.ts';
import { nonceHash, revokeNonce, sendShoreEmail, sendShoreTelegram, shoreBackend } from './transport.ts';
const id = '10000000-0000-4000-8000-000000000001', rev = '20000000-0000-4000-8000-000000000001', nonce = 'a'.repeat(64);
const config: Record<string, string> = {
    SHORE_MESSAGING_ENABLED: '1',
    SHORE_REVOKE_HMAC_KEY: 'b'.repeat(64),
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service',
    TELEGRAM_BOT_ID: '456',
    TELEGRAM_BOT_USERNAME: 'fixture_bot',
};
const env = { get: (k: string) => config[k] };
function eq(a: unknown, b: unknown) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`Mismatch: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
}
function fixture() {
    const calls: { name: string; args: unknown }[] = [], sent: { to: string; text: string }[] = [];
    const deps: ShoreDependencies = {
        owner: async () => id,
        rpc: async (name, args) => {
            calls.push({ name, args });
            return name === 'shore_invite'
                ? {
                    invitationId: id,
                    channel: 'email',
                    address: 'person@example.invalid',
                    sharePosition: false,
                    botId: '456',
                }
                : name === 'shore_consent'
                ? true
                : null;
        },
        nonce: () => nonce,
        email: async (to, text) => {
            sent.push({ to, text });
            return true;
        },
        telegram: async () => {
            throw new Error('Unexpected Telegram send');
        },
    };
    return { calls, sent, deps, handler: createShoreHandler(env, deps) };
}
const request = (body: unknown, auth = 'Bearer fixture-user') =>
    new Request('https://edge.fixture.invalid/anchor-alert-messaging', {
        method: 'POST',
        headers: { authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
Deno.test('GET/link scanners and unaccepted POST never consume a nonce', async () => {
    const f = fixture();
    eq((await f.handler(new Request('https://edge.fixture.invalid/anchor-alert-messaging'))).status, 405);
    eq((await f.handler(request({ action: 'confirm', nonce, accepted: false }))).status, 400);
    eq(f.calls, []);
    eq(f.sent, []);
});
Deno.test('anonymous nonce confirmation is explicit and passes only SHA256', async () => {
    const f = fixture();
    const r = await f.handler(request({ action: 'confirm', nonce, accepted: true }, ''));
    eq(r.status, 200);
    eq(f.calls, [{ name: 'shore_consent', args: { p_hash: await nonceHash(nonce), p_action: 'confirm' } }]);
    eq(f.sent, []);
});
Deno.test('strict shape/byte cap refuses caller URLs, owners and arbitrary messages', async () => {
    for (
        const body of [{ action: 'invite', contactId: id, revision: rev, url: 'https://bad.invalid' }, {
            action: 'confirm',
            nonce,
            accepted: true,
            ownerId: id,
        }, { action: 'confirm', nonce: nonce + 'x'.repeat(5000), accepted: true }]
    ) {
        const f = fixture();
        eq((await f.handler(request(body))).status, 400);
        eq(f.calls, []);
    }
});
Deno.test('owner Auth identity wins; stored recipient only; raw nonce never returned', async () => {
    const f = fixture();
    const r = await f.handler(request({ action: 'invite', contactId: id, revision: rev }));
    eq(r.status, 200);
    const text = await r.text();
    eq(text.includes(nonce), false);
    eq(text.includes('person@'), false);
    eq(f.sent.length, 1);
    eq(f.sent[0].to, 'person@example.invalid');
    eq(f.sent[0].text.includes('#shore=confirm.' + nonce), true);
    eq(f.sent[0].text.includes('Position sharing is off'), true);
    eq((f.calls[0].args as Record<string, unknown>).p_owner, id);
    eq(JSON.stringify(f.calls).includes(nonce), false);
});
Deno.test('anonymous owner invite and client work lane refuse before database use', async () => {
    const f = fixture();
    f.deps.owner = async () => null;
    eq((await f.handler(request({ action: 'invite', contactId: id, revision: rev }))).status, 401);
    eq((await f.handler(request({ action: 'work' }))).status, 401);
    eq(f.calls, []);
});
Deno.test('held env refuses even valid requests without dependencies/network', async () => {
    const f = fixture();
    const h = createShoreHandler({ get: (k) => k === 'SHORE_MESSAGING_ENABLED' ? '0' : config[k] }, f.deps);
    eq((await h(request({ action: 'confirm', nonce, accepted: true }))).status, 503);
    eq(f.calls, []);
});
Deno.test('recipient revocation remains available while messaging is held', async () => {
    const f = fixture(),
        h = createShoreHandler({ get: (k) => k === 'SHORE_MESSAGING_ENABLED' ? '0' : config[k] }, f.deps);
    eq((await h(request({ action: 'revoke', nonce, accepted: true }, ''))).status, 200);
    eq(f.calls[0], { name: 'shore_consent', args: { p_hash: await nonceHash(nonce), p_action: 'revoke' } });
    eq(f.sent, []);
});
Deno.test('HMAC revocation is distinct, reproducible, contact/revision-bound', async () => {
    const a = await revokeNonce(env, id, rev);
    eq(a.length, 64);
    eq(a === nonce, false);
    eq(await revokeNonce(env, id, rev), a);
    eq(await revokeNonce(env, rev, id) === a, false);
});
Deno.test('provider calls use fixed hosts/no redirects and exact saved destination', async () => {
    let calls = 0;
    const e = {
        get: (
            k: string,
        ) => ({
            SHORE_MESSAGING_ENABLED: '1',
            RESEND_API_KEY: 'fixture',
            FOUNDING_SKIPPER_APPLICANT_FROM: 'Thalassa <sender@example.invalid>',
        }[k]),
    };
    const fetcher: typeof fetch = async (input, init) => {
        calls++;
        eq(input, 'https://api.resend.com/emails');
        eq(init?.redirect, 'error');
        const b = JSON.parse(String(init?.body));
        eq(b.to, ['person@example.invalid']);
        eq(b.text, 'fixed words');
        return Response.json({ id: 'fixture-provider-id' });
    };
    eq(await sendShoreEmail(e, fetcher, 'person@example.invalid', 'fixed words', `shore-${id}-invite`), true);
    eq(await sendShoreEmail(e, fetcher, 'bad\r\n@example.invalid', 'fixed words', `shore-${id}-invite`), false);
    eq(calls, 1);
});
Deno.test('no provider request for absent Telegram token; Telegram token URLs/errors never escape', async () => {
    let calls = 0;
    eq(
        await sendShoreTelegram(
            env,
            async () => {
                calls++;
                throw new Error('No network');
            },
            '123',
            'fixed',
        ),
        false,
    );
    eq(calls, 0);
    const h = createShoreHandler(env, undefined, async () => {
        throw new Error('secret upstream raw url');
    });
    const response = await h(request({ action: 'invite', contactId: id, revision: rev }));
    eq((await response.text()).includes('secret upstream'), false);
});
Deno.test('fixed backend RPC allowlist and redirect refusal protect service credentials', async () => {
    let calls = 0;
    const backend = shoreBackend(
        { get: (k) => k === 'SUPABASE_URL' ? 'https://project.fixture.invalid' : config[k] },
        async (_url, init) => {
            calls++;
            eq(init?.redirect, 'error');
            return Response.json(true);
        },
    );
    try {
        await backend.rpc('arbitrary_table', {});
        throw new Error('Accepted');
    } catch (e) {
        eq((e as Error).message, 'Fixed procedure required');
    }
    eq(calls, 0);
    eq(await backend.rpc('shore_consent', {}), true);
    eq(calls, 1);
});
Deno.test('worker never sends after last guard refuses; source time remains original', async () => {
    const f = fixture();
    let claims = 0;
    f.deps.rpc = async (name, args) => {
        f.calls.push({ name, args });
        if (name === 'shore_anchor_enqueue') return { after: null, queued: 0 };
        if (name === 'shore_delivery_claim') {
            return claims++ ? null : {
                id,
                revision: rev,
                contactId: id,
                revokeKey: rev,
                revokeHash: await nonceHash(await revokeNonce(env, id, rev)),
                channel: 'email',
                address: 'person@example.invalid',
                kind: 'contact_lost',
                at: Date.now() - 1000,
            };
        }
        if (name === 'shore_delivery_guard') return false;
        return null;
    };
    const r = await f.handler(request({ action: 'work' }, 'Bearer fixture-service'));
    eq(r.status, 200);
    eq(f.sent, []);
    eq(f.calls.at(-1), { name: 'shore_worker_finish', args: { p_success: true } });
});
