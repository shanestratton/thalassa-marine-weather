import { describe, expect, it } from 'vitest';
import {
    encodePrivateNotificationProjection,
    parsePrivateNotificationProjection,
    PRIVATE_NOTIFICATION_BODY,
    PRIVATE_NOTIFICATION_TITLE,
    ResearchPrivateNotificationError,
} from '../experiments/scuttlebutt-e2ee/relay/privateNotification';

const MESSAGE_ID = '162d313b-4ea9-4cfe-89ee-fda266a20108';
const CANARY = 'forbidden-private-content-canary';
const projection = () => ({
    version: 1,
    type: 'private-message',
    title: PRIVATE_NOTIFICATION_TITLE,
    body: PRIVATE_NOTIFICATION_BODY,
    route: { messageId: MESSAGE_ID },
});

describe('isolated content-free notification projection (not push delivery)', () => {
    it('copies and freezes exactly the fixed generic content and opaque route', () => {
        const input = projection();
        const result = parsePrivateNotificationProjection(input);
        expect(result).toEqual(projection());
        expect(result).not.toBe(input);
        expect(result.route).not.toBe(input.route);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.route)).toBe(true);
        input.route.messageId = 'fe391d6e-831b-4609-9c3a-e534fdb6871b';
        expect(result.route.messageId).toBe(MESSAGE_ID);
        expect(encodePrivateNotificationProjection(result)).toBe(JSON.stringify(projection()));
    });

    it.each([
        { version: 0 },
        { version: '1' },
        { type: 'dm' },
        { type: 'hail' },
        { title: `Thalassa ${CANARY}` },
        { body: CANARY },
        { route: null },
        { route: { messageId: 'sender:private-text' } },
        { route: { messageId: '1' } },
        { route: { messageId: '00000000-0000-0000-0000-000000000000' } },
        { route: { messageId: MESSAGE_ID.toUpperCase() } },
        { route: { messageId: MESSAGE_ID.replace('-4cfe-', '-1cfe-') } },
        { route: { messageId: MESSAGE_ID.replace('-89ee-', '-79ee-') } },
        { route: { messageId: `${MESSAGE_ID}\n` } },
        { route: { messageId: 1 } },
    ])('refuses changed fixed fields and invalid opaque IDs: %j', (patch) => {
        expect(() => parsePrivateNotificationProjection({ ...projection(), ...patch })).toThrow(
            ResearchPrivateNotificationError,
        );
    });

    it.each([
        'sender_id',
        'recipient_id',
        'sender_name',
        'senderDeviceId',
        'recipientDeviceId',
        'clientMessageId',
        'recipientIdentityKeyId',
        'message',
        'plaintext',
        'preview',
        'coordinates',
        'latitude',
        'longitude',
        'recipe',
        'privateKey',
        'signingKey',
        'pickle',
        'sessionState',
        'ciphertext',
        'serializedEnvelope',
        'accepted',
        'delivered',
        'read',
        'badge',
        'data',
        'aps',
        'toJSON',
    ])('rejects forbidden field %s at both object levels without echoing content', (field) => {
        for (const input of [
            { ...projection(), [field]: CANARY },
            { ...projection(), route: { messageId: MESSAGE_ID, [field]: CANARY } },
        ]) {
            for (const operation of [parsePrivateNotificationProjection, encodePrivateNotificationProjection]) {
                expect(() => operation(input)).toThrow(ResearchPrivateNotificationError);
                try {
                    operation(input);
                } catch (error) {
                    expect(String(error)).not.toContain(CANARY);
                }
            }
        }
    });

    it('rejects missing, inherited, symbolic and non-enumerable fields', () => {
        for (const field of Object.keys(projection())) {
            const missing: Record<string, unknown> = projection();
            delete missing[field];
            expect(() => parsePrivateNotificationProjection(missing)).toThrow(ResearchPrivateNotificationError);
            const nonEnumerable = projection();
            Object.defineProperty(nonEnumerable, field, { enumerable: false });
            expect(() => parsePrivateNotificationProjection(nonEnumerable)).toThrow(ResearchPrivateNotificationError);
        }
        const symbolExtra = { ...projection(), [Symbol('private')]: CANARY };
        const inherited = Object.assign(Object.create({ preview: CANARY }), projection());
        const nullPrototype = Object.assign(Object.create(null), projection());
        const routeSymbol = { ...projection(), route: { messageId: MESSAGE_ID, [Symbol('private')]: CANARY } };
        const routeInherited = { ...projection(), route: Object.create({ messageId: MESSAGE_ID }) };
        const routeNonEnumerable = { ...projection(), route: {} };
        Object.defineProperty(routeNonEnumerable.route, 'messageId', { value: MESSAGE_ID });
        for (const input of [symbolExtra, inherited, nullPrototype, routeSymbol, routeInherited, routeNonEnumerable]) {
            expect(() => parsePrivateNotificationProjection(input)).toThrow(ResearchPrivateNotificationError);
        }
    });

    it('does not invoke required-field getters or toJSON callbacks', () => {
        let reads = 0;
        for (const field of Object.keys(projection())) {
            const input = projection();
            Object.defineProperty(input, field, {
                enumerable: true,
                get() {
                    reads += 1;
                    return CANARY;
                },
            });
            expect(() => encodePrivateNotificationProjection(input)).toThrow(ResearchPrivateNotificationError);
        }
        const nested = projection();
        Object.defineProperty(nested.route, 'messageId', {
            enumerable: true,
            get() {
                reads += 1;
                return MESSAGE_ID;
            },
        });
        expect(() => encodePrivateNotificationProjection(nested)).toThrow(ResearchPrivateNotificationError);
        const withSerializer = {
            ...projection(),
            toJSON() {
                reads += 1;
                return projection();
            },
        };
        expect(() => encodePrivateNotificationProjection(withSerializer)).toThrow(ResearchPrivateNotificationError);
        expect(reads).toBe(0);
    });

    it('replaces hostile reflection errors with fixed diagnostics', () => {
        const hostile = new Proxy(projection(), {
            ownKeys() {
                throw new Error(CANARY);
            },
        });
        try {
            parsePrivateNotificationProjection(hostile);
            throw new Error('fixture should have refused');
        } catch (error) {
            expect(error).toBeInstanceOf(ResearchPrivateNotificationError);
            expect(String(error)).not.toContain(CANARY);
            expect((error as Error).message).toBe('Research private notification unavailable');
        }
    });

    it.each([null, undefined, false, 1, '', [], JSON.stringify(projection())])(
        'requires a plain data object',
        (input) => {
            expect(() => parsePrivateNotificationProjection(input)).toThrow(ResearchPrivateNotificationError);
        },
    );
});
