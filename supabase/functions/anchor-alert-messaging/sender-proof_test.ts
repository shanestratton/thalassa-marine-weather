import { readEmailSenderProof } from './sender-proof.ts';
const key = 'fixture-read-only-key';
const env = {
    get: (name: string) =>
        name === 'RESEND_API_KEY'
            ? key
            : name === 'FOUNDING_SKIPPER_APPLICANT_FROM'
            ? 'Fixture <notices@example.invalid>'
            : undefined,
};
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, name = 'example.invalid') => ({
    id: id(n),
    name,
    status: 'verified',
    capabilities: { sending: 'enabled' },
});
const response = (data: unknown[], has_more = false) =>
    new Response(JSON.stringify({ object: 'list', data, has_more }), { status: 200 });
const equal = (a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw Error('Sender proof assertion failed');
};
Deno.test('sender proof never fetches with absent or malformed sender configuration', async () => {
    let calls = 0;
    const fake: typeof fetch = () => {
        calls++;
        throw Error('Must not fetch');
    };
    for (
        const from of [undefined, 'Bad <notices@example.invalid', 'notices@example.invalid>', 'bad\n@example.invalid']
    ) {
        const proof = await readEmailSenderProof({ get: (name) => name === 'RESEND_API_KEY' ? key : from }, fake);
        equal(proof.check, 'not_configured');
    }
    equal(calls, 0);
});
Deno.test('sender proof uses only authenticated fixed-host bounded GET and returns no sender or key', async () => {
    const proof = await readEmailSenderProof(env, (input, init) => {
        equal(String(input), 'https://api.resend.com/domains?limit=25');
        equal(init?.method, 'GET');
        equal(init?.redirect, 'error');
        equal(init?.body, undefined);
        equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
        return Promise.resolve(response([item(1)]));
    });
    equal([proof.check, proof.senderVerified], ['verified', true]);
    equal(JSON.stringify(proof).includes(key) || JSON.stringify(proof).includes('example.invalid'), false);
});
Deno.test('sender proof requires exact verified domain and explicit sending capability', async () => {
    for (
        const entry of [item(1, 'parent.invalid'), item(1, 'sub.example.invalid'), { ...item(1), status: 'pending' }, {
            ...item(1),
            capabilities: { sending: 'disabled' },
        }, { ...item(1), capabilities: undefined }]
    ) {
        const proof = await readEmailSenderProof(env, () => Promise.resolve(response([entry])));
        equal([proof.check, proof.senderVerified], ['unverified', false]);
    }
});
Deno.test('sender proof distinguishes denied metadata access without claiming an invalid send key', async () => {
    for (const status of [401, 403]) {
        const proof = await readEmailSenderProof(env, () => Promise.resolve(new Response(null, { status })));
        equal([proof.check, proof.senderVerified], ['read_denied', false]);
    }
});
Deno.test('sender proof follows only bounded canonical cursors and fails closed on a full scan', async () => {
    let calls = 0;
    const proof = await readEmailSenderProof(env, (url) => {
        calls++;
        equal(String(url), `https://api.resend.com/domains?limit=25${calls === 2 ? '&after=' + id(1) : ''}`);
        return Promise.resolve(response([item(calls, 'other.invalid')], true));
    });
    equal([calls, proof.check, proof.senderVerified], [2, 'incomplete', false]);
});
Deno.test('sender proof refuses malformed, oversized and uncertain provider metadata', async () => {
    for (
        const fake of [
            () => Promise.resolve(new Response('not JSON')),
            () => Promise.resolve(response(Array.from({ length: 26 }, (_, i) => item(i)))),
            () => Promise.resolve(new Response('x'.repeat(17000))),
            () => Promise.reject(Error('Synthetic transport error')),
        ]
    ) {
        const proof = await readEmailSenderProof(env, fake);
        equal([proof.check, proof.senderVerified], ['unavailable', false]);
    }
});
