/**
 * Explicit isolated composition only. No plugin registration, SDK, timer,
 * production toggle, legacy ChatService, token storage or network implementation.
 * Native owns every Auth/trust/store/relay capability; JS validates projections.
 */
import type { PrivateMessageNativePlugin } from '../../../services/chat/e2ee/nativePrivateMessagePilot';
import type {
    NativePrivateMessageAuthority,
    NativePrivateMessageBlockStatus,
    NativePrivateMessageEvent,
    NativePrivateMessageInboxEntry,
    NativePrivateMessageReadiness,
    NativePrivateMessageResult,
    NativePrivateMessageThread,
    NativePrivateTextMessage,
} from '../../../services/chat/e2ee/privateMessagePilot';
import { isPrivateMessagePilotText } from '../../../services/chat/e2ee/privateMessageTextPolicy';

export interface ResearchPrivateMessagePluginBindings {
    currentAccount?(): Promise<unknown>;
    fenceSession(options: { mode: 'verify' | 'sign_out' }): Promise<unknown>;
    authenticate(options: { accessToken: string; authFence: string }): Promise<unknown>;
    privateMessageIssue(options: { credentialBinding: string }): Promise<unknown>;
    privateMessageReadiness(options: { lifecycleVersion: string }): Promise<unknown>;
    privateMessagePermissions(options: { lifecycleVersion: string; peerAccountId: string }): Promise<unknown>;
    privateMessageInbox(options: { lifecycleVersion: string }): Promise<unknown>;
    privateMessageThread(options: { lifecycleVersion: string; peerAccountId: string }): Promise<unknown>;
    privateMessageSendText(options: {
        lifecycleVersion: string;
        peerAccountId: string;
        clientMessageId: string;
        text: string;
    }): Promise<unknown>;
    privateMessageRetryPending(options: {
        lifecycleVersion: string;
        peerAccountId: string;
        clientMessageId: string;
    }): Promise<unknown>;
}

