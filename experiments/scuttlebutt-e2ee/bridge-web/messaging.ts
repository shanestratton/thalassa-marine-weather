/** Isolated research UI only; this is not the shipping PrivateMessageNativePort. */
import { Capacitor } from '@capacitor/core';
import { RESEARCH_PLUGIN_NAME, researchNativePlugin, type ResearchAccount, type ResearchAuthState } from './auth';

export const MESSAGING_LIMITS = Object.freeze({ cardBytes: 4096, textBytes: 16384, capacity: 16 });
export const MESSAGING_NOTICES = Object.freeze({
    inactive: 'Sign in to use the native research controls.',
    idle: 'Choose an explicit action. Account verification alone does not permit messaging.',
    unavailable: 'Unavailable. No messaging authority or delivery is inferred.',
    uncertain: 'The attempt is unresolved. Do not create a replacement; reconcile or retry the same native message ID.',
    accepted: 'Relay accepted—not delivered or read.',
    rejected: 'Native terminal rejection. This message was not accepted.',
    prepared: 'Committed locally; no message upload attempted. Reopen, read local history, then retry this pending ID.',
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
/** UI setup hint only, never a native or server authorization to encrypt/send. */
export function researchSendSetupReady(value: ResearchMessageFacts | null): boolean {
    return (
        !!value &&
        value.pairing === 'confirmed' &&
        match(value.fingerprint, FINGERPRINT) &&
        value.registration === 'acknowledged' &&
        (value.role === 'established' || (value.role === 'initiator' && value.claim === 'verified'))
    );
}
export interface ResearchThreadMessage {
    readonly clientMessageId: string;
    readonly direction: 'outgoing' | 'incoming';
    readonly text: string | null;
    readonly delivery: 'pending' | 'serverAccepted' | 'rejected' | 'received';
    readonly reason: string | null;
    readonly localCreatedAtMillis: number | null;
    /** Equality diagnostic for exact saved envelope bytes, never a trust or authority token. */
    readonly envelopeSha256: string;
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
    // Presentation continuity only. Public cards never stand in for authority.
    getPublicPairingOwner?(): Pick<ResearchAccount, 'accountId' | 'deviceId'> | null;
    reverifyForPairing?(): Promise<ResearchAccount | null>;
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
    readonly pairingAvailable: boolean;
    readonly publicCardsAvailable: boolean;
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
const ENVELOPE_SHA256 = /^[0-9a-f]{64}$/;
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
            !exact(row, [
                'clientMessageId',
                'direction',
                'text',
                'delivery',
                'reason',
                'localCreatedAtMillis',
                'envelopeSha256',
            ]) ||
            !match(row.clientMessageId, UUID) ||
            !match(row.envelopeSha256, ENVELOPE_SHA256) ||
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
            envelopeSha256: row.envelopeSha256,
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
    private visibilityRevision = 0;
    private ownerRevision = 0;
    private publicOwnerKey: string | null = null;
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
    private ownerKey(): string | null {
        try {
            const auth = this.dependencies.auth.getState();
            if (
                this.disposed ||
                !this.dependencies.supported() ||
                auth.status === 'signed_out' ||
                auth.status === 'unsupported'
            )
                return null;
            const owner = this.dependencies.auth.getPublicPairingOwner
                ? this.dependencies.auth.getPublicPairingOwner()
                : auth.account;
            if (!owner || !match(owner.accountId, UUID) || !match(owner.deviceId, UUID)) return null;
            return `${owner.accountId}:${owner.deviceId}`;
        } catch {
            return null;
        }
    }
    private publicCardsAvailable(): boolean {
        try {
            return (
                !this.disposed &&
                this.visible &&
                this.dependencies.supported() &&
                this.ownerKey() !== null &&
                this.dependencies.auth.getState().status !== 'verifying'
            );
        } catch {
            return false;
        }
    }
    private pairingAvailable(): boolean {
        return (
            this.available() ||
            (this.publicCardsAvailable() &&
                this.dependencies.auth.getState().status === 'unavailable' &&
                typeof this.dependencies.auth.reverifyForPairing === 'function')
        );
    }
    private reset(retainPublic = true): void {
        this.revision += 1;
        const ownerKey = this.ownerKey();
        if (ownerKey !== this.publicOwnerKey) this.ownerRevision += 1;
        const keepCards = retainPublic && ownerKey !== null && ownerKey === this.publicOwnerKey;
        const ownCard = keepCards ? (this.state?.ownCard ?? null) : null;
        const peerCardInput = keepCards ? (this.state?.peerCardInput ?? '') : '';
        this.publicOwnerKey = ownerKey;
        const available = this.available();
        const busy = this.activeAction !== null;
        this.state = Object.freeze({
            revision: this.revision,
            available,
            pairingAvailable: this.pairingAvailable(),
            publicCardsAvailable: this.publicCardsAvailable(),
            busy,
            notice: busy ? MESSAGING_NOTICES.waiting : available ? MESSAGING_NOTICES.idle : MESSAGING_NOTICES.inactive,
            facts: null,
            policy: null,
            ownCard,
            peerCardInput,
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
        this.visibilityRevision += 1;
        this.reset();
    }
    setDraft(draft: string): void {
        if (this.available() && !this.state.busy && !this.state.attempt && text(draft, MESSAGING_LIMITS.textBytes))
            this.update({ draft });
    }
    setPeerCardInput(peerCardInput: string): void {
        if (
            this.publicCardsAvailable() &&
            this.activeAction === null &&
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
    private async action(operation: (ticket: Ticket) => Promise<void>, renewPairing = false): Promise<void> {
        if (!(renewPairing ? this.pairingAvailable() : this.available()) || this.activeAction !== null) return;
        const visibilityRevision = this.visibilityRevision;
        const ownerRevision = this.ownerRevision;
        const ownerKey = this.ownerKey();
        const admission = Symbol();
        this.activeAction = admission;
        this.update({ busy: true, notice: 'Native research action in progress…' });
        let ticket: Ticket | null = null;
        try {
            if (
                this.disposed ||
                !this.visible ||
                this.visibilityRevision !== visibilityRevision ||
                this.ownerRevision !== ownerRevision ||
                this.ownerKey() !== ownerKey
            )
                return;
            if (renewPairing && this.dependencies.auth.reverifyForPairing) {
                // Start a fresh check for this explicit setup action, even if
                // the UI's last poll has not noticed native lease expiry yet.
                // No timer, retry, trust confirmation or message send renews.
                const renewed = await this.dependencies.auth.reverifyForPairing!();
                const current = this.dependencies.auth.getState().account;
                if (
                    !renewed ||
                    !current ||
                    !this.available() ||
                    ownerKey === null ||
                    this.ownerKey() !== ownerKey ||
                    this.ownerRevision !== ownerRevision ||
                    this.visibilityRevision !== visibilityRevision ||
                    renewed.accountId !== current.accountId ||
                    renewed.deviceId !== current.deviceId ||
                    renewed.credentialBinding !== current.credentialBinding
                )
                    return;
            }
            if (
                this.visibilityRevision !== visibilityRevision ||
                this.ownerRevision !== ownerRevision ||
                this.ownerKey() !== ownerKey
            )
                return;
            const credentialBinding = this.dependencies.auth.getState().account!.credentialBinding;
            ticket = Object.freeze({ revision: this.revision, credentialBinding });
            await operation(ticket);
        } catch {
            if (ticket && this.current(ticket))
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
                                ? this.available()
                                    ? MESSAGING_NOTICES.idle
                                    : MESSAGING_NOTICES.inactive
                                : this.state.notice,
                    });
            }
        }
    }
    async readState(): Promise<void> {
        await this.action(async (ticket) => {
            const value = await this.readFactsForAction(ticket);
            this.commit(ticket, {
                facts: value,
                policy: value.policy,
                notice: 'Native setup facts—not permission to send.',
            });
        }, true);
    }
    private async readFactsForAction(ticket: Ticket): Promise<ResearchMessageFacts> {
        const value = facts(
            await this.call(ticket, () => this.dependencies.native.messageState(ticketOptions(ticket))),
            ticket,
        );
        this.commit(ticket, { facts: value, policy: value.policy });
        return value;
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
        }, true);
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
        }, true);
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
        const confirmedRevision = this.revision;
        const confirmedBinding = this.dependencies.auth.getState().account?.credentialBinding;
        // Trust confirmation starts a new UI generation and explicitly drops
        // public fields too. Its detached, inspected input is dispatched once.
        this.reset(false);
        if (
            this.revision !== confirmedRevision + 1 ||
            this.dependencies.auth.getState().account?.credentialBinding !== confirmedBinding
        )
            return;
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
        }, true);
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
            const clientMessageId = await this.prepareDraft(ticket, draft);
            if (clientMessageId !== null) await this.sendExisting(ticket, clientMessageId);
        });
    }
    /** Explicit research experiment: commit a pending record, without sending it. */
    async prepareOnly(): Promise<void> {
        if (this.state.attempt || !this.state.draft.trim()) return;
        const draft = this.state.draft;
        await this.action(async (ticket) => {
            const clientMessageId = await this.prepareDraft(ticket, draft);
            if (clientMessageId === null) return;
            // Validate before reconciliation: an unexpected terminal/missing row
            // must not clear this ID and authorize replacement preparation.
            const value = thread(
                await this.call(ticket, () => this.dependencies.native.messageThread(ticketOptions(ticket))),
                ticket,
            );
            const pending = value.messages.filter((row) => row.direction === 'outgoing' && row.delivery === 'pending');
            if (pending.length !== 1 || pending[0].clientMessageId !== clientMessageId || pending[0].text !== draft)
                throw unavailable();
            this.commit(ticket, { thread: value });
            this.require(ticket);
            this.commit(ticket, { notice: MESSAGING_NOTICES.prepared });
        });
    }
    private async prepareDraft(ticket: Ticket, draft: string): Promise<string | null> {
        await this.readThreadForAction(ticket);
        this.require(ticket);
        if (this.state.attempt) return null; // Explicit reconciliation, never a hidden retry.
        // Read native role before reserving an ID. A responder's definite setup
        // refusal must not look like a lost durable preparation.
        const setup = await this.readFactsForAction(ticket);
        if (!researchSendSetupReady(setup)) {
            this.commit(ticket, {
                notice:
                    setup.role === 'responder'
                        ? 'Responder: receive the other device’s first message before replying. Your draft is kept.'
                        : 'Complete native pairing, registration and initiator claim before sending. Your draft is kept.',
            });
            return null;
        }
        if (!clearPolicy(await this.refresh(ticket))) throw unavailable();
        const clientMessageId = (this.dependencies.createMessageId ?? (() => globalThis.crypto.randomUUID()))();
        if (!match(clientMessageId, UUID)) throw unavailable();
        this.require(ticket);
        // The commit may succeed even if its echo is lost. Never replace the ID.
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
        return clientMessageId;
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
            // Receiving the opening message can establish the responder. Keep
            // the displayed role current without an implicit claim or send.
            await this.readFactsForAction(ticket);
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
        const envelope = document.createElement('p');
        envelope.className = 'message-id message-envelope-hash';
        envelope.textContent = `Saved envelope SHA-256: ${message.envelopeSha256} · Equality diagnostic only; not peer trust, send permission, delivery or read confirmation.`;
        row.append(heading, content, meta, id, envelope);
        return row;
    });
    container.replaceChildren(...rows);
}
