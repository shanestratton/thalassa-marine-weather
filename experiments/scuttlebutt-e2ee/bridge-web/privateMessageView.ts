/**
 * Explicit experimental view only. No SDK, registration, Auth store, storage,
 * timers, transport, or production mounting. Inject the current native boundary.
 * Mocked ports test rendering/fences; they are not evidence of encryption.
 */
import { isPrivateMessagePilotText } from '../../../services/chat/e2ee/privateMessageTextPolicy';
import { MAX_CHAT_MESSAGE_CHARS } from '../../../services/chat/messagePolicy';
import type {
    NativePrivateMessageAuthority,
    NativePrivateMessageBlockStatus,
    NativePrivateMessageInboxEntry,
    NativePrivateMessageThread,
    NativePrivateTextMessage,
} from '../../../services/chat/e2ee/privateMessagePilot';

export interface PrivateMessageViewPort {
    getInbox(request: { authority: NativePrivateMessageAuthority }): Promise<unknown>;
    getThread(request: { authority: NativePrivateMessageAuthority; peerAccountId: string }): Promise<unknown>;
    sendText(request: {
        authority: NativePrivateMessageAuthority;
        peerAccountId: string;
        clientMessageId: string;
        text: string;
    }): Promise<unknown>;
    retryPending(request: {
        authority: NativePrivateMessageAuthority;
        peerAccountId: string;
        clientMessageId: string;
    }): Promise<unknown>;
    subscribe?(
        request: { authority: NativePrivateMessageAuthority },
        listener: (event: unknown) => void,
    ): Promise<() => void>;
    subscribeReadiness?(listener: () => void): () => void;
}

export interface PrivateMessageViewState {
    phase: 'closed' | 'checking' | 'ready' | 'unavailable';
    view: 'inbox' | 'thread';
    authority: NativePrivateMessageAuthority | null;
    inbox: NativePrivateMessageInboxEntry[];
    thread: NativePrivateMessageThread | null;
    draft: string;
    pendingAttemptId: string | null;
    busy: boolean;
    statusText: string | null;
}

