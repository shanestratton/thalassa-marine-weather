/** Bounded explicit transaction. Runtime adapters supply actual pinned Pi and owner auth. */
import {
    AIS_FLEET_FORWARDING as LIMIT,
    parseFleetConsentProposal,
    parseFleetForwardConsent,
    fleetForwardBindingKey,
    fleetUuid,
    type FleetConsentProposal,
    type FleetForwardBinding,
    type FleetForwardConsent,
} from '../../utils/aisFleetForwarding';
export interface PiFleetStatus {
    operatorConfigured: boolean;
    state: string;
    consent: FleetForwardConsent | null;
    lastLocalRevision: string | null;
    lastAcknowledgedAt: number | null;
}
export interface PiFleetGrant {
    binding: FleetForwardBinding;
    revision: string;
    enabled: boolean;
    expiresAt: number;
}
export interface PiFleetTransactionDeps {
    current(): boolean;
    prepare(
        expected: string | null,
        nonce: string,
        expiresAt: number,
    ): Promise<{ proposal: unknown; signature: string }>;
    verify(proposal: FleetConsentProposal, signature: string): Promise<boolean>;
    cloudStatus(binding: FleetForwardBinding): Promise<PiFleetGrant | null>;
    enable(proposal: FleetConsentProposal, signature: string): Promise<unknown>;
    confirm(receipt: unknown): Promise<PiFleetStatus>;
    stopPi(): Promise<void>;
    withdraw(proposal: FleetConsentProposal): Promise<void>;
    expected: { ownerId: string; boatId: string; piDeviceId: string; controllerId: string; publicKeySpki: string };
    now?: () => number;
    nonce?: () => string;
}
export function parsePiFleetStatus(v: unknown, now: number): PiFleetStatus | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const row = v as Record<string, unknown>,
        consent = row.consent === null ? null : parseFleetForwardConsent(row.consent, now);
    if (
        row.schema !== 1 ||
        typeof row.operatorConfigured !== 'boolean' ||
        typeof row.state !== 'string' ||
        row.state.length > 80 ||
        (row.consent !== null && !consent) ||
        (row.lastLocalRevision !== null && !fleetUuid(row.lastLocalRevision)) ||
        (row.lastAcknowledgedAt !== null &&
            (typeof row.lastAcknowledgedAt !== 'number' ||
                !Number.isSafeInteger(row.lastAcknowledgedAt) ||
                row.lastAcknowledgedAt > now))
    )
        return null;
    return {
        operatorConfigured: row.operatorConfigured,
        state: row.state,
        consent,
        lastLocalRevision: row.lastLocalRevision as string | null,
        lastAcknowledgedAt: row.lastAcknowledgedAt as number | null,
    };
}
export async function enablePiFleetSharing(
    deps: PiFleetTransactionDeps,
    initial: PiFleetStatus,
): Promise<PiFleetStatus> {
    const now = deps.now ?? Date.now,
        nonce = deps.nonce ?? (() => crypto.randomUUID());
    const guard = () => {
        if (!deps.current()) throw Error('The account, vessel or paired phone changed. Review Pi sharing again.');
    };
    const expiresAt = now() + LIMIT.grantMaxMs - 60000;
    const prepared = async (expected: string | null) => {
        guard();
        const response = await deps.prepare(expected, nonce(), expiresAt);
        guard();
        const p = parseFleetConsentProposal(response.proposal, now()),
            e = deps.expected;
        if (
            !p ||
            !p.enabled ||
            p.binding.ownerId !== e.ownerId ||
            p.binding.boatId !== e.boatId ||
            p.binding.piDeviceId !== e.piDeviceId ||
            p.binding.controllerId !== e.controllerId ||
            p.publicKeySpki !== e.publicKeySpki ||
            p.expectedRevision !== expected ||
            p.expiresAt !== expiresAt ||
            !(await deps.verify(p, response.signature))
        )
            throw Error('The paired Pi did not confirm this sharing request.');
        guard();
        return { proposal: p, signature: response.signature };
    };
    let confirming = false,
        accepted = false;
    try {
        guard();
        if (!initial.operatorConfigured) throw Error('The Pi fleet service is not configured. Sharing stays off.');
        if (initial.state === 'unavailable')
            throw Error('Use Stop Pi sharing to clear unreadable local consent, then review again.');
        let review = await prepared(initial.lastLocalRevision);
        const cloud = await deps.cloudStatus(review.proposal.binding);
        guard();
        const expected = cloud?.revision ?? null;
        if (expected !== review.proposal.expectedRevision) review = await prepared(expected);
        guard();
        const receipt = await deps.enable(review.proposal, review.signature);
        guard();
        const row = receipt as { consent?: unknown; nonce?: unknown },
            consent = parseFleetForwardConsent(row?.consent, now());
        if (
            !consent ||
            !consent.enabled ||
            row.nonce !== review.proposal.nonce ||
            consent.revision === expected ||
            fleetForwardBindingKey(consent.binding) !== fleetForwardBindingKey(review.proposal.binding)
        )
            throw Error('The service did not confirm this exact consent. Sharing on the Pi is not confirmed.');
        confirming = true;
        const status = await deps.confirm(receipt);
        guard();
        if (
            !status.consent?.enabled ||
            status.consent.revision !== consent.revision ||
            fleetForwardBindingKey(status.consent.binding) !== fleetForwardBindingKey(consent.binding)
        )
            throw Error('Pi confirmation unavailable.');
        accepted = true;
        return status;
    } finally {
        // A native request already in flight cannot be unsent. If its result
        // retires, explicitly stand this Pi down; never publish a stale success.
        if (confirming && !accepted) await deps.stopPi().catch(() => undefined);
    }
}
export async function stopPiFleetSharing(
    deps: PiFleetTransactionDeps,
    known: PiFleetStatus,
): Promise<{ localStopped: boolean; cloudWithdrawn: boolean }> {
    // No confirmation sheet, and local stop precedes any WAN read.
    let localStopped = false,
        cloudWithdrawn = false;
    try {
        await deps.stopPi();
        localStopped = true;
    } catch {
        /* Report separately; do not claim a remote stop. */
    }
    if (!deps.current()) return { localStopped, cloudWithdrawn };
    const binding = known.consent?.binding;
    if (!binding) return { localStopped, cloudWithdrawn };
    try {
        const grant = await deps.cloudStatus(binding);
        if (!deps.current()) return { localStopped, cloudWithdrawn };
        if (!grant || !grant.enabled) cloudWithdrawn = true;
        else {
            const p: FleetConsentProposal = {
                schema: 1,
                binding: grant.binding,
                expectedRevision: grant.revision,
                enabled: false,
                consentVersion: LIMIT.consentVersion,
                at: (deps.now ?? Date.now)(),
                expiresAt: null,
                nonce: (deps.nonce ?? (() => crypto.randomUUID()))(),
                publicKeySpki: null,
            };
            await deps.withdraw(p);
            if (deps.current()) cloudWithdrawn = true;
        }
    } catch {
        /* A failed WAN revoke never changes the truthful local result. */
    }
    return { localStopped, cloudWithdrawn };
}
