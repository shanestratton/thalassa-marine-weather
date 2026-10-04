/** Isolated research UI only; this is not the shipping PrivateMessageNativePort. */
import { Capacitor } from '@capacitor/core';
import { RESEARCH_PLUGIN_NAME, researchNativePlugin, type ResearchAuthState } from './auth';

export const MESSAGING_LIMITS = Object.freeze({ cardBytes: 4096, textBytes: 16384, capacity: 16 });
export const MESSAGING_NOTICES = Object.freeze({
    inactive: 'Sign in to use the native research controls.',
    idle: 'Choose an explicit action. Account verification alone does not permit messaging.',
    unavailable: 'Unavailable. No messaging authority or delivery is inferred.',
    uncertain: 'The attempt is unresolved. Do not create a replacement; reconcile or retry the same native message ID.',
    accepted: 'Relay accepted—not delivered or read.',
    rejected: 'Native terminal rejection. This message was not accepted.',
    waiting:
        'A previous native action is still settling. No new message action will start; account logout remains available.',
});

export interface ResearchPolicy {
    readonly ownerRevoked: boolean;
    readonly peerRevoked: boolean;
    readonly blockedByMe: boolean;
    readonly blockedByPeer: boolean;
}
export interface ResearchMessageFacts {
    readonly status: 'state';
    readonly credentialBinding: string;
    readonly pairing: 'unpaired' | 'confirmed' | 'legacyUnverified' | 'changed' | 'revoked' | 'blocked';
    readonly role: 'unpaired' | 'initiator' | 'responder' | 'established';
    readonly fingerprint: string | null;
    readonly registration: 'none' | 'pending' | 'acknowledged';
    readonly claim: 'none' | 'pending' | 'verified' | 'expired' | 'historical';
    readonly policy: ResearchPolicy | null;
}
export interface ResearchThreadMessage {
    readonly clientMessageId: string;
    readonly direction: 'outgoing' | 'incoming';
    readonly text: string | null;
    readonly delivery: 'pending' | 'serverAccepted' | 'rejected' | 'received';
    readonly reason: string | null;
    readonly localCreatedAtMillis: number | null;
}
export interface ResearchThread {
    readonly status: 'thread';
    readonly credentialBinding: string;
    readonly messages: readonly ResearchThreadMessage[];
    readonly unresolvedCount: number;
    readonly outgoingCapacity: number;
    readonly incomingCapacity: number;
}
export interface ResearchCard {
    readonly card: string;
    readonly fingerprint: string;
}
export interface ResearchInboxReport {
    readonly stored: number;
    readonly duplicates: number;
    readonly historical: number;
    readonly unresolved: number;
    readonly historicalUnresolved: number;
}
export type ResearchMessagingResult =
    | ResearchMessageFacts
    | ResearchThread
    | { readonly status: 'unavailable'; readonly reason: 'unavailable' }
    | (ResearchCard & { readonly status: 'pairing_card' | 'peer_card'; readonly credentialBinding: string })
    | { readonly status: 'policy'; readonly credentialBinding: string; readonly policy: ResearchPolicy }
    | { readonly status: 'prepared'; readonly credentialBinding: string; readonly clientMessageId: string }
    | {
          readonly status: 'send_result';
          readonly credentialBinding: string;
          readonly clientMessageId: string;
          readonly decision: 'server_accepted' | 'rejected';
          readonly reason: string | null;
      }
    | (ResearchInboxReport & { readonly status: 'inbox_result'; readonly credentialBinding: string });
