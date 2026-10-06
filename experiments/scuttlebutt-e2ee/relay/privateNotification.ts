/**
 * Content-free isolated notification projection. This validates shape only;
 * authority and exact accepted-decision binding belong to the isolated SQL.
 * No APNs, production push, account lookup or message decryption is installed.
 */
export const PRIVATE_NOTIFICATION_TITLE = 'Thalassa';
export const PRIVATE_NOTIFICATION_BODY = 'Open Thalassa to view your private messages.';

export interface ResearchPrivateNotification {
    readonly version: 1;
    readonly type: 'private-message';
    readonly title: typeof PRIVATE_NOTIFICATION_TITLE;
    readonly body: typeof PRIVATE_NOTIFICATION_BODY;
    readonly route: Readonly<{ messageId: string }>;
}

export class ResearchPrivateNotificationError extends Error {
    constructor() {
        super('Research private notification unavailable');
        this.name = 'ResearchPrivateNotificationError';
    }
}

// PostgreSQL gen_random_uuid() emits canonical lowercase RFC 4122 version 4.
// A syntactically valid UUID grants neither message access nor send authority.
const ROUTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (): never => {
    throw new ResearchPrivateNotificationError();
};

function dataFields(value: unknown, names: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key)))
        return fail();
    const copy: Record<string, unknown> = {};
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail();
        copy[name] = descriptor.value;
    }
    return copy;
}

/** Inspect descriptors before reading fields; never invoke caller getters. */
export function parsePrivateNotificationProjection(value: unknown): Readonly<ResearchPrivateNotification> {
    try {
        const fields = dataFields(value, ['version', 'type', 'title', 'body', 'route']);
        const route = dataFields(fields.route, ['messageId']);
        if (
            fields.version !== 1 ||
            fields.type !== 'private-message' ||
            fields.title !== PRIVATE_NOTIFICATION_TITLE ||
            fields.body !== PRIVATE_NOTIFICATION_BODY ||
            typeof route.messageId !== 'string' ||
            ROUTE_ID.exec(route.messageId)?.[0] !== route.messageId
        )
            return fail();
        return Object.freeze({
            version: 1,
            type: 'private-message',
            title: PRIVATE_NOTIFICATION_TITLE,
            body: PRIVATE_NOTIFICATION_BODY,
            route: Object.freeze({ messageId: route.messageId }),
        });
    } catch {
        // Discard caller/adapter diagnostic data, including trap exception text.
        return fail();
    }
}

/** Serialize only the freshly copied, fixed-field projection. */
export function encodePrivateNotificationProjection(value: unknown): string {
    return JSON.stringify(parsePrivateNotificationProjection(value));
}