export interface PrivateMessageViewController {
    /** True means a guarded projection was published, never recipient delivery. */
    start(): Promise<boolean>;
    open(): Promise<boolean>;
    refresh(): Promise<boolean>;
    setDraft(text: string): Promise<boolean>;
    send(): Promise<boolean>;
    retry(): Promise<boolean>;
    close(): void;
    hidden(): void;
    scopeChanged(): void;
    getSnapshot(): PrivateMessageViewState;
    /** Registration only; no implicit native work or initial plaintext replay. */
    subscribe(listener: (state: PrivateMessageViewState) => void): () => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (value: unknown): value is string => typeof value === 'string' && UUID.exec(value)?.[0] === value;
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
    Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const millis = (value: unknown): value is number | null =>
    value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const nativeText = (value: unknown): value is string | null => value === null || isPrivateMessagePilotText(value);
const rowId = (
    value: unknown,
    direction: 'incoming' | 'outgoing',
    clientId: string,
): value is NativePrivateTextMessage['id'] => typeof value === 'string' && value === `${direction}:${clientId}`;

function parseAuthority(value: unknown): NativePrivateMessageAuthority | null {
    if (
        !object(value) ||
        !exact(value, ['accountId', 'deviceId', 'lifecycleVersion', 'serverVerified']) ||
        !id(value.accountId) ||
        !id(value.deviceId) ||
        value.serverVerified !== true ||
        typeof value.lifecycleVersion !== 'string' ||
        /^[A-Za-z0-9._:-]{1,128}$/.exec(value.lifecycleVersion)?.[0] !== value.lifecycleVersion
    )
        return null;
    return {
        accountId: value.accountId,
        deviceId: value.deviceId,
        lifecycleVersion: value.lifecycleVersion,
        serverVerified: true,
    };
}
const sameAuthority = (a: NativePrivateMessageAuthority, b: NativePrivateMessageAuthority | null): boolean =>
    !!b && a.accountId === b.accountId && a.deviceId === b.deviceId && a.lifecycleVersion === b.lifecycleVersion;
function parseReadiness(value: unknown): NativePrivateMessageAuthority | null {
    return object(value) &&
        exact(value, ['status', 'authority', 'supportedContent']) &&
        value.status === 'ready' &&
        Array.isArray(value.supportedContent) &&
        value.supportedContent.length === 1 &&
        value.supportedContent[0] === 'text'
        ? parseAuthority(value.authority)
        : null;
}
function parsePermissions(value: unknown, peer: string): NativePrivateMessageBlockStatus | null {
    if (
        !object(value) ||
        !exact(value, ['peerAccountId', 'blockedByMe', 'blockedEitherDirection', 'canSend', 'reason']) ||
        value.peerAccountId !== peer ||
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
function parseMessage(value: unknown, owner: string, peer: string): NativePrivateTextMessage | null {
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
        (value.direction !== 'incoming' && value.direction !== 'outgoing') ||
        !rowId(value.id, value.direction, value.clientMessageId) ||
        !nativeText(value.text) ||
        !millis(value.localCreatedAtMillis) ||
        value.read !== false ||
        owner === peer
    )
        return null;
    const outgoing = value.direction === 'outgoing';
    if (
        value.senderAccountId !== (outgoing ? owner : peer) ||
        value.recipientAccountId !== (outgoing ? peer : owner) ||
        value.senderName !== (outgoing ? 'You' : 'Paired sailor') ||
        (outgoing
            ? value.delivery !== 'pending' && value.delivery !== 'server_accepted' && value.delivery !== 'rejected'
            : value.delivery !== 'received' || value.localCreatedAtMillis !== null) ||
        (value.delivery === 'rejected'
            ? value.reason !== 'blocked' && value.reason !== 'device-revoked' && value.reason !== 'record-conflict'
            : value.reason !== null)
    )
        return null;
    const delivery = value.delivery,
        reason = value.reason;
    if (delivery !== 'pending' && delivery !== 'server_accepted' && delivery !== 'rejected' && delivery !== 'received')
        return null;
    if (reason !== null && reason !== 'blocked' && reason !== 'device-revoked' && reason !== 'record-conflict')
        return null;
    return {
        id: value.id,
        clientMessageId: value.clientMessageId,
        direction: value.direction,
        senderAccountId: outgoing ? owner : peer,
        recipientAccountId: outgoing ? peer : owner,
        senderName: outgoing ? 'You' : 'Paired sailor',
        text: value.text,
        localCreatedAtMillis: value.localCreatedAtMillis,
        read: false,
        delivery,
        reason,
    };
}
function parseInbox(value: unknown, owner: string): NativePrivateMessageInboxEntry[] | null {
    if (!Array.isArray(value) || value.length > 1) return null;
    const result: NativePrivateMessageInboxEntry[] = [];
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
            !nativeText(row.lastText) ||
            !millis(row.lastLocalCreatedAtMillis) ||
            row.unreadCount !== 0 ||
            typeof row.historyAvailable !== 'boolean' ||
            (!row.historyAvailable && (row.lastText !== null || row.lastLocalCreatedAtMillis !== null))
        )
            return null;
        result.push({
            peerAccountId: row.peerAccountId,
            displayName: 'Paired sailor',
            lastText: row.lastText,
            lastLocalCreatedAtMillis: row.lastLocalCreatedAtMillis,
            unreadCount: 0,
            historyAvailable: row.historyAvailable,
        });
    }
    return result;
}
function parseThread(value: unknown, owner: string, peer: string): NativePrivateMessageThread | null {
    if (
        !object(value) ||
        !exact(value, ['peerAccountId', 'messages', 'permissions', 'unresolvedCount', 'pendingAttemptId']) ||
        value.peerAccountId !== peer ||
        !Array.isArray(value.messages) ||
        value.messages.length > 32 ||
        typeof value.unresolvedCount !== 'number' ||
        !Number.isSafeInteger(value.unresolvedCount) ||
        value.unresolvedCount < 0 ||
        value.unresolvedCount > 16
    )
        return null;
    const permissions = parsePermissions(value.permissions, peer);
    if (!permissions) return null;
    const messages: NativePrivateTextMessage[] = [];
    for (const row of value.messages) {
        const parsed = parseMessage(row, owner, peer);
        if (!parsed || messages.some((message) => message.id === parsed.id)) return null;
        messages.push(parsed);
    }
    const outgoing = messages.filter((message) => message.direction === 'outgoing');
    const pending = outgoing.filter((message) => message.delivery === 'pending');
    if (
        outgoing.length > 16 ||
        messages.length - outgoing.length > 16 ||
        pending.length > 1 ||
        value.pendingAttemptId !== (pending[0]?.clientMessageId ?? null)
    )
        return null;
    return {
        peerAccountId: peer,
        messages,
        permissions,
        unresolvedCount: value.unresolvedCount,
        pendingAttemptId: pending[0]?.clientMessageId ?? null,
    };
}
function parseResult<T>(
    value: unknown,
    expected: NativePrivateMessageAuthority,
    parse: (value: unknown) => T | null,
): T | null {
    try {
        return object(value) &&
            exact(value, ['status', 'authority', 'value']) &&
            value.status === 'ok' &&
            sameAuthority(expected, parseAuthority(value.authority))
            ? parse(value.value)
            : null;
    } catch {
        return null;
    }
}
function isNativeRefusal(value: unknown): boolean {
    try {
        return (
            object(value) &&
            exact(value, ['status', 'reason']) &&
            value.status === 'unavailable' &&
            typeof value.reason === 'string' &&
            [
                'unavailable',
                'signed_out',
                'stale_authority',
                'peer_changed',
                'peer_unverified',
                'peer_revoked',
                'blocked',
                'self_chat_unsupported',
                'unsupported_content',
                'storage_failure',
                'transport_failure',
                'capacity_exceeded',
            ].includes(value.reason)
        );
    } catch {
        return false;
    }
}
const blank = (phase: PrivateMessageViewState['phase']): PrivateMessageViewState => ({
    phase,
    view: 'inbox',
    authority: null,
    inbox: [],
    thread: null,
    draft: '',
    pendingAttemptId: null,
    busy: phase === 'checking',
    statusText: phase === 'unavailable' ? 'The native private message test is unavailable.' : null,
});
const copyState = (state: PrivateMessageViewState): PrivateMessageViewState => ({
    ...state,
    authority: state.authority ? { ...state.authority } : null,
    inbox: state.inbox.map((row) => ({ ...row })),
    thread: state.thread
        ? {
              ...state.thread,
              permissions: { ...state.thread.permissions },
              messages: state.thread.messages.map((row) => ({ ...row })),
          }
        : null,
});

