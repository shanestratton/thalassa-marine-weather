/** Explicit owner review bridge: a naked LAN boolean never enables forwarding. */
import {
    AIS_FLEET_FORWARDING as LIMIT,
    fleetConsentProposalBytes,
    fleetForwardBindingKey,
    parseFleetConsentProposal,
    fleetUuid,
    type FleetConsentProposal,
} from '../fleetFeedWire.js';
import { fleetHash, verifyFleetReceipt, type FleetPiContext } from './contract.js';
import type { PiIdentity } from '../identity.js';
import type { ChartDevicePublic } from '../encDevices.js';
import { wakeEnrollmentRevision } from '../wakeKeeper/contract.js';
import type { FleetConsentStore } from './store.js';
import type { FleetForwarder } from './forwarder.js';
export interface FleetKeeperDeps {
    store: FleetConsentStore;
    identity: Pick<PiIdentity, 'deviceId' | 'publicKeySpki' | 'signPayload'>;
    operatorEnabled: boolean;
    context(boatId: string, device: ChartDevicePublic): Promise<FleetPiContext | null>;
    forwarder: Pick<FleetForwarder, 'changed' | 'off' | 'status'>;
    now?: () => number;
}
export class FleetFeedKeeper {
    private readonly now: () => number;
    private pending: { proposal: FleetConsentProposal; generation: string; enrollment: string } | null = null;
    private epoch = 0;
    constructor(private readonly deps: FleetKeeperDeps) {
        this.now = deps.now ?? Date.now;
    }
    off(): void {
        this.epoch++;
        this.pending = null;
        this.deps.forwarder.off();
    }
    status() {
        const local = this.deps.store.read(this.now());
        return {
            ...this.deps.forwarder.status(),
            consent: local.receipt?.consent ?? null,
            lastLocalRevision: local.receipt?.consent.revision ?? local.blockedRevision,
        };
    }
    async prepare(raw: unknown, device: ChartDevicePublic) {
        this.pending = null;
        const epoch = ++this.epoch;
        if (!this.deps.operatorEnabled || !raw || typeof raw !== 'object' || Array.isArray(raw))
            throw Error('Fleet prerequisites held');
        const value = raw as Record<string, unknown>;
        if (
            Object.keys(value).sort().join(',') !== 'boatId,expectedRevision,expiresAt,nonce,schema' ||
            value.schema !== 1 ||
            !fleetUuid(value.boatId)
        )
            throw Error('Review the Pi sharing request');
        const saved = this.deps.store.read(this.now()),
            context = await this.deps.context(value.boatId, device);
        if (
            epoch !== this.epoch ||
            this.deps.store.read(this.now()).generation !== saved.generation ||
            !context ||
            context.binding.piDeviceId !== this.deps.identity.deviceId ||
            context.binding.boatId !== value.boatId ||
            context.binding.controllerId !== device.id ||
            context.binding.enrollmentRevision !== wakeEnrollmentRevision(device)
        )
            throw Error('The selected vessel, phone or measured source changed');
        const proposal = parseFleetConsentProposal(
            {
                schema: 1,
                binding: context.binding,
                expectedRevision: value.expectedRevision,
                enabled: true,
                consentVersion: LIMIT.consentVersion,
                at: this.now(),
                expiresAt: value.expiresAt,
                nonce: value.nonce,
                publicKeySpki: this.deps.identity.publicKeySpki,
            },
            this.now(),
        );
        if (!proposal) throw Error('Review the Pi sharing request');
        this.pending = { proposal, generation: saved.generation, enrollment: wakeEnrollmentRevision(device) };
        return {
            proposal,
            signature: this.deps.identity.signPayload(
                fleetHash(fleetConsentProposalBytes(proposal)),
                LIMIT.consentPath,
                proposal.at,
            ),
        };
    }
    async install(raw: unknown, device: ChartDevicePublic): Promise<void> {
        const pending = this.pending,
            epoch = this.epoch;
        this.pending = null; // A one-use reviewed proposal, including after failed installation.
        if (
            !pending ||
            pending.enrollment !== wakeEnrollmentRevision(device) ||
            !parseFleetConsentProposal(pending.proposal, this.now())
        )
            throw Error('Review Pi sharing again');
        const context = await this.deps.context(pending.proposal.binding.boatId, device);
        const local = this.deps.store.read(this.now());
        if (
            !context ||
            epoch !== this.epoch ||
            local.generation !== pending.generation ||
            fleetForwardBindingKey(context.binding) !== fleetForwardBindingKey(pending.proposal.binding)
        )
            throw Error('The selected vessel, phone or measured source changed');
        const receipt = verifyFleetReceipt(raw, context.token, this.now());
        if (
            !receipt ||
            !receipt.consent.enabled ||
            receipt.nonce !== pending.proposal.nonce ||
            receipt.consent.revision === pending.proposal.expectedRevision ||
            receipt.consent.revision === local.blockedRevision ||
            receipt.consent.issuedAt < pending.proposal.at ||
            receipt.consent.expiresAt !== pending.proposal.expiresAt ||
            fleetForwardBindingKey(receipt.consent.binding) !== fleetForwardBindingKey(pending.proposal.binding)
        )
            throw Error('The server did not confirm this exact Pi consent');
        this.deps.store.save(receipt, null);
        this.deps.forwarder.changed();
    }
}
