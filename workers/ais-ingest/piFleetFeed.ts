/** Informational source-only Pi feed. Rights, current SQL consent and replay
 * admission precede every shared-table enqueue or downstream schedule. */
import {
    AIS_FLEET_FORWARDING as LIMIT,
    fleetForwardBatchBytes,
    fleetConsentProposalBytes,
    parseFleetForwardBatch,
    parseFleetConsentProposal,
    type FleetForwardBatch,
} from './fleetForwardingWire.js';
import { decodeAisSentence, aivdoToAivdm } from './aivdm.js';
import type { VesselRecord } from './parser.js';
import type { PiFleetStore } from './piFleetStore.js';
import { fleetConsentReceipt, verifyFleetPiPayload } from './fleetCrypto.js';

export interface PiFleetResult {
    status: number;
    body: Record<string, unknown>;
}
export interface PiFleetDataDeps {
    store: PiFleetStore;
    operatorEnabled: boolean;
    enqueue(record: VesselRecord): void;
    /** Schedules only, not proof of delivery. No default socket is opened here. */
    scheduleForward(line: string): void;
    signal?: AbortSignal;
    now?: () => number;
}
const fail = (status: number, code: string): PiFleetResult => ({ status, body: { code } });
function json(raw: string): unknown {
    if (Buffer.byteLength(raw, 'utf8') > LIMIT.batchBytes) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
/** Fixed framing/checksum rebuild drops all original trailing bytes. */
function receivedLine(sentence: string): string {
    const body = sentence.slice(1, sentence.lastIndexOf('*'));
    let sum = 0;
    for (const char of body) sum ^= char.charCodeAt(0);
    return `!${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
}
export async function processPiFleetBatch(
    raw: string,
    signature: string,
    relayId: string,
    relayToken: string,
    deps: PiFleetDataDeps,
): Promise<PiFleetResult> {
    if (!deps.operatorEnabled) return fail(503, 'fleet-prerequisites-held');
    const now = deps.now ?? Date.now;
    const batch = parseFleetForwardBatch(json(raw), now());
    if (!batch || relayId !== batch.binding.relayId || !/^[a-f0-9]{64}$/.test(relayToken))
        return fail(400, 'invalid-pi-fleet-batch');
    if (deps.signal?.aborted) return fail(499, 'cancelled');
    try {
        const authority = await deps.store.relay(batch.binding.ownerId, batch.binding.boatId, relayId, relayToken);
        if (deps.signal?.aborted) return fail(499, 'cancelled');
        if (!authority) return fail(401, 'pi-relay-not-current');
        const grant = await deps.store.grant(batch.binding);
        if (deps.signal?.aborted) return fail(499, 'cancelled');
        if (
            !grant ||
            !grant.enabled ||
            grant.expiresAt <= now() ||
            grant.revision !== batch.consentRevision ||
            !verifyFleetPiPayload(grant.spki, fleetForwardBatchBytes(batch), LIMIT.batchPath, batch.sentAt, signature)
        )
            return fail(403, 'pi-consent-not-current');
        const source = `pi:${batch.binding.piDeviceId}:${batch.consentRevision}:${batch.bootId}`;
        const records: VesselRecord[] = [];
        let receivedAt: number | null = null;
        for (const observation of batch.observations) {
            const record = decodeAisSentence(observation.sentence, observation.receivedAt, source);
            if (record) {
                records.push(record);
                if (observation.sentence.startsWith('!AIVDM'))
                    receivedAt = Math.max(receivedAt ?? 0, observation.receivedAt);
            }
        }
        // Key/owner/boat/relay/consent may retire during verification. Only the
        // real atomic RPC result can admit the final exact snapshot.
        const admitted = await deps.store.admit(batch, authority.tokenHash, grant.spki, receivedAt);
        if (deps.signal?.aborted) return fail(499, 'cancelled');
        if (!admitted) return fail(409, 'consent-replay-or-budget-held');
        if (!parseFleetForwardBatch(batch, now())) return fail(409, 'pi-observations-expired');
        // No intervening await after actual admission. Local CPA/alarm stores
        // never receive this internet source.
        for (const record of records) deps.enqueue(record);
        for (const observation of batch.observations) {
            const line = observation.sentence.startsWith('!AIVDO')
                ? aivdoToAivdm(observation.sentence)
                : receivedLine(observation.sentence);
            if (line) deps.scheduleForward(line);
        }
        return {
            status: 200,
            body: {
                accepted: batch.observations.length,
                decoded: records.length,
                forwardScheduled: batch.observations.length,
                deliveryConfirmed: false,
                consentRevision: batch.consentRevision,
            },
        };
    } catch {
        return fail(503, 'pi-fleet-service-unavailable');
    }
}

export interface PiFleetConsentDeps {
    store: PiFleetStore;
    operatorEnabled: boolean;
    /** Actual live auth.getUser result, never a body/account claim. */
    authenticateOwner(): Promise<string | null>;
    signal?: AbortSignal;
    now?: () => number;
}
export async function processPiFleetConsent(
    raw: string,
    signature: string | null,
    deps: PiFleetConsentDeps,
): Promise<PiFleetResult> {
    const now = deps.now ?? Date.now;
    const proposal = parseFleetConsentProposal(json(raw), now());
    if (!proposal) return fail(400, 'invalid-pi-fleet-consent');
    if (proposal.enabled && !deps.operatorEnabled) return fail(503, 'fleet-prerequisites-held');
    if (deps.signal?.aborted) return fail(499, 'cancelled');
    try {
        const owner = await deps.authenticateOwner();
        if (deps.signal?.aborted) return fail(499, 'cancelled');
        if (!owner || owner !== proposal.binding.ownerId) return fail(401, 'owner-required');
        if (
            proposal.enabled &&
            (!signature ||
                !proposal.publicKeySpki ||
                !verifyFleetPiPayload(
                    proposal.publicKeySpki,
                    fleetConsentProposalBytes(proposal),
                    LIMIT.consentPath,
                    proposal.at,
                    signature,
                ))
        )
            return fail(403, 'paired-pi-proof-required');
        const authority = await deps.store.relay(owner, proposal.binding.boatId, proposal.binding.relayId);
        if (deps.signal?.aborted) return fail(499, 'cancelled');
        if (!authority) return fail(403, 'owned-vessel-pi-required');
        if (!parseFleetConsentProposal(proposal, now())) return fail(409, 'pi-consent-proof-expired');
        const consent = await deps.store.configure(proposal);
        if (deps.signal?.aborted) return fail(499, 'cancelled');
        return { status: 200, body: { receipt: fleetConsentReceipt(consent, authority.tokenHash, proposal.nonce) } };
    } catch {
        return fail(409, 'pi-consent-not-confirmed');
    }
}

export type { FleetForwardBatch };