export function createPrivateMessageViewController(options: {
    port: PrivateMessageViewPort;
    /** Must call the actual native readiness boundary, never an SDK Boolean. */
    nativeReadiness: () => Promise<unknown>;
    createClientMessageId: () => string;
}): PrivateMessageViewController {
    const { port, nativeReadiness, createClientMessageId } = options;
    let revision = 0,
        actionBusy = false,
        eventRefreshNeeded = false;
    let state = blank('closed');
    let pin: NativePrivateMessageAuthority | null = null;
    let peer: string | null = null;
    let attempt: { clientMessageId: string; originalText: string | null; typed: boolean } | null = null;
    let stopNative: (() => void) | undefined, stopReadiness: (() => void) | undefined;
    let draftWork: Promise<boolean> | null = null;
    let wantedDraft: { revision: number; text: string } | null = null;
    const listeners = new Set<(state: PrivateMessageViewState) => void>();
    const facts = new Map<
        string,
        {
            text: string | null;
            millis: number | null;
            terminal: NativePrivateTextMessage['delivery'] | null;
            reason: NativePrivateTextMessage['reason'];
        }
    >();
    const current = (ticket: number, expected: NativePrivateMessageAuthority) =>
        ticket === revision && sameAuthority(expected, pin);
    const notify = (ticket: number) => {
        for (const listener of [...listeners]) {
            if (ticket !== revision) break;
            if (!listeners.has(listener)) continue;
            try {
                listener(copyState(state));
            } catch {
                /* No consumer diagnostics cross the native boundary. */
            }
        }
    };
    const fence = (phase: PrivateMessageViewState['phase']) => {
        const ticket = ++revision;
        pin = null;
        peer = null;
        attempt = null;
        wantedDraft = null;
        eventRefreshNeeded = false;
        facts.clear();
        state = blank(phase);
        const stops = [stopNative, stopReadiness];
        stopNative = undefined;
        stopReadiness = undefined;
        for (const stop of stops) {
            try {
                stop?.();
            } catch {
                /* Stay fenced. */
            }
        }
        if (ticket === revision) notify(ticket);
        return ticket;
    };
    const readReady = async (ticket: number, expected?: NativePrivateMessageAuthority) => {
        if (ticket !== revision || (expected && !current(ticket, expected))) return null;
        try {
            const found = parseReadiness(await nativeReadiness());
            if (ticket !== revision) return null;
            if (!found || (expected && !sameAuthority(expected, found))) {
                fence('unavailable');
                return null;
            }
            return found;
        } catch {
            if (ticket === revision) fence('unavailable');
            return null;
        }
    };
    const verify = async (ticket: number, expected: NativePrivateMessageAuthority) =>
        !!(await readReady(ticket, expected)) && current(ticket, expected);
    const publish = async (
        ticket: number,
        expected: NativePrivateMessageAuthority,
        make: () => PrivateMessageViewState,
    ) => {
        if (!(await verify(ticket, expected)) || !current(ticket, expected)) return false;
        state = make();
        state.authority = { ...expected };
        notify(ticket);
        return current(ticket, expected);
    };
    const pendingId = () =>
        attempt && !facts.get(`outgoing:${attempt.clientMessageId}`)?.terminal ? attempt.clientMessageId : null;
    const failed = (ticket: number, expected: NativePrivateMessageAuthority) =>
        publish(ticket, expected, () => ({
            ...state,
            phase: 'unavailable',
            inbox: [],
            thread: null,
            busy: false,
            pendingAttemptId: pendingId(),
            statusText: 'The native private message test is unavailable.',
        })).then(() => false);
    const acceptRows = (rows: NativePrivateTextMessage[]) => {
        const size = new Set([...facts.keys(), ...rows.map((row) => row.id)]).size;
        if (size > 32) return false;
        for (const row of rows) {
            const known = facts.get(row.id);
            if (
                known &&
                ((known.text !== null && row.text !== null && known.text !== row.text) ||
                    (known.millis !== null &&
                        row.localCreatedAtMillis !== null &&
                        known.millis !== row.localCreatedAtMillis) ||
                    (known.terminal !== null && known.terminal !== row.delivery) ||
                    (known.reason !== null && row.reason !== null && known.reason !== row.reason))
            )
                return false;
        }
        for (const row of rows) {
            const known = facts.get(row.id);
            facts.set(row.id, {
                text: row.text ?? known?.text ?? null,
                millis: row.localCreatedAtMillis ?? known?.millis ?? null,
                terminal: row.delivery === 'pending' ? (known?.terminal ?? null) : row.delivery,
                reason: row.reason ?? known?.reason ?? null,
            });
        }
        return true;
    };
    const reconcileAttempt = (thread: NativePrivateMessageThread) => {
        if (thread.pendingAttemptId !== null) {
            if (attempt?.clientMessageId !== thread.pendingAttemptId)
                attempt = { clientMessageId: thread.pendingAttemptId, originalText: null, typed: false };
        } else if (
            attempt &&
            thread.messages.some(
                (row) =>
                    row.direction === 'outgoing' &&
                    row.clientMessageId === attempt?.clientMessageId &&
                    (row.delivery === 'server_accepted' || row.delivery === 'rejected'),
            )
        )
            attempt = null;
    };
    const fetchThread = async (
        ticket: number,
        expected: NativePrivateMessageAuthority,
    ): Promise<NativePrivateMessageThread | null> => {
        const pairedPeer = peer;
        if (!pairedPeer || !(await verify(ticket, expected)) || !current(ticket, expected)) return null;
        let raw: unknown;
        try {
            raw = await port.getThread({ authority: { ...expected }, peerAccountId: pairedPeer });
        } catch {
            return null;
        }
        if (!current(ticket, expected)) return null;
        const thread = parseResult(raw, expected, (value) => parseThread(value, expected.accountId, pairedPeer));
        if (!thread || !acceptRows(thread.messages) || !(await verify(ticket, expected)) || !current(ticket, expected))
            return null;
        return thread;
    };
    const publishThread = (
        ticket: number,
        expected: NativePrivateMessageAuthority,
        thread: NativePrivateMessageThread,
        scannedInbox?: NativePrivateMessageInboxEntry[],
        scanUnavailable = false,
    ) => {
        const saved = attempt;
        const settled = saved?.typed
            ? thread.messages.find(
                  (row) =>
                      row.direction === 'outgoing' &&
                      row.clientMessageId === saved.clientMessageId &&
                      row.delivery === 'server_accepted' &&
                      row.text !== null &&
                      row.text === saved.originalText,
              )
            : undefined;
        reconcileAttempt(thread);
        return publish(ticket, expected, () => ({
            ...state,
            phase: 'ready',
            view: 'thread',
            inbox: scannedInbox ?? state.inbox,
            thread,
            draft:
                settled?.text !== null && settled?.text !== undefined && state.draft.trim() === settled.text
                    ? ''
                    : state.draft,
            pendingAttemptId: pendingId(),
            busy: false,
            statusText: scanUnavailable ? 'Local history shown. New replies could not be checked.' : null,
        }));
    };
    const action = async (work: () => Promise<boolean>) => {
        if (actionBusy) return false;
        actionBusy = true;
        try {
            return await work();
        } finally {
            actionBusy = false;
            if (eventRefreshNeeded && pin) {
                eventRefreshNeeded = false;
                void refresh(false);
            }
        }
    };
    const bind = async (ticket: number, expected: NativePrivateMessageAuthority) => {
        if (port.subscribeReadiness) {
            try {
                const stop = port.subscribeReadiness(() => {
                    if (current(ticket, expected)) fence('unavailable');
                });
                if (typeof stop !== 'function') {
                    if (current(ticket, expected)) fence('unavailable');
                } else if (!current(ticket, expected)) {
                    try {
                        stop();
                    } catch {
                        /* Already fenced. */
                    }
                } else stopReadiness = stop;
            } catch {
                if (current(ticket, expected)) fence('unavailable');
            }
        }
        if (!port.subscribe || !current(ticket, expected)) return;
        try {
            const stop = await port.subscribe({ authority: { ...expected } }, (event) => {
                if (!current(ticket, expected)) return;
                const pairedPeer = peer;
                const row = pairedPeer
                    ? parseResult(event, expected, (value) => parseMessage(value, expected.accountId, pairedPeer))
                    : null;
                if (!row || !acceptRows([row])) {
                    fence('unavailable');
                    return;
                }
                // One active action coalesces native events. Read the native
                // thread instead of promoting an event into guessed history.
                if (!actionBusy) void refresh(false);
                else eventRefreshNeeded = true;
            });
            if (typeof stop !== 'function') {
                if (current(ticket, expected)) fence('unavailable');
            } else if (!current(ticket, expected) || !(await verify(ticket, expected)) || !current(ticket, expected))
                stop();
            else stopNative = stop;
        } catch {
            if (current(ticket, expected)) fence('unavailable');
        }
    };
    const controller: PrivateMessageViewController = {
        start: () =>
            action(async () => {
                const ticket = fence('checking');
                const expected = await readReady(ticket);
                if (!expected || ticket !== revision) return false;
                pin = { ...expected };
                let raw: unknown;
                try {
                    raw = await port.getInbox({ authority: { ...expected } });
                } catch {
                    return failed(ticket, expected);
                }
                if (!current(ticket, expected)) return false;
                const inbox = parseResult(raw, expected, (value) => parseInbox(value, expected.accountId));
                if (!inbox) return failed(ticket, expected);
                peer = inbox[0]?.peerAccountId ?? null;
                if (!(await publish(ticket, expected, () => ({ ...blank('ready'), inbox })))) return false;
                await bind(ticket, expected);
                return current(ticket, expected);
            }),
        open: () =>
            action(async () => {
                const ticket = revision,
                    expected = pin;
                if (!expected || !peer) return false;
                const thread = await fetchThread(ticket, expected);
                if (!current(ticket, expected)) return false;
                return thread ? publishThread(ticket, expected, thread) : failed(ticket, expected);
            }),
        refresh: () => refresh(true),
        setDraft(text) {
            const ticket = revision,
                expected = pin;
            if (!expected || typeof text !== 'string' || text.length > MAX_CHAT_MESSAGE_CHARS || text.includes('\0'))
                return Promise.resolve(false);
            wantedDraft = { revision: ticket, text };
            if (draftWork) return draftWork;
            draftWork = publish(ticket, expected, () => ({
                ...state,
                draft: wantedDraft?.revision === ticket ? wantedDraft.text : state.draft,
            })).finally(() => {
                draftWork = null;
            });
            return draftWork;
        },
        send: () =>
            action(async () => {
                const ticket = revision,
                    expected = pin;
                if (!expected || !peer || state.view !== 'thread' || state.phase !== 'ready') return false;
                if (draftWork) await draftWork;
                if (!current(ticket, expected)) return false;
                const text = state.draft.trim();
                if (!isPrivateMessagePilotText(text)) return false;
                const thread = await fetchThread(ticket, expected);
                if (!current(ticket, expected)) return false;
                if (!thread) return failed(ticket, expected);
                reconcileAttempt(thread);
                if (!thread.permissions.canSend || attempt) {
                    await publishThread(ticket, expected, thread);
                    return false;
                }
                let clientMessageId: string;
                try {
                    clientMessageId = createClientMessageId();
                } catch {
                    return failed(ticket, expected);
                }
                if (!current(ticket, expected)) return false;
                if (!id(clientMessageId)) return failed(ticket, expected);
                attempt = { clientMessageId, originalText: text, typed: true };
                return submit(ticket, expected, clientMessageId, text, false);
            }),
        retry: () =>
            action(async () => {
                const ticket = revision,
                    expected = pin;
                if (!expected || !peer) return false;
                const thread = await fetchThread(ticket, expected);
                if (!current(ticket, expected)) return false;
                if (!thread) return failed(ticket, expected);
                reconcileAttempt(thread);
                if (!thread.permissions.canSend || !attempt) {
                    await publishThread(ticket, expected, thread);
                    return false;
                }
                const saved = attempt;
                const committed = thread.messages.some(
                    (row) => row.direction === 'outgoing' && row.clientMessageId === saved.clientMessageId,
                );
                const prepare =
                    thread.pendingAttemptId === null &&
                    !committed &&
                    saved.typed &&
                    isPrivateMessagePilotText(saved.originalText);
                return submit(ticket, expected, saved.clientMessageId, prepare ? saved.originalText : null, !prepare);
            }),
        close: () => {
            fence('closed');
        },
        hidden: () => {
            fence('closed');
        },
        scopeChanged: () => {
            fence('unavailable');
        },
        getSnapshot: () => copyState(state),
        subscribe(listener) {
            if (listeners.size >= 32) return () => undefined;
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
    function refresh(scanInbox: boolean): Promise<boolean> {
        if (!pin) return scanInbox ? controller.start() : Promise.resolve(false);
        return action(async () => {
            const ticket = revision,
                expected = pin;
            if (!expected) return false;
            if (state.view === 'thread' || attempt) {
                let scannedInbox: NativePrivateMessageInboxEntry[] | undefined;
                let scanUnavailable = false;
                if (scanInbox) {
                    // Explicit refresh receives ONE bounded native batch. Local
                    // event/send reconciliation never triggers another scan.
                    if (!(await verify(ticket, expected)) || !current(ticket, expected)) return false;
                    let raw: unknown,
                        scanFailed = false;
                    try {
                        raw = await port.getInbox({ authority: { ...expected } });
                    } catch {
                        scanFailed = true;
                    }
                    if (!current(ticket, expected)) return false;
                    const inbox = scanFailed
                        ? null
                        : parseResult(raw, expected, (value) => parseInbox(value, expected.accountId));
                    if (inbox) {
                        if (inbox[0]?.peerAccountId !== peer) return failed(ticket, expected);
                        scannedInbox = inbox;
                    } else if (!scanFailed && !isNativeRefusal(raw)) return failed(ticket, expected);
                    else scanUnavailable = true;
                    // The bound factory collapses native errors and malformed
                    // native output into the same refusal. Do not infer a cause;
                    // only an explicit bad authoritative projection at this view
                    // seam can be distinguished from an unavailable result.
                    // A refused scan is not loss of authenticated local history.
                    // fetchThread checks the original descriptor again before
                    // reading or publishing that history; no receive retry.
                }
                const thread = await fetchThread(ticket, expected);
                if (!current(ticket, expected)) return false;
                return thread
                    ? publishThread(ticket, expected, thread, scannedInbox, scanUnavailable)
                    : failed(ticket, expected);
            }
            if (!scanInbox) return true;
            if (!(await verify(ticket, expected)) || !current(ticket, expected)) return false;
            let raw: unknown;
            try {
                raw = await port.getInbox({ authority: { ...expected } });
            } catch {
                return failed(ticket, expected);
            }
            if (!current(ticket, expected)) return false;
            const inbox = parseResult(raw, expected, (value) => parseInbox(value, expected.accountId));
            if (!inbox || (peer && inbox[0]?.peerAccountId !== peer)) return failed(ticket, expected);
            peer = inbox[0]?.peerAccountId ?? null;
            return publish(ticket, expected, () => ({
                ...state,
                phase: 'ready',
                inbox,
                busy: false,
                statusText: null,
            }));
        });
    }
    async function submit(
        ticket: number,
        expected: NativePrivateMessageAuthority,
        clientMessageId: string,
        text: string | null,
        retry: boolean,
    ) {
        const pairedPeer = peer;
        if (!pairedPeer || (!retry && !isPrivateMessagePilotText(text))) return failed(ticket, expected);
        if (
            !(await publish(ticket, expected, () => ({ ...state, busy: true, pendingAttemptId: clientMessageId }))) ||
            !current(ticket, expected)
        )
            return false;
        let raw: unknown;
        try {
            if (retry)
                raw = await port.retryPending({
                    authority: { ...expected },
                    peerAccountId: pairedPeer,
                    clientMessageId,
                });
            else {
                if (!isPrivateMessagePilotText(text)) return failed(ticket, expected);
                raw = await port.sendText({
                    authority: { ...expected },
                    peerAccountId: pairedPeer,
                    clientMessageId,
                    text,
                });
            }
        } catch {
            return failed(ticket, expected);
        }
        if (!current(ticket, expected)) return false;
        const row = parseResult(raw, expected, (value) => parseMessage(value, expected.accountId, pairedPeer));
        if (
            !row ||
            row.direction !== 'outgoing' ||
            row.clientMessageId !== clientMessageId ||
            (!retry && row.text !== text) ||
            !acceptRows([row])
        )
            return failed(ticket, expected);
        const thread = await fetchThread(ticket, expected);
        if (!current(ticket, expected)) return false;
        const committed = thread?.messages.find(
            (message) => message.direction === 'outgoing' && message.clientMessageId === clientMessageId,
        );
        if (!thread || !committed) return failed(ticket, expected);
        reconcileAttempt(thread);
        return publish(ticket, expected, () => ({
            ...state,
            phase: 'ready',
            view: 'thread',
            thread,
            draft:
                committed.text !== null && committed.delivery !== 'rejected' && state.draft.trim() === committed.text
                    ? ''
                    : state.draft,
            pendingAttemptId: pendingId(),
            busy: false,
            statusText: null,
        }));
    }
    return controller;
}

function displayTime(value: number | null): string {
    if (value === null) return 'Time unknown';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : 'Time unknown';
}
function deliveryText(row: NativePrivateTextMessage): string {
    switch (row.delivery) {
        case 'pending':
            return '· Pending native relay';
        case 'server_accepted':
            return '· Relay accepted';
        case 'received':
            return '· Received · Read status unknown';
        case 'rejected':
            return row.reason === null ? '· Rejected' : `· Rejected · ${row.reason.replace(/-/g, ' ')}`;
    }
}

/** Mount is explicit and starts fenced. The caller starts after native connect. */
export function mountPrivateMessageView(
    container: HTMLElement,
    controller: PrivateMessageViewController,
): { destroy(): void } {
    const doc = container.ownerDocument;
    controller.close();
    const element = (tag: string, text?: string) => {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (name: string, run: () => void) => {
        const node = doc.createElement('button');
        node.type = 'button';
        node.textContent = name;
        node.onclick = run;
        return node;
    };
    // Keep the compose field attached across publications. Replacing a focused
    // input on every keystroke closes the keyboard and resets its caret on iOS.
    const notice = element('p', 'Encryption test—not reviewed');
    notice.setAttribute('role', 'status');
    const status = element('p');
    status.setAttribute('role', 'status');
    const inbox = element('div');
    const log = element('div');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-label', 'Direct messages');
    const unresolved = element('p');
    const compose = element('div');
    const input = doc.createElement('input');
    input.type = 'text';
    input.maxLength = MAX_CHAT_MESSAGE_CHARS;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Message Paired sailor');
    input.oninput = () => {
        void controller.setDraft(input.value);
    };
    const send = button('Send direct message', () => {
        void controller.setDraft(input.value).then((ready) => (ready ? controller.send() : false));
    });
    input.onkeydown = (event) => {
        if (event.key === 'Enter' && !event.isComposing && !send.disabled) {
            event.preventDefault();
            send.click();
        }
    };
    compose.append(input, send);
    const retry = button('Retry pending message', () => {
        void controller.retry();
    });
    container.replaceChildren(
        notice,
        element('p', 'Isolated text-only private message test.'),
        status,
        button('Close private message test', () => controller.close()),
        button('Refresh private messages', () => {
            void controller.refresh();
        }),
        inbox,
        log,
        unresolved,
        compose,
        retry,
    );
    const render = (snapshot: PrivateMessageViewState) => {
        status.textContent = snapshot.statusText;
        status.hidden = snapshot.statusText === null;
        inbox.replaceChildren();
        log.replaceChildren();
        unresolved.textContent = '';
        const canCompose = snapshot.authority !== null && snapshot.view === 'thread';
        compose.hidden = !canCompose;
        log.hidden = !canCompose;
        retry.hidden = !snapshot.pendingAttemptId || snapshot.authority === null;
        retry.disabled = snapshot.busy;
        if (snapshot.phase !== 'ready') input.blur();
        // Clear the field itself on a privacy fence, including any detached
        // reference a previous UI action still holds to this owned DOM node.
        if (input.value !== snapshot.draft) input.value = snapshot.draft;
        input.disabled = !canCompose;
        send.disabled =
            snapshot.phase !== 'ready' ||
            snapshot.busy ||
            !!snapshot.pendingAttemptId ||
            !snapshot.thread?.permissions.canSend ||
            !snapshot.draft.trim();
        if (snapshot.view === 'inbox') {
            for (const row of snapshot.inbox) {
                const open = button('Message Paired sailor', () => {
                    void controller.open();
                });
                open.setAttribute('aria-label', 'Message Paired sailor');
                open.append(
                    element(
                        'p',
                        row.lastText ??
                            (row.historyAvailable ? 'Message text unavailable' : 'Native history unavailable'),
                    ),
                );
                open.append(element('span', displayTime(row.lastLocalCreatedAtMillis)));
                inbox.append(open);
            }
            return;
        }
        for (const row of snapshot.thread?.messages ?? []) {
            const item = element('div');
            item.dataset.messageId = row.id;
            const paragraph = element('p', row.text ?? 'Message text unavailable');
            paragraph.className = 'select-text';
            item.append(
                paragraph,
                element('span', displayTime(row.localCreatedAtMillis)),
                element('span', deliveryText(row)),
            );
            log.append(item);
        }
        if (snapshot.thread?.unresolvedCount)
            unresolved.textContent = `${snapshot.thread.unresolvedCount} native message records are unavailable.`;
    };
    render(controller.getSnapshot());
    const stop = controller.subscribe(render);
    const hidden = () => {
        if (doc.visibilityState === 'hidden') controller.hidden();
    };
    doc.addEventListener('visibilitychange', hidden);
    const pageHidden = () => controller.hidden();
    doc.defaultView?.addEventListener('pagehide', pageHidden);
    return {
        destroy() {
            controller.close();
            stop();
            doc.removeEventListener('visibilitychange', hidden);
            doc.defaultView?.removeEventListener('pagehide', pageHidden);
            input.value = '';
            container.replaceChildren();
        },
    };
}