export interface ResearchPrivateMessageNativePlugin extends PrivateMessageNativePlugin {
    /** Use the existing Research Auth host; do not create a second SDK/fence loop. */
    connectCurrentAccount(expectedCredentialBinding?: string): Promise<NativePrivateMessageReadiness>;
    /** View-only privacy fence. This does not perform native logout. */
    invalidateView(): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (value: unknown): value is string => typeof value === 'string' && UUID.exec(value)?.[0] === value;
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const closed = () => ({ status: 'unavailable' as const, reason: 'unavailable' as const });
const millis = (value: unknown): value is number | null =>
    value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const text = (value: unknown): value is string | null => value === null || isPrivateMessagePilotText(value);

function authority(value: unknown): NativePrivateMessageAuthority | null {
    if (
        !object(value) ||
        !exact(value, ['accountId', 'deviceId', 'lifecycleVersion', 'serverVerified']) ||
        !id(value.accountId) ||
        !id(value.deviceId) ||
        !id(value.lifecycleVersion) ||
        value.serverVerified !== true
    )
        return null;
    return {
        accountId: value.accountId,
        deviceId: value.deviceId,
        lifecycleVersion: value.lifecycleVersion,
        serverVerified: true,
    };
}
function same(a: NativePrivateMessageAuthority, b: NativePrivateMessageAuthority | null) {
    return !!b && a.accountId === b.accountId && a.deviceId === b.deviceId && a.lifecycleVersion === b.lifecycleVersion;
}
function ready(value: unknown): Extract<NativePrivateMessageReadiness, { status: 'ready' }> | null {
    if (
        !object(value) ||
        !exact(value, ['status', 'authority', 'supportedContent']) ||
        value.status !== 'ready' ||
        !Array.isArray(value.supportedContent) ||
        value.supportedContent.length !== 1 ||
        value.supportedContent[0] !== 'text'
    )
        return null;
    const found = authority(value.authority);
    return found ? { status: 'ready', authority: found, supportedContent: ['text'] } : null;
}
function permissions(value: unknown, peer: string): NativePrivateMessageBlockStatus | null {
    if (
        !object(value) ||
        !exact(value, ['peerAccountId', 'blockedByMe', 'blockedEitherDirection', 'canSend', 'reason']) ||
        value.peerAccountId !== peer ||
        !id(peer) ||
        typeof value.blockedByMe !== 'boolean' ||
        typeof value.blockedEitherDirection !== 'boolean' ||
        typeof value.canSend !== 'boolean' ||
        (value.blockedByMe && !value.blockedEitherDirection) ||
        (value.canSend ? value.blockedEitherDirection || value.reason !== null : value.reason !== 'unavailable')
    )
        return null;
    return {
        peerAccountId: peer,
        blockedByMe: value.blockedByMe,
        blockedEitherDirection: value.blockedEitherDirection,
        canSend: value.canSend,
        reason: value.canSend ? null : 'unavailable',
    };
}
function message(value: unknown, owner: string, peer?: string): NativePrivateTextMessage | null {
    if (
        !object(value) ||
        !exact(value, [
            'id',
            'clientMessageId',
            'direction',
            'senderAccountId',
            'recipientAccountId',
            'senderName',
            'text',
            'localCreatedAtMillis',
            'read',
            'delivery',
            'reason',
        ]) ||
        !id(value.clientMessageId) ||
        !id(value.senderAccountId) ||
        !id(value.recipientAccountId) ||
        value.senderAccountId === value.recipientAccountId ||
        !text(value.text) ||
        !millis(value.localCreatedAtMillis) ||
        value.read !== false ||
        (value.direction !== 'outgoing' && value.direction !== 'incoming') ||
        value.id !== `${value.direction}:${value.clientMessageId}`
    )
        return null;
    const outgoing = value.direction === 'outgoing';
    if (
        (outgoing ? value.senderAccountId : value.recipientAccountId) !== owner ||
        (peer && (outgoing ? value.recipientAccountId : value.senderAccountId) !== peer) ||
        value.senderName !== (outgoing ? 'You' : 'Paired sailor') ||
        (!outgoing &&
            (value.delivery !== 'received' || value.reason !== null || value.localCreatedAtMillis !== null)) ||
        (outgoing && !['pending', 'server_accepted', 'rejected'].includes(String(value.delivery)))
    )
        return null;
    const reason = value.reason;
    if (
        value.delivery === 'rejected'
            ? !['blocked', 'device-revoked', 'record-conflict'].includes(String(reason))
            : reason !== null
    )
        return null;
    const delivery = value.delivery;
    if (delivery !== 'pending' && delivery !== 'server_accepted' && delivery !== 'rejected' && delivery !== 'received')
        return null;
    if (reason !== null && reason !== 'blocked' && reason !== 'device-revoked' && reason !== 'record-conflict')
        return null;
    return {
        id: `${value.direction}:${value.clientMessageId}`,
        clientMessageId: value.clientMessageId,
        direction: value.direction,
        senderAccountId: value.senderAccountId,
        recipientAccountId: value.recipientAccountId,
        senderName: outgoing ? 'You' : 'Paired sailor',
        text: value.text,
        localCreatedAtMillis: value.localCreatedAtMillis,
        read: false,
        delivery,
        reason,
    };
}
function thread(value: unknown, owner: string, peer: string): NativePrivateMessageThread | null {
    if (
        !object(value) ||
        !exact(value, ['peerAccountId', 'messages', 'permissions', 'unresolvedCount', 'pendingAttemptId']) ||
        value.peerAccountId !== peer ||
        !Array.isArray(value.messages) ||
        value.messages.length > 32 ||
        !Number.isSafeInteger(value.unresolvedCount) ||
        typeof value.unresolvedCount !== 'number' ||
        value.unresolvedCount < 0 ||
        value.unresolvedCount > 16
    )
        return null;
    const flags = permissions(value.permissions, peer);
    const rows = value.messages.map((row) => message(row, owner, peer));
    if (!flags || rows.some((row) => !row)) return null;
    const parsed: NativePrivateTextMessage[] = [];
    for (const row of rows) {
        if (!row) return null;
        parsed.push(row);
    }
    if (
        new Set(parsed.map((row) => row.id)).size !== parsed.length ||
        parsed.filter((row) => row.direction === 'incoming').length > 16 ||
        parsed.filter((row) => row.direction === 'outgoing').length > 16
    )
        return null;
    const pending = parsed.filter((row) => row.direction === 'outgoing' && row.delivery === 'pending');
    if (pending.length > 1 || value.pendingAttemptId !== (pending[0]?.clientMessageId ?? null)) return null;
    return {
        peerAccountId: peer,
        messages: parsed,
        permissions: flags,
        unresolvedCount: value.unresolvedCount,
        pendingAttemptId: pending[0]?.clientMessageId ?? null,
    };
}
function inbox(value: unknown, owner: string): NativePrivateMessageInboxEntry[] | null {
    if (!Array.isArray(value) || value.length > 1) return null;
    const rows: NativePrivateMessageInboxEntry[] = [];
    for (const row of value) {
        if (
            !object(row) ||
            !exact(row, [
                'peerAccountId',
                'displayName',
                'lastText',
                'lastLocalCreatedAtMillis',
                'unreadCount',
                'historyAvailable',
            ]) ||
            !id(row.peerAccountId) ||
            row.peerAccountId === owner ||
            row.displayName !== 'Paired sailor' ||
            !text(row.lastText) ||
            !millis(row.lastLocalCreatedAtMillis) ||
            row.unreadCount !== 0 ||
            typeof row.historyAvailable !== 'boolean' ||
            (!row.historyAvailable && (row.lastText !== null || row.lastLocalCreatedAtMillis !== null))
        )
            return null;
        rows.push({
            peerAccountId: row.peerAccountId,
            displayName: 'Paired sailor',
            lastText: row.lastText,
            lastLocalCreatedAtMillis: row.lastLocalCreatedAtMillis,
            unreadCount: 0,
            historyAvailable: row.historyAvailable,
        });
    }
    return rows;
}

/** Refresh-only incoming delivery; local committed send/retry events are fenced. */
export function createResearchPrivateMessageNativePlugin(
    native: ResearchPrivateMessagePluginBindings,
): ResearchPrivateMessageNativePlugin {
    let revision = 0;
    let pendingFence: string | null = null;
    let selected: NativePrivateMessageAuthority | null = null;
    // Reservations survive reset until their native readiness work finishes.
    // Otherwise repeated logout/reopen could accumulate unlimited setup work.
    let pendingSubscriptions = 0;
    const readinessListeners = new Set<() => void>();
    const subscriptions = new Set<{
        authority: NativePrivateMessageAuthority;
        revision: number;
        listener: (event: NativePrivateMessageEvent) => void;
    }>();
    const notify = () => {
        for (const listener of [...readinessListeners]) {
            try {
                listener();
            } catch {
                /* fixed boundary */
            }
        }
    };
    const reset = () => {
        const ticket = ++revision;
        pendingFence = null;
        selected = null;
        subscriptions.clear();
        notify();
        return ticket;
    };
    const current = (ticket: number, expected: NativePrivateMessageAuthority) =>
        ticket === revision && same(expected, selected);
    async function check(expected: NativePrivateMessageAuthority, ticket: number) {
        if (!authority(expected) || !current(ticket, expected)) return false;
        const result = ready(await native.privateMessageReadiness({ lifecycleVersion: expected.lifecycleVersion }));
        return current(ticket, expected) && !!result && same(expected, result.authority);
    }
    async function invoke<T>(
        expected: NativePrivateMessageAuthority,
        run: () => Promise<unknown>,
        parse: (value: unknown) => T | null,
    ): Promise<NativePrivateMessageResult<T>> {
        const ticket = revision;
        const canonical = authority(expected);
        if (!canonical || !same(canonical, selected)) return closed();
        expected = canonical;
        try {
            if (!(await check(expected, ticket)) || !current(ticket, expected)) return closed();
            const result = await run();
            if (
                !current(ticket, expected) ||
                !object(result) ||
                !exact(result, ['status', 'authority', 'value']) ||
                result.status !== 'ok' ||
                !same(expected, authority(result.authority))
            )
                return closed();
            const parsed = parse(result.value);
            if (parsed === null || !(await check(expected, ticket)) || !current(ticket, expected)) return closed();
            return { status: 'ok', authority: { ...expected }, value: parsed };
        } catch {
            return closed();
        }
    }
    const publish = (result: NativePrivateMessageResult<NativePrivateTextMessage>) => {
        if (result.status !== 'ok') return;
        for (const item of [...subscriptions])
            if (
                subscriptions.has(item) &&
                current(item.revision, item.authority) &&
                same(item.authority, result.authority)
            ) {
                try {
                    // A consumer owns only its projection. It cannot rewrite
                    // another listener's native row or the caller's result.
                    item.listener({ status: 'ok', authority: { ...result.authority }, value: { ...result.value } });
                } catch {
                    /* subscriber cannot expose diagnostics */
                }
            }
    };
    const refuseSubscription = (listener: (event: NativePrivateMessageEvent) => void) => {
        try {
            listener(closed());
        } catch {
            /* Consumer errors cannot escape the refusal boundary. */
        }
    };
    return {
        invalidateView() {
            reset();
        },
        async connectCurrentAccount(expectedCredentialBinding?: string) {
            const ticket = reset();
            if (
                ticket !== revision ||
                !native.currentAccount ||
                (expectedCredentialBinding !== undefined && !id(expectedCredentialBinding))
            )
                return closed();
            try {
                // This read is native-owned, not an SDK account label supplied
                // by the view. Native issue still requires the full sealed pair.
                const result = await native.currentAccount();
                if (
                    ticket !== revision ||
                    !object(result) ||
                    !exact(result, ['status', 'account']) ||
                    result.status !== 'authenticated' ||
                    !object(result.account) ||
                    !exact(result.account, ['accountId', 'deviceId', 'credentialBinding', 'serverVerified']) ||
                    !id(result.account.accountId) ||
                    !id(result.account.deviceId) ||
                    !id(result.account.credentialBinding) ||
                    result.account.serverVerified !== true ||
                    (expectedCredentialBinding !== undefined &&
                        result.account.credentialBinding !== expectedCredentialBinding)
                )
                    return closed();
                const descriptor = {
                    accountId: result.account.accountId,
                    deviceId: result.account.deviceId,
                    credentialBinding: result.account.credentialBinding,
                };
                const issued = ready(
                    await native.privateMessageIssue({ credentialBinding: descriptor.credentialBinding }),
                );
                if (
                    ticket !== revision ||
                    !issued ||
                    issued.authority.accountId !== descriptor.accountId ||
                    issued.authority.deviceId !== descriptor.deviceId
                )
                    return closed();
                const verified = ready(
                    await native.privateMessageReadiness({ lifecycleVersion: issued.authority.lifecycleVersion }),
                );
                if (ticket !== revision || !verified || !same(issued.authority, verified.authority)) return closed();
                selected = { ...issued.authority };
                notify();
                return current(ticket, issued.authority) ? issued : closed();
            } catch {
                return closed();
            }
        },
        async fenceSession(options) {
            const mode = options.mode;
            const ticket = reset();
            // reset notifies consumers synchronously; a reentrant newer fence
            // must prevent this older request from reaching native at all.
            if (ticket !== revision) return closed();
            try {
                const result = await native.fenceSession({ mode });
                if (
                    ticket !== revision ||
                    !object(result) ||
                    !exact(result, ['status', 'authFence']) ||
                    result.status !== 'fenced' ||
                    !id(result.authFence)
                )
                    return closed();
                pendingFence = mode === 'verify' ? result.authFence : null;
                return { status: 'fenced', authFence: result.authFence };
            } catch {
                return closed();
            }
        },
        async authenticate(options) {
            const ticket = revision;
            const { accessToken, authFence } = options;
            if (!pendingFence || authFence !== pendingFence) return closed();
            pendingFence = null;
            try {
                const result = await native.authenticate({
                    accessToken,
                    authFence,
                });
                if (
                    ticket !== revision ||
                    !object(result) ||
                    !exact(result, ['status', 'account']) ||
                    result.status !== 'authenticated' ||
                    !object(result.account) ||
                    !exact(result.account, ['accountId', 'deviceId', 'credentialBinding', 'serverVerified']) ||
                    !id(result.account.accountId) ||
                    !id(result.account.deviceId) ||
                    !id(result.account.credentialBinding) ||
                    result.account.serverVerified !== true
                )
                    return closed();
                const descriptor = {
                    accountId: result.account.accountId,
                    deviceId: result.account.deviceId,
                    credentialBinding: result.account.credentialBinding,
                };
                const issued = ready(
                    await native.privateMessageIssue({ credentialBinding: descriptor.credentialBinding }),
                );
                if (
                    ticket !== revision ||
                    !issued ||
                    issued.authority.accountId !== descriptor.accountId ||
                    issued.authority.deviceId !== descriptor.deviceId
                )
                    return closed();
                const verified = ready(
                    await native.privateMessageReadiness({ lifecycleVersion: issued.authority.lifecycleVersion }),
                );
                if (ticket !== revision || !verified || !same(issued.authority, verified.authority)) return closed();
                selected = { ...issued.authority };
                notify();
                return current(ticket, issued.authority) ? issued : closed();
            } catch {
                return closed();
            }
        },
        async readiness() {
            const captured = selected,
                ticket = revision;
            if (!captured) return closed();
            try {
                return (await check(captured, ticket)) && current(ticket, captured)
                    ? { status: 'ready', authority: { ...captured }, supportedContent: ['text'] }
                    : closed();
            } catch {
                return closed();
            }
        },
        subscribeReadiness(listener) {
            readinessListeners.add(listener);
            return () => {
                readinessListeners.delete(listener);
            };
        },
        getInbox(request) {
            const expected = authority(request.authority);
            if (!expected) return Promise.resolve(closed());
            return invoke(
                expected,
                () => native.privateMessageInbox({ lifecycleVersion: expected.lifecycleVersion }),
                (value) => inbox(value, expected.accountId),
            );
        },
        async getThread(request) {
            const expected = authority(request.authority);
            const peerAccountId = request.peerAccountId;
            const ticket = revision;
            if (!expected || !current(ticket, expected) || !id(peerAccountId) || peerAccountId === expected.accountId)
                return closed();
            // A refused/failed policy refresh cannot retain its old allow, but
            // authenticated local history remains readable under the SAME
            // descriptor. The native thread projects current canSend:false.
            const refreshed = await invoke(
                expected,
                () =>
                    native.privateMessagePermissions({
                        lifecycleVersion: expected.lifecycleVersion,
                        peerAccountId,
                    }),
                (value) => permissions(value, peerAccountId),
            );
            if (!current(ticket, expected)) return closed();
            const local = await invoke(
                expected,
                () =>
                    native.privateMessageThread({
                        lifecycleVersion: expected.lifecycleVersion,
                        peerAccountId,
                    }),
                (value) => thread(value, expected.accountId, peerAccountId),
            );
            if (!current(ticket, expected)) return closed();
            // Restrict the UI hint after ANY refused refresh; never promote an
            // earlier native allow. Local history is still native-authenticated.
            return local.status === 'ok' && refreshed.status !== 'ok'
                ? {
                      ...local,
                      value: {
                          ...local.value,
                          permissions: { ...local.value.permissions, canSend: false, reason: 'unavailable' },
                      },
                  }
                : local;
        },
        async sendText(request) {
            const expected = authority(request.authority);
            const { peerAccountId, clientMessageId, text: draft } = request;
            const ticket = revision;
            if (
                !expected ||
                !current(ticket, expected) ||
                !id(peerAccountId) ||
                !id(clientMessageId) ||
                !isPrivateMessagePilotText(draft)
            )
                return closed();
            const result = await invoke(
                expected,
                () =>
                    native.privateMessageSendText({
                        lifecycleVersion: expected.lifecycleVersion,
                        peerAccountId,
                        clientMessageId,
                        text: draft,
                    }),
                (value) => {
                    const row = message(value, expected.accountId, peerAccountId);
                    return row?.direction === 'outgoing' &&
                        row.clientMessageId === clientMessageId &&
                        row.text === draft &&
                        row.delivery !== 'pending'
                        ? row
                        : null;
                },
            );
            if (!current(ticket, expected)) return closed();
            publish(result);
            return current(ticket, expected) ? result : closed();
        },
        async retryPending(request) {
            const expected = authority(request.authority);
            const { peerAccountId, clientMessageId } = request;
            const ticket = revision;
            if (!expected || !current(ticket, expected) || !id(peerAccountId) || !id(clientMessageId)) return closed();
            const result = await invoke(
                expected,
                () =>
                    native.privateMessageRetryPending({
                        lifecycleVersion: expected.lifecycleVersion,
                        peerAccountId,
                        clientMessageId,
                    }),
                (value) => {
                    const row = message(value, expected.accountId, peerAccountId);
                    return row?.direction === 'outgoing' &&
                        row.clientMessageId === clientMessageId &&
                        row.delivery !== 'pending'
                        ? row
                        : null;
                },
            );
            if (!current(ticket, expected)) return closed();
            publish(result);
            return current(ticket, expected) ? result : closed();
        },
        getBlockStatus(request) {
            const expected = authority(request.authority);
            const peerAccountId = request.peerAccountId;
            if (!expected || !id(peerAccountId) || peerAccountId === expected.accountId)
                return Promise.resolve(closed());
            return invoke(
                expected,
                () =>
                    native.privateMessagePermissions({
                        lifecycleVersion: expected.lifecycleVersion,
                        peerAccountId,
                    }),
                (value) => permissions(value, peerAccountId),
            );
        },
        async setBlocked() {
            return closed();
        },
        async subscribe(request, listener) {
            const expected = authority(request.authority);
            const ticket = revision;
            if (!expected || !current(ticket, expected) || subscriptions.size + pendingSubscriptions >= 32) {
                refuseSubscription(listener);
                return () => undefined;
            }
            pendingSubscriptions += 1;
            let reserved = true;
            try {
                if (
                    !(await check(expected, ticket)) ||
                    !current(ticket, expected) ||
                    subscriptions.size + pendingSubscriptions > 32
                ) {
                    refuseSubscription(listener);
                    return () => undefined;
                }
                // Transfer the reservation to an active entry in one synchronous
                // segment. No callback or await can insert stale work here.
                pendingSubscriptions -= 1;
                reserved = false;
                if (subscriptions.size + pendingSubscriptions >= 32) {
                    refuseSubscription(listener);
                    return () => undefined;
                }
                const item = { authority: expected, revision: ticket, listener };
                subscriptions.add(item);
                return () => {
                    subscriptions.delete(item);
                };
            } catch {
                refuseSubscription(listener);
                return () => undefined;
            } finally {
                if (reserved) pendingSubscriptions -= 1;
            }
        },
    };
}
