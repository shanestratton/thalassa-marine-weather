// @vitest-environment node
/**
 * Pure synthetic packet, summary and inventory metadata only. These tests do
 * not exercise credentials, Auth, hosted actors, native code or cryptography,
 * and do not establish provider authentication or an independent audit.
 */
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { validateActorInventory, validateNativePacket, validateNativeSummary } from './nativePmFixture.mjs';

const RUN_ID = '71000000-0000-4000-8000-000000000001';
const OTHER_RUN_ID = '71000000-0000-4000-8000-000000000002';
const PROJECT = 'kmtupdvwdgbhtssqqova';
const ORIGIN = `https://${PROJECT}.supabase.co`;
const BASE_PATH = '/functions/v1/scuttlebutt-e2ee-pilot';
const HUMANS = ['f79ace09-0bcd-4ce5-a24d-1fb89a9e1c73', '8fb85554-2385-49e9-8928-80d9407c05b1'];
const USER_IDS = ['81000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000002'];
const DEVICE_IDS = ['82000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000002'];
const IDENTITY_IDS = ['83000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000002'];
const MESSAGE_IDS = [
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000003',
];
const NATIVE_EMAILS = ['e2ee-native-fixture-a@thalassa.invalid', 'e2ee-native-fixture-b@thalassa.invalid'];
const OLD_EMAILS = [
    'e2ee-fixture-a@thalassa.invalid',
    'e2ee-fixture-b@thalassa.invalid',
    'e2ee-cutover-fixture-a@thalassa.invalid',
    'e2ee-cutover-fixture-b@thalassa.invalid',
];
const PUBLIC_KEY = 'sb_publishable_native_fixture_12345';
const INVALID_UUIDS = [
    'not-a-uuid',
    '00000000-0000-0000-0000-000000000000',
    '81000000-0000-4000-8000-00000000000A',
    `${USER_IDS[0]}\n`,
];
const INVALID_HASHES = ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(64)}\n`];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const orderById = <T extends { id: string }>(actors: T[]): T[] =>
    [...actors].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

type PacketAccount = { userId: string; email: string; accessToken: string };
type Packet = {
    version: number;
    runID: string;
    project: string;
    projectOrigin: string;
    serviceBasePath: string;
    publicApiKey: string;
    conversationId: string;
    accounts: PacketAccount[];
};
type Summary = {
    version: number;
    runID: string;
    status: string;
    assertions: number;
    accounts: { userId: string; deviceId: string; identityKeyId: string; bundleSha256: string }[];
    messages: { senderUserId: string; recipientUserId: string; clientMessageId: string; envelopeSha256: string }[];
};
type Actor = { id: string; email: string };
type NativeActor = { userId: string; email: string };
type Mutation<T> = { name: string; mutate: (value: T) => void };

function packet(): Packet {
    return {
        version: 1,
        runID: RUN_ID,
        project: PROJECT,
        projectOrigin: ORIGIN,
        serviceBasePath: BASE_PATH,
        publicApiKey: PUBLIC_KEY,
        conversationId: `native-pm-${RUN_ID}`,
        accounts: USER_IDS.map((userId, index) => ({
            userId,
            email: NATIVE_EMAILS[index],
            accessToken: `synthetic-native-fixture-${index + 1}.bearer`,
        })),
    };
}

function summary(messageCount: 2 | 3 = 2): Summary {
    return {
        version: 1,
        runID: RUN_ID,
        status: 'passed',
        assertions: 42,
        accounts: USER_IDS.map((userId, index) => ({
            userId,
            deviceId: DEVICE_IDS[index],
            identityKeyId: IDENTITY_IDS[index],
            bundleSha256: (index === 0 ? 'a' : 'b').repeat(64),
        })),
        messages: MESSAGE_IDS.slice(0, messageCount).map((clientMessageId, index) => ({
            senderUserId: USER_IDS[index % 2],
            recipientUserId: USER_IDS[(index + 1) % 2],
            clientMessageId,
            envelopeSha256: ['c', 'd', 'e'][index].repeat(64),
        })),
    };
}

function originalActors(): Actor[] {
    return [
        { id: HUMANS[0], email: 'synthetic-human-one@example.invalid' },
        { id: HUMANS[1], email: 'synthetic-human-two@example.invalid' },
        ...OLD_EMAILS.map((email, index) => ({ id: `51000000-0000-4000-8000-00000000000${index + 1}`, email })),
    ];
}

function nativeActors(): NativeActor[] {
    return USER_IDS.map((userId, index) => ({ userId, email: NATIVE_EMAILS[index] }));
}

function allActors(): Actor[] {
    return [...originalActors(), ...nativeActors().map(({ userId: id, email }) => ({ id, email }))];
}

function expectDeepFrozen(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) expectDeepFrozen(child);
}

// A JWT-shaped configuration fixture is deliberately unsigned. Its declared
// role can be checked locally; this supplies no proof that a provider issued it.
function declaredRoleKey(role: string): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, ref: PROJECT })}.synthetic_signature`;
}