type Bound = { credentialBinding: string };
/** unknown is deliberate: every native success is checked at this boundary. */
export interface ResearchMessagingNativePlugin {
    messageState(options: Bound): Promise<unknown>;
    messagePairingCard(options: Bound): Promise<unknown>;
    messageInspectPeerCard(options: Bound & { card: string }): Promise<unknown>;
    messageConfirmPeer(options: Bound & { card: string; confirmedFingerprint: string }): Promise<unknown>;
    messageRegisterDevice(options: Bound): Promise<unknown>;
    messageClaimPeer(options: Bound): Promise<unknown>;
    messageRefreshPolicy(options: Bound): Promise<unknown>;
    messageThread(options: Bound): Promise<unknown>;
    messagePrepareText(options: Bound & { clientMessageId: string; text: string }): Promise<unknown>;
    messageSendPending(options: Bound & { clientMessageId: string }): Promise<unknown>;
    messageSyncInbox(options: Bound): Promise<unknown>;
}
export interface ResearchMessagingAuth {
    getState(): ResearchAuthState;
    subscribe(listener: (state: ResearchAuthState) => void): () => void;
}
export interface ResearchMessagingDependencies {
    readonly auth: ResearchMessagingAuth;
    readonly native: ResearchMessagingNativePlugin;
    readonly supported: () => boolean;
    readonly createMessageId?: () => string;
}
export interface ResearchMessagingState {
    readonly revision: number;
    readonly available: boolean;
    readonly busy: boolean;
    readonly notice: string;
    readonly facts: ResearchMessageFacts | null;
    readonly policy: ResearchPolicy | null;
    readonly ownCard: ResearchCard | null;
    readonly peerCardInput: string;
    readonly inspectedPeer: ResearchCard | null;
    readonly comparedOnOtherDevice: boolean;
    readonly draft: string;
    readonly attempt: { readonly clientMessageId: string; readonly text: string | null } | null;
    readonly thread: ResearchThread | null;
    readonly inboxReport: ResearchInboxReport | null;
}
type Ticket = { readonly revision: number; readonly credentialBinding: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const REASONS = ['blocked', 'device-revoked', 'record-conflict'];
const unavailable = () => new Error('Unavailable');
function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function match(value: unknown, pattern: RegExp): value is string {
    return typeof value === 'string' && value.match(pattern)?.[0] === value;
}
function bytes(value: string): number {
    return new TextEncoder().encode(value).length;
}
function text(value: unknown, limit: number): value is string {
    return typeof value === 'string' && bytes(value) <= limit;
}
function integer(value: unknown, maximum: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): value is T {
    return typeof value === 'string' && choices.includes(value as T);
}
function policy(value: unknown): ResearchPolicy {
    const keys = ['ownerRevoked', 'peerRevoked', 'blockedByMe', 'blockedByPeer'];
    if (!exact(value, keys) || !keys.every((key) => typeof value[key] === 'boolean')) throw unavailable();
    return Object.freeze({
        ownerRevoked: value.ownerRevoked as boolean,
        peerRevoked: value.peerRevoked as boolean,
        blockedByMe: value.blockedByMe as boolean,
        blockedByPeer: value.blockedByPeer as boolean,
    });
}
function clearPolicy(value: ResearchPolicy): boolean {
    return !value.ownerRevoked && !value.peerRevoked && !value.blockedByMe && !value.blockedByPeer;
}
function bound(value: unknown, ticket: Ticket, status: string, fields: readonly string[]): Record<string, unknown> {
    if (
        !exact(value, ['status', 'credentialBinding', ...fields]) ||
        value.status !== status ||
        value.credentialBinding !== ticket.credentialBinding
    )
        throw unavailable();
    return value;
}
function facts(value: unknown, ticket: Ticket): ResearchMessageFacts {
    const result = bound(value, ticket, 'state', ['pairing', 'role', 'fingerprint', 'registration', 'claim', 'policy']);
    if (
        !choice(result.pairing, ['unpaired', 'confirmed', 'legacyUnverified', 'changed', 'revoked', 'blocked']) ||
        !choice(result.role, ['unpaired', 'initiator', 'responder', 'established']) ||
        !(result.fingerprint === null || match(result.fingerprint, FINGERPRINT)) ||
        !choice(result.registration, ['none', 'pending', 'acknowledged']) ||
        !choice(result.claim, ['none', 'pending', 'verified', 'expired', 'historical'])
    )
        throw unavailable();
    return Object.freeze({
        status: 'state',
        credentialBinding: ticket.credentialBinding,
        pairing: result.pairing,
        role: result.role,
        fingerprint: result.fingerprint,
        registration: result.registration,
        claim: result.claim,
        policy: result.policy === null ? null : policy(result.policy),
    });
}
function card(value: unknown, ticket: Ticket, status: 'pairing_card' | 'peer_card'): ResearchCard {
    const result = bound(value, ticket, status, ['card', 'fingerprint']);
    if (
        !text(result.card, MESSAGING_LIMITS.cardBytes) ||
        !result.card.length ||
        !match(result.fingerprint, FINGERPRINT)
    )
        throw unavailable();
    // JS never interprets a card as an identity or chooses keys/routing from it.
    return Object.freeze({ card: result.card, fingerprint: result.fingerprint });
}
function thread(value: unknown, ticket: Ticket): ResearchThread {
    const result = bound(value, ticket, 'thread', [
        'messages',
        'unresolvedCount',
        'outgoingCapacity',
        'incomingCapacity',
    ]);
    if (
        !Array.isArray(result.messages) ||
        result.messages.length > 32 ||
        result.outgoingCapacity !== 16 ||
        result.incomingCapacity !== 16 ||
        !integer(result.unresolvedCount, 16)
    )
        throw unavailable();
    const ids = new Set<string>();
    let outgoing = 0,
        incoming = 0;
    const messages = result.messages.map((row): ResearchThreadMessage => {
        if (
            !exact(row, ['clientMessageId', 'direction', 'text', 'delivery', 'reason', 'localCreatedAtMillis']) ||
            !match(row.clientMessageId, UUID) ||
            !choice(row.direction, ['outgoing', 'incoming']) ||
            !choice(row.delivery, ['pending', 'serverAccepted', 'rejected', 'received']) ||
            !(row.text === null || text(row.text, MESSAGING_LIMITS.textBytes)) ||
            !(row.localCreatedAtMillis === null || integer(row.localCreatedAtMillis, Number.MAX_SAFE_INTEGER)) ||
            !(row.reason === null || choice(row.reason, REASONS))
        )
            throw unavailable();
        if (row.direction === 'incoming') {
            incoming += 1;
            if (row.delivery !== 'received' || row.reason !== null || row.localCreatedAtMillis !== null)
                throw unavailable();
        } else {
            outgoing += 1;
            if (
                row.delivery === 'received' ||
                (row.delivery === 'rejected' ? row.reason === null : row.reason !== null)
            )
                throw unavailable();
        }
        const key = `${row.direction}:${row.clientMessageId}`;
        if (ids.has(key)) throw unavailable();
        ids.add(key);
        return Object.freeze({
            clientMessageId: row.clientMessageId,
            direction: row.direction,
            text: row.text,
            delivery: row.delivery,
            reason: row.reason,
            localCreatedAtMillis: row.localCreatedAtMillis,
        });
    });
    if (outgoing > 16 || incoming > 16) throw unavailable();
    return Object.freeze({
        status: 'thread',
        credentialBinding: ticket.credentialBinding,
        messages: Object.freeze(messages),
        unresolvedCount: result.unresolvedCount,
        outgoingCapacity: 16,
        incomingCapacity: 16,
    });
}

// The plugin's native method registry supplies this interface. Sharing Auth's
// exact proxy prevents duplicate registration; it grants no messaging authority.
const native = researchNativePlugin as unknown as ResearchMessagingNativePlugin;
export function createResearchMessagingController(auth: ResearchMessagingAuth): ResearchMessagingController {
    return new ResearchMessagingController({
        auth,
        native,
        supported: () =>
            Capacitor.isNativePlatform() &&
            Capacitor.getPlatform() === 'ios' &&
            Capacitor.isPluginAvailable(RESEARCH_PLUGIN_NAME),
    });
}

/** One admitted user operation, no background networking and no retry queue. */
export class ResearchMessagingController {
    private revision = 0;
    private visible = true;
    private disposed = false;
    // A scheduling barrier, never an authority ticket or plaintext store. Keep
    // it across hide/auth resets until an admitted native action actually settles.
    private activeAction: symbol | null = null;
    private listeners = new Set<(state: ResearchMessagingState) => void>();
    private unsubscribeAuth: (() => void) | null = null;
    private state!: ResearchMessagingState;

    constructor(private readonly dependencies: ResearchMessagingDependencies) {
        this.reset();
        this.unsubscribeAuth = dependencies.auth.subscribe(() => this.reset());
    }
    getState(): ResearchMessagingState {
        return this.state;
    }
    subscribe(listener: (state: ResearchMessagingState) => void): () => void {
        if (this.disposed) return () => undefined;
        this.listeners.add(listener);
        try {
            listener(this.state);
        } catch {
            /* Observers cannot prevent fencing. */
        }
        return () => this.listeners.delete(listener);
    }
    private available(): boolean {
        try {
            const auth = this.dependencies.auth.getState();
            return (
                !this.disposed &&
                this.visible &&
                this.dependencies.supported() &&
                auth.status === 'authenticated' &&
                auth.account?.serverVerified === true &&
                match(auth.account.credentialBinding, UUID)
            );
        } catch {
            return false;
        }
    }
    private reset(): void {
        this.revision += 1;
        const available = this.available();
        const busy = available && this.activeAction !== null;
        this.state = Object.freeze({
            revision: this.revision,
            available,
            busy,
            notice: busy ? MESSAGING_NOTICES.waiting : available ? MESSAGING_NOTICES.idle : MESSAGING_NOTICES.inactive,
            facts: null,
            policy: null,
            ownCard: null,
            peerCardInput: '',
            inspectedPeer: null,
            comparedOnOtherDevice: false,
            draft: '',
            attempt: null,
            thread: null,
            inboxReport: null,
        });
        this.notify();
    }
    private update(patch: Partial<ResearchMessagingState>): void {
        this.state = Object.freeze({ ...this.state, ...patch });
        this.notify();
    }
    private notify(): void {
        for (const listener of this.listeners) {
            try {
                listener(this.state);
            } catch {
                /* A broken renderer does not authorize native work. */
            }
        }
    }
    setVisible(visible: boolean): void {
        if (this.disposed || this.visible === visible) return;
        this.visible = visible;
        this.reset();
    }
    setDraft(draft: string): void {
        if (this.available() && !this.state.busy && !this.state.attempt && text(draft, MESSAGING_LIMITS.textBytes))
            this.update({ draft });
    }
    setPeerCardInput(peerCardInput: string): void {
        if (
            this.available() &&
            !this.state.busy &&
            !this.state.attempt &&
            text(peerCardInput, MESSAGING_LIMITS.cardBytes)
        )
            this.update({ peerCardInput, inspectedPeer: null, comparedOnOtherDevice: false });
    }
    setComparedOnOtherDevice(compared: boolean): void {
        if (this.available() && !this.state.busy && this.state.inspectedPeer && typeof compared === 'boolean')
            this.update({ comparedOnOtherDevice: compared });
    }
    private current(ticket: Ticket): boolean {
        return (
            ticket.revision === this.revision &&
            this.available() &&
            this.dependencies.auth.getState().account?.credentialBinding === ticket.credentialBinding
        );
    }
    private require(ticket: Ticket): void {
        if (!this.current(ticket)) throw unavailable();
    }
    private commit(ticket: Ticket, patch: Partial<ResearchMessagingState>): void {
        this.require(ticket);
        this.update(patch);
    }
    private async call(ticket: Ticket, operation: () => Promise<unknown>): Promise<unknown> {
        this.require(ticket);
        const result = await operation();
        this.require(ticket);
        return result;
    }
    private async action(operation: (ticket: Ticket) => Promise<void>): Promise<void> {
        if (!this.available() || this.state.busy || this.activeAction !== null) return;
        const credentialBinding = this.dependencies.auth.getState().account!.credentialBinding;
        const ticket = Object.freeze({ revision: this.revision, credentialBinding });
        const admission = Symbol();
        this.activeAction = admission;
        this.update({ busy: true, notice: 'Native research action in progress…' });
        try {
            await operation(ticket);
        } catch {
            if (this.current(ticket))
                this.update({
                    policy: null,
                    facts: null,
                    thread: null,
                    inboxReport: null,
                    notice: this.state.attempt ? MESSAGING_NOTICES.uncertain : MESSAGING_NOTICES.unavailable,
                });
        } finally {
            if (this.activeAction === admission) {
                this.activeAction = null;
                if (!this.disposed)
                    this.update({
                        busy: false,
                        notice:
                            this.state.notice === MESSAGING_NOTICES.waiting
                                ? MESSAGING_NOTICES.idle
                                : this.state.notice,
                    });
            }
        }
    }
    async readState(): Promise<void> {
        await this.action(async (ticket) => {
            const value = facts(
                await this.call(ticket, () => this.dependencies.native.messageState(ticketOptions(ticket))),
                ticket,
            );
            this.commit(ticket, {
                facts: value,
                policy: value.policy,
                notice: 'Native setup facts—not permission to send.',
            });
        });
    }
    async ownPairingCard(): Promise<void> {
        await this.action(async (ticket) => {
            const value = card(
                await this.call(ticket, () => this.dependencies.native.messagePairingCard(ticketOptions(ticket))),
                ticket,
                'pairing_card',
            );
            this.commit(ticket, {
                ownCard: value,
                notice: 'Public pairing card. Compare fingerprints on the other device.',
            });
        });
    }
    async inspectPeerCard(): Promise<void> {
        if (this.state.attempt || !this.state.peerCardInput.trim()) return;
        const input = this.state.peerCardInput;
        await this.action(async (ticket) => {
            this.commit(ticket, { inspectedPeer: null, comparedOnOtherDevice: false });
            const value = card(
                await this.call(ticket, () =>
                    this.dependencies.native.messageInspectPeerCard({ ...ticketOptions(ticket), card: input }),
                ),
                ticket,
                'peer_card',
            );
            this.commit(ticket, {
                inspectedPeer: value,
                notice: 'Inspection is not trust. Compare this fingerprint on the other device before confirming.',
            });
        });
    }
    async confirmPeer(): Promise<void> {
        if (
            !this.available() ||
            this.state.busy ||
            this.state.attempt ||
            !this.state.inspectedPeer ||
            !this.state.comparedOnOtherDevice
        )
            return;
        const inspected = this.state.inspectedPeer;
        // A trust flow starts a new UI generation; no prior plaintext/card/ticket survives it.
        this.reset();
        await this.action(async (ticket) => {
            const value = facts(
                await this.call(ticket, () =>
                    this.dependencies.native.messageConfirmPeer({
                        ...ticketOptions(ticket),
                        card: inspected.card,
                        confirmedFingerprint: inspected.fingerprint,
                    }),
                ),
                ticket,
            );
            this.commit(ticket, {
                facts: value,
                policy: value.policy,
                notice: 'Native peer confirmation recorded. Registration, claim and policy remain separate checks.',
            });
        });
    }
    async registerDevice(): Promise<void> {
        await this.action(async (ticket) => {
            const value = facts(
                await this.call(ticket, () => this.dependencies.native.messageRegisterDevice(ticketOptions(ticket))),
                ticket,
            );
            this.commit(ticket, {
                facts: value,
                policy: value.policy,
                notice: 'Native registration facts updated. This is not a messaging permission.',
            });
        });
    }
    async claimPeer(): Promise<void> {
        await this.action(async (ticket) => {
            const value = facts(
                await this.call(ticket, () => this.dependencies.native.messageClaimPeer(ticketOptions(ticket))),
                ticket,
            );
            this.commit(ticket, {
                facts: value,
                policy: value.policy,
                notice: 'Native claim facts updated. A responder waits for the initiator’s first message.',
            });
        });
    }
    private async refresh(ticket: Ticket): Promise<ResearchPolicy> {
        // Invalidate the displayed previous allow before starting the new query.
        this.commit(ticket, {
            policy: null,
            facts: this.state.facts ? Object.freeze({ ...this.state.facts, policy: null }) : null,
        });
        const value = bound(
            await this.call(ticket, () => this.dependencies.native.messageRefreshPolicy(ticketOptions(ticket))),
            ticket,
            'policy',
            ['policy'],
        );
        const flags = policy(value.policy);
        this.commit(ticket, { policy: flags });
        return flags;
    }
    async refreshPolicy(): Promise<void> {
        await this.action(async (ticket) => {
            const flags = await this.refresh(ticket);
            this.commit(ticket, {
                notice: clearPolicy(flags)
                    ? 'Native policy flags clear at this check—not a durable permission.'
                    : 'Native policy refuses messaging.',
            });
        });
    }
    private reconcile(value: ResearchThread, ticket: Ticket): void {
        this.require(ticket);
        const attempt = this.state.attempt;
        const row = attempt
            ? value.messages.find(
                  (item) => item.direction === 'outgoing' && item.clientMessageId === attempt.clientMessageId,
              )
            : null;
        if (row && row.text !== null && attempt?.text !== null && row.text !== attempt?.text) throw unavailable();
        if (attempt && (!row || row.delivery === 'pending')) return;
        const pending = value.messages.find((item) => item.direction === 'outgoing' && item.delivery === 'pending');
        if (pending)
            this.commit(ticket, {
                attempt: Object.freeze({ clientMessageId: pending.clientMessageId, text: pending.text }),
                draft: '',
                notice: MESSAGING_NOTICES.uncertain,
            });
        else if (row)
            this.commit(ticket, {
                attempt: null,
                notice: row.delivery === 'serverAccepted' ? MESSAGING_NOTICES.accepted : MESSAGING_NOTICES.rejected,
            });
    }
    async readThread(): Promise<void> {
        await this.action(async (original) => {
            await this.readThreadForAction(original);
            this.require(original);
            if (this.state.attempt) this.commit(original, { notice: MESSAGING_NOTICES.uncertain });
            else if (this.state.notice === 'Native research action in progress…')
                this.commit(original, {
                    notice: 'Committed native history loaded. Missing timestamps remain unknown.',
                });
        });
    }
    private async readThreadForAction(ticket: Ticket): Promise<ResearchThread> {
        const value = thread(
            await this.call(ticket, () => this.dependencies.native.messageThread(ticketOptions(ticket))),
            ticket,
        );
        this.reconcile(value, ticket);
        this.require(ticket);
        this.commit(ticket, { thread: value });
        return value;
    }
    async sendText(): Promise<void> {
        if (this.state.attempt || !this.state.draft.trim()) return;
        const draft = this.state.draft;
        await this.action(async (ticket) => {
            await this.readThreadForAction(ticket);
            this.require(ticket);
            if (this.state.attempt) return; // Explicit local reconciliation, never a hidden retry.
            if (!clearPolicy(await this.refresh(ticket))) throw unavailable();
            const clientMessageId = (this.dependencies.createMessageId ?? (() => globalThis.crypto.randomUUID()))();
            if (!match(clientMessageId, UUID)) throw unavailable();
            this.require(ticket);
            // Persisted preparation may succeed even if its echo is lost. Never prepare another ID to replace it.
            this.commit(ticket, { attempt: Object.freeze({ clientMessageId, text: draft }), draft: '' });
            const prepared = bound(
                await this.call(ticket, () =>
                    this.dependencies.native.messagePrepareText({
                        ...ticketOptions(ticket),
                        clientMessageId,
                        text: draft,
                    }),
                ),
                ticket,
                'prepared',
                ['clientMessageId'],
            );
            if (prepared.clientMessageId !== clientMessageId) throw unavailable();
            await this.sendExisting(ticket, clientMessageId);
        });
    }
    private async sendExisting(ticket: Ticket, clientMessageId: string): Promise<void> {
        const value = bound(
            await this.call(ticket, () =>
                this.dependencies.native.messageSendPending({ ...ticketOptions(ticket), clientMessageId }),
            ),
            ticket,
            'send_result',
            ['clientMessageId', 'decision', 'reason'],
        );
        if (
            value.clientMessageId !== clientMessageId ||
            !choice(value.decision, ['server_accepted', 'rejected']) ||
            (value.decision === 'server_accepted' ? value.reason !== null : !choice(value.reason, REASONS))
        )
            throw unavailable();
        this.commit(ticket, {
            attempt: null,
            notice: value.decision === 'server_accepted' ? MESSAGING_NOTICES.accepted : MESSAGING_NOTICES.rejected,
        });
        // A failed history read cannot erase a validated terminal receipt or relabel it as delivery.
        try {
            await this.readThreadForAction(ticket);
        } catch {
            if (this.current(ticket)) this.update({ thread: null });
        }
    }
    async retryPending(): Promise<void> {
        const attempt = this.state.attempt;
        if (!attempt) return;
        await this.action(async (ticket) => {
            const value = await this.readThreadForAction(ticket);
            this.require(ticket);
            if (!this.state.attempt || this.state.attempt.clientMessageId !== attempt.clientMessageId) return;
            // A native terminal row settled this uncertainty; another pending ID is never retried automatically.
            const row = value.messages.find(
                (item) => item.direction === 'outgoing' && item.clientMessageId === attempt.clientMessageId,
            );
            if (
                !row ||
                row.delivery !== 'pending' ||
                (row.text !== null && attempt.text !== null && row.text !== attempt.text)
            )
                throw unavailable();
            if (!clearPolicy(await this.refresh(ticket))) throw unavailable();
            await this.sendExisting(ticket, attempt.clientMessageId);
        });
    }
    async receive(): Promise<void> {
        await this.action(async (ticket) => {
            if (!clearPolicy(await this.refresh(ticket))) throw unavailable();
            const value = bound(
                await this.call(ticket, () => this.dependencies.native.messageSyncInbox(ticketOptions(ticket))),
                ticket,
                'inbox_result',
                ['stored', 'duplicates', 'historical', 'unresolved', 'historicalUnresolved'],
            );
            const keys = ['stored', 'duplicates', 'historical', 'unresolved', 'historicalUnresolved'] as const;
            if (!keys.every((key) => integer(value[key], 32))) throw unavailable();
            const report = Object.freeze(
                Object.fromEntries(keys.map((key) => [key, value[key]])),
            ) as unknown as ResearchInboxReport;
            this.commit(ticket, { inboxReport: report });
            await this.readThreadForAction(ticket);
            this.require(ticket);
            this.commit(ticket, {
                notice: this.state.attempt
                    ? MESSAGING_NOTICES.uncertain
                    : 'Native inbox scan completed. Only committed rows are shown below.',
            });
        });
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.reset();
        try {
            this.unsubscribeAuth?.();
        } catch {
            /* Disposal must still clear plaintext and observers. */
        }
        this.unsubscribeAuth = null;
        this.listeners.clear();
    }
}
function ticketOptions(ticket: Ticket): Bound {
    return { credentialBinding: ticket.credentialBinding };
}

/** Render committed DTO rows only; never interpret message text as markup. */
export function renderResearchMessages(container: HTMLElement, messages: readonly ResearchThreadMessage[]): void {
    const rows = messages.map((message) => {
        const row = document.createElement('li');
        row.className = `message-row ${message.direction}`;
        const heading = document.createElement('span');
        heading.className = 'message-direction';
        heading.textContent = message.direction === 'outgoing' ? 'You' : 'Peer';
        const content = document.createElement('p');
        content.className = 'message-text';
        content.textContent = message.text ?? 'Plaintext unavailable in this native record.';
        const meta = document.createElement('p');
        meta.className = 'message-meta';
        const delivery =
            message.delivery === 'serverAccepted'
                ? 'Relay accepted · not delivered or read'
                : message.delivery === 'pending'
                  ? 'Native pending · no acceptance confirmed'
                  : message.delivery === 'rejected'
                    ? `Rejected · ${message.reason}`
                    : 'Received into native local history · read status unknown';
        const date = message.localCreatedAtMillis === null ? null : new Date(message.localCreatedAtMillis);
        const timestamp =
            date === null
                ? 'Time unknown'
                : Number.isNaN(date.getTime())
                  ? `Device-local timestamp ${message.localCreatedAtMillis}`
                  : `Device-local time ${date.toLocaleString()}`;
        meta.textContent = `${delivery} · ${timestamp}`;
        const id = document.createElement('p');
        id.className = 'message-id';
        id.textContent = message.clientMessageId;
        row.append(heading, content, meta, id);
        return row;
    });
    container.replaceChildren(...rows);
}