describe('native input packet — synthetic metadata contract', () => {
    it('returns a separate deeply frozen exact packet for the two fixed fixture actors', () => {
        const value = packet();
        const expected = clone(value);
        const result = validateNativePacket(value, RUN_ID);
        expect(result).toEqual(expected);
        expect(result).not.toBe(value);
        expect(result.accounts).not.toBe(value.accounts);
        for (let index = 0; index < 2; index++) expect(result.accounts[index]).not.toBe(value.accounts[index]);
        expectDeepFrozen(result);
        value.accounts[0].accessToken = 'caller-mutated-synthetic-token';
        value.accounts.reverse();
        expect(result).toEqual(expected);
    });

    it('accepts an anon-role declaration without treating the declaration as authentication', () => {
        const value = packet();
        value.publicApiKey = declaredRoleKey('anon');
        expect(validateNativePacket(value, RUN_ID).publicApiKey).toBe(value.publicApiKey);
    });

    const invalid: Mutation<Packet>[] = [
        { name: 'extra top-level credential', mutate: (value) => Object.assign(value, { password: 'synthetic' }) },
        {
            name: 'missing key',
            mutate: (value) => {
                Reflect.deleteProperty(value, 'publicApiKey');
            },
        },
        {
            name: 'unsupported version',
            mutate: (value) => {
                value.version = 2;
            },
        },
        {
            name: 'wrong run binding',
            mutate: (value) => {
                value.runID = OTHER_RUN_ID;
            },
        },
        {
            name: 'wrong isolated project',
            mutate: (value) => {
                value.project = 'another-project';
            },
        },
        {
            name: 'wrong origin',
            mutate: (value) => {
                value.projectOrigin = 'https://example.invalid';
            },
        },
        {
            name: 'origin with suffix',
            mutate: (value) => {
                value.projectOrigin += '/';
            },
        },
        {
            name: 'wrong service path',
            mutate: (value) => {
                value.serviceBasePath = '/functions/v1/another';
            },
        },
        {
            name: 'path with query',
            mutate: (value) => {
                value.serviceBasePath += '?key=synthetic';
            },
        },
        {
            name: 'wrong conversation',
            mutate: (value) => {
                value.conversationId = `native-pm-${OTHER_RUN_ID}`;
            },
        },
        {
            name: 'zero accounts',
            mutate: (value) => {
                value.accounts = [];
            },
        },
        {
            name: 'one account',
            mutate: (value) => {
                value.accounts.pop();
            },
        },
        {
            name: 'three accounts',
            mutate: (value) => {
                value.accounts.push(clone(value.accounts[0]));
            },
        },
        {
            name: 'repeated user ID',
            mutate: (value) => {
                value.accounts[1].userId = value.accounts[0].userId;
            },
        },
        {
            name: 'swapped fixed emails',
            mutate: (value) => {
                value.accounts.reverse();
            },
        },
        {
            name: 'unreserved fixture email',
            mutate: (value) => {
                value.accounts[0].email = OLD_EMAILS[0];
            },
        },
        {
            name: 'extra account password',
            mutate: (value) => Object.assign(value.accounts[0], { password: 'synthetic' }),
        },
        {
            name: 'missing access token',
            mutate: (value) => {
                Reflect.deleteProperty(value.accounts[0], 'accessToken');
            },
        },
        {
            name: 'reused access token',
            mutate: (value) => {
                value.accounts[1].accessToken = value.accounts[0].accessToken;
            },
        },
        {
            name: 'public key reused as bearer',
            mutate: (value) => {
                value.accounts[0].accessToken = value.publicApiKey;
            },
        },
        {
            name: 'empty bearer',
            mutate: (value) => {
                value.accounts[0].accessToken = '';
            },
        },
        {
            name: 'bearer with whitespace',
            mutate: (value) => {
                value.accounts[0].accessToken += '\n';
            },
        },
        {
            name: 'oversized bearer',
            mutate: (value) => {
                value.accounts[0].accessToken = 'a'.repeat(8193);
            },
        },
        {
            name: 'arbitrary public key',
            mutate: (value) => {
                value.publicApiKey = 'synthetic-untyped-key';
            },
        },
        {
            name: 'service-role declaration',
            mutate: (value) => {
                value.publicApiKey = declaredRoleKey('service_role');
            },
        },
        {
            name: 'authenticated-role declaration',
            mutate: (value) => {
                value.publicApiKey = declaredRoleKey('authenticated');
            },
        },
    ];

    it.each(invalid)('rejects $name', ({ mutate }) => {
        const value = packet();
        mutate(value);
        expect(() => validateNativePacket(value, RUN_ID)).toThrow();
    });

    it.each(HUMANS)('denies reserved human actor %s even with an empty caller denylist', (userId) => {
        const value = packet();
        value.accounts[0].userId = userId;
        expect(() => validateNativePacket(value, RUN_ID, [])).toThrow();
    });

    it('denies old fixture IDs explicitly supplied by the caller', () => {
        const value = packet();
        value.accounts[0].userId = originalActors()[2].id;
        expect(() =>
            validateNativePacket(
                value,
                RUN_ID,
                originalActors().map(({ id }) => id),
            ),
        ).toThrow();
    });

    it.each(INVALID_UUIDS)('rejects noncanonical or nil actor UUID %s', (userId) => {
        const value = packet();
        value.accounts[0].userId = userId;
        expect(() => validateNativePacket(value, RUN_ID)).toThrow();
    });

    it.each(INVALID_UUIDS)('rejects noncanonical or nil run UUID %s', (runID) => {
        const value = packet();
        value.runID = runID;
        value.conversationId = `native-pm-${runID}`;
        expect(() => validateNativePacket(value, runID)).toThrow();
    });

    it('rejects accessors and hidden or symbolic own fields without evaluating a getter', () => {
        let reads = 0;
        const accessor = packet();
        Object.defineProperty(accessor.accounts[0], 'accessToken', {
            enumerable: true,
            get: () => {
                reads++;
                return 'synthetic';
            },
        });
        expect(() => validateNativePacket(accessor, RUN_ID)).toThrow();
        expect(reads).toBe(0);
        const hidden = packet();
        Object.defineProperty(hidden, 'hidden', { value: 'synthetic', enumerable: false });
        expect(() => validateNativePacket(hidden, RUN_ID)).toThrow();
        const symbolic = packet();
        Object.defineProperty(symbolic.accounts[0], Symbol('extra'), { value: 'synthetic' });
        expect(() => validateNativePacket(symbolic, RUN_ID)).toThrow();
    });
});

describe('native result summary — structural diagnostics, not proof of encryption', () => {
    it.each([2, 3] as const)('accepts and freezes the fixed %i-message exchange', (messageCount) => {
        const value = summary(messageCount);
        const expected = clone(value);
        const result = validateNativeSummary(value, { runID: RUN_ID, userIds: USER_IDS });
        expect(result).toEqual(expected);
        expect(result).not.toBe(value);
        expect(result.accounts).not.toBe(value.accounts);
        expect(result.messages).not.toBe(value.messages);
        for (let index = 0; index < 2; index++) expect(result.accounts[index]).not.toBe(value.accounts[index]);
        for (let index = 0; index < messageCount; index++)
            expect(result.messages[index]).not.toBe(value.messages[index]);
        expectDeepFrozen(result);
        value.accounts[0].deviceId = DEVICE_IDS[1];
        value.messages[0].envelopeSha256 = 'f'.repeat(64);
        expect(result).toEqual(expected);
    });

    it('normalizes message order by the fixed client IDs before validating directions', () => {
        const value = summary(3);
        value.messages.reverse();
        expect(validateNativeSummary(value, { runID: RUN_ID, userIds: USER_IDS }).messages).toEqual(
            summary(3).messages,
        );
    });

    const invalid: Mutation<Summary>[] = [
        {
            name: 'extra top-level contents',
            mutate: (value) => Object.assign(value, { plaintext: 'synthetic content' }),
        },
        {
            name: 'missing assertions',
            mutate: (value) => {
                Reflect.deleteProperty(value, 'assertions');
            },
        },
        {
            name: 'unsupported version',
            mutate: (value) => {
                value.version = 2;
            },
        },
        {
            name: 'wrong run',
            mutate: (value) => {
                value.runID = OTHER_RUN_ID;
            },
        },
        {
            name: 'incomplete status',
            mutate: (value) => {
                value.status = 'incomplete';
            },
        },
        {
            name: 'no assertions',
            mutate: (value) => {
                value.assertions = 0;
            },
        },
        {
            name: 'fractional assertions',
            mutate: (value) => {
                value.assertions = 1.5;
            },
        },
        {
            name: 'oversized assertions',
            mutate: (value) => {
                value.assertions = 10001;
            },
        },
        {
            name: 'nonfinite assertions',
            mutate: (value) => {
                value.assertions = Infinity;
            },
        },
        {
            name: 'one account',
            mutate: (value) => {
                value.accounts.pop();
            },
        },
        {
            name: 'extra account',
            mutate: (value) => {
                value.accounts.push(clone(value.accounts[0]));
            },
        },
        {
            name: 'unbound account',
            mutate: (value) => {
                value.accounts[0].userId = OTHER_RUN_ID;
            },
        },
        {
            name: 'reserved human account',
            mutate: (value) => {
                value.accounts[0].userId = HUMANS[0];
            },
        },
        {
            name: 'repeated account',
            mutate: (value) => {
                value.accounts[1].userId = value.accounts[0].userId;
            },
        },
        {
            name: 'repeated device',
            mutate: (value) => {
                value.accounts[1].deviceId = value.accounts[0].deviceId;
            },
        },
        {
            name: 'repeated identity key ID',
            mutate: (value) => {
                value.accounts[1].identityKeyId = value.accounts[0].identityKeyId;
            },
        },
        { name: 'extra private key', mutate: (value) => Object.assign(value.accounts[0], { privateKey: 'synthetic' }) },
        {
            name: 'extra account token',
            mutate: (value) => Object.assign(value.accounts[0], { accessToken: 'synthetic' }),
        },
        {
            name: 'one message',
            mutate: (value) => {
                value.messages.pop();
            },
        },
        {
            name: 'four messages',
            mutate: (value) => {
                value.messages.push(clone(value.messages[0]), clone(value.messages[1]));
            },
        },
        {
            name: 'self-directed opening',
            mutate: (value) => {
                value.messages[0].recipientUserId = value.messages[0].senderUserId;
            },
        },
        {
            name: 'outsider sender',
            mutate: (value) => {
                value.messages[0].senderUserId = HUMANS[1];
            },
        },
        {
            name: 'outsider recipient',
            mutate: (value) => {
                value.messages[0].recipientUserId = OTHER_RUN_ID;
            },
        },
        {
            name: 'reply in opening direction',
            mutate: (value) => {
                value.messages[1].senderUserId = USER_IDS[0];
                value.messages[1].recipientUserId = USER_IDS[1];
            },
        },
        {
            name: 'unexpected client message ID',
            mutate: (value) => {
                value.messages[1].clientMessageId = OTHER_RUN_ID;
            },
        },
        {
            name: 'repeated client message ID',
            mutate: (value) => {
                value.messages[1].clientMessageId = value.messages[0].clientMessageId;
            },
        },
        {
            name: 'third ID replacing reply',
            mutate: (value) => {
                value.messages[1].clientMessageId = MESSAGE_IDS[2];
            },
        },
        { name: 'extra ciphertext', mutate: (value) => Object.assign(value.messages[0], { ciphertext: 'synthetic' }) },
        {
            name: 'extra plaintext',
            mutate: (value) => Object.assign(value.messages[0], { plaintext: 'synthetic content' }),
        },
        {
            name: 'missing envelope diagnostic',
            mutate: (value) => {
                Reflect.deleteProperty(value.messages[0], 'envelopeSha256');
            },
        },
    ];

    it.each(invalid)('rejects $name', ({ mutate }) => {
        const value = summary();
        mutate(value);
        expect(() => validateNativeSummary(value, { runID: RUN_ID, userIds: USER_IDS })).toThrow();
    });

    it('rejects the optional third message in the reply direction', () => {
        const value = summary(3);
        value.messages[2].senderUserId = USER_IDS[1];
        value.messages[2].recipientUserId = USER_IDS[0];
        expect(() => validateNativeSummary(value, { runID: RUN_ID, userIds: USER_IDS })).toThrow();
    });

    it.each(INVALID_UUIDS)('rejects noncanonical or nil device/identity UUID %s', (id) => {
        for (const field of ['deviceId', 'identityKeyId'] as const) {
            const value = summary();
            value.accounts[0][field] = id;
            expect(() => validateNativeSummary(value, { runID: RUN_ID, userIds: USER_IDS })).toThrow();
        }
    });

    it.each(INVALID_HASHES)('rejects noncanonical bundle/envelope SHA-256 %s', (digest) => {
        const badBundle = summary();
        badBundle.accounts[0].bundleSha256 = digest;
        expect(() => validateNativeSummary(badBundle, { runID: RUN_ID, userIds: USER_IDS })).toThrow();
        const badEnvelope = summary();
        badEnvelope.messages[0].envelopeSha256 = digest;
        expect(() => validateNativeSummary(badEnvelope, { runID: RUN_ID, userIds: USER_IDS })).toThrow();
    });
});

describe('native actor inventory — exactly six old actors and two fixed additions', () => {
    it('accepts only the fixed initial six and copies the id/email metadata', () => {
        const value = originalActors()
            .reverse()
            .map((actor) => ({
                ...actor,
                aud: 'authenticated',
                app_metadata: { provider: 'email' },
                created_at: '2026-10-07T00:00:00.000Z',
            }));
        const result = validateActorInventory(value);
        expect(result).toEqual(orderById(originalActors()));
        expect(result).not.toBe(value);
        expect(result.every((actor: Actor) => !value.includes(actor as (typeof value)[number]))).toBe(true);
        expectDeepFrozen(result);
        value[0].email = 'caller-mutated@example.invalid';
        expect(result).toEqual(orderById(originalActors()));
    });

    it('accepts exactly the preserved initial six plus the fixed native pair', () => {
        const value = allActors().reverse();
        const oldActors = validateActorInventory(originalActors());
        const additions = nativeActors();
        const result = validateActorInventory(value, oldActors, additions);
        expect(result).toEqual(orderById(allActors()));
        expect(result).not.toBe(value);
        expect(result.every((actor: Actor) => !value.includes(actor))).toBe(true);
        expectDeepFrozen(result);
        value[0].email = 'caller-mutated@example.invalid';
        additions[0].email = 'caller-mutated-native@example.invalid';
        expect(result).toEqual(orderById(allActors()));
    });

    const invalidInitial: Mutation<Actor[]>[] = [
        {
            name: 'five users',
            mutate: (value) => {
                value.pop();
            },
        },
        {
            name: 'seven users',
            mutate: (value) => {
                value.push({ id: USER_IDS[0], email: NATIVE_EMAILS[0] });
            },
        },
        {
            name: 'missing reserved human',
            mutate: (value) => {
                value[0].id = OTHER_RUN_ID;
            },
        },
        {
            name: 'unreserved actor email',
            mutate: (value) => {
                value[2].email = 'unreserved@example.invalid';
            },
        },
        {
            name: 'native email present initially',
            mutate: (value) => {
                value[2].email = NATIVE_EMAILS[0];
            },
        },
        {
            name: 'human substituted for old fixture',
            mutate: (value) => {
                value[2].id = HUMANS[0];
            },
        },
        {
            name: 'repeated actor ID',
            mutate: (value) => {
                value[3].id = value[2].id;
            },
        },
        {
            name: 'repeated email',
            mutate: (value) => {
                value[3].email = value[2].email;
            },
        },
    ];

    it.each(invalidInitial)('rejects initial $name', ({ mutate }) => {
        const value = originalActors();
        mutate(value);
        expect(() => validateActorInventory(value)).toThrow();
    });

    const invalidPost: Mutation<Actor[]>[] = [
        {
            name: 'only six old users',
            mutate: (value) => {
                value.splice(6);
            },
        },
        {
            name: 'only one new user',
            mutate: (value) => {
                value.pop();
            },
        },
        {
            name: 'nine users',
            mutate: (value) => {
                value.push({ id: OTHER_RUN_ID, email: 'ninth@example.invalid' });
            },
        },
        {
            name: 'old actor ID changed',
            mutate: (value) => {
                value[2].id = OTHER_RUN_ID;
            },
        },
        {
            name: 'old actor email changed',
            mutate: (value) => {
                value[2].email = 'renamed@example.invalid';
            },
        },
        {
            name: 'human email changed',
            mutate: (value) => {
                value[0].email = 'renamed-human@example.invalid';
            },
        },
        {
            name: 'new actor ID changed',
            mutate: (value) => {
                value[6].id = OTHER_RUN_ID;
            },
        },
        {
            name: 'new actor email changed',
            mutate: (value) => {
                value[6].email = 'unreserved-native@example.invalid';
            },
        },
        {
            name: 'arbitrary eighth actor',
            mutate: (value) => {
                value[7] = { id: OTHER_RUN_ID, email: 'arbitrary@example.invalid' };
            },
        },
        {
            name: 'repeated new actor ID',
            mutate: (value) => {
                value[7].id = value[6].id;
            },
        },
        {
            name: 'new actor uses reserved human ID',
            mutate: (value) => {
                value[6].id = HUMANS[0];
            },
        },
    ];

    it.each(invalidPost)('rejects post-creation $name', ({ mutate }) => {
        const value = allActors();
        mutate(value);
        expect(() => validateActorInventory(value, originalActors(), nativeActors())).toThrow();
    });

    it('requires both a valid old snapshot and a disjoint fixed native pair', () => {
        const value = allActors();
        expect(() => validateActorInventory(value, originalActors())).toThrow();
        expect(() => validateActorInventory(value, null, nativeActors())).toThrow();
        const invalidOld = originalActors();
        invalidOld[2].email = 'unknown-old@example.invalid';
        expect(() => validateActorInventory(value, invalidOld, nativeActors())).toThrow();
        const overlappingNew = nativeActors();
        overlappingNew[0].userId = originalActors()[2].id;
        expect(() => validateActorInventory(value, originalActors(), overlappingNew)).toThrow();
        const invalidNew = nativeActors();
        invalidNew[0].email = 'unknown-native@example.invalid';
        expect(() => validateActorInventory(value, originalActors(), invalidNew)).toThrow();
    });

    it.each(INVALID_UUIDS)('rejects noncanonical or nil inventory UUID %s', (id) => {
        const value = originalActors();
        value[2].id = id;
        expect(() => validateActorInventory(value)).toThrow();
    });

    it('does not evaluate actor identity accessors', () => {
        let reads = 0;
        const value = originalActors();
        Object.defineProperty(value[2], 'email', {
            enumerable: true,
            get: () => {
                reads++;
                return OLD_EMAILS[0];
            },
        });
        expect(() => validateActorInventory(value)).toThrow();
        expect(reads).toBe(0);
    });
});
