/** Actual service-role RPC adapter; no missing-function or legacy-writer fallback. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'node:crypto';
import { fleetRelayTokenHash } from './fleetCrypto.js';
import {
    fleetForwardBindingKey,
    parseFleetForwardBinding,
    parseFleetForwardConsent,
    type FleetConsentProposal,
    type FleetForwardBatch,
    type FleetForwardBinding,
    type FleetForwardConsent,
} from './fleetForwardingWire.js';

export interface ReceiverAuthority {
    ownerId: string;
    boatId: string;
    relayId: string;
    tokenHash: string;
}
export interface ReceiverGrant {
    binding: FleetForwardBinding;
    revision: string;
    spki: string;
    enabled: boolean;
    expiresAt: number;
}
export interface PiFleetStore {
    relay(ownerId: string, boatId: string, relayId: string, rawToken?: string): Promise<ReceiverAuthority | null>;
    grant(binding: FleetForwardBinding): Promise<ReceiverGrant | null>;
    configure(proposal: FleetConsentProposal): Promise<FleetForwardConsent>;
    admit(batch: FleetForwardBatch, tokenHash: string, spki: string, receivedAt: number | null): Promise<boolean>;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const deadline = () => AbortSignal.timeout(5000);
export function postgresPiFleetStore(client: SupabaseClient, now = Date.now): PiFleetStore {
    return {
        async relay(ownerId, boatId, relayId, rawToken) {
            const result = await client
                .from('pi_diary_relays')
                .select('owner_id,boat_id,relay_id,token_hash,enabled')
                .eq('relay_id', relayId)
                .maybeSingle()
                .abortSignal(deadline());
            if (result.error) throw Error('Fleet relay authority unavailable');
            const row = result.data as unknown;
            if (
                !record(row) ||
                row.enabled !== true ||
                row.owner_id !== ownerId ||
                row.boat_id !== boatId ||
                row.relay_id !== relayId ||
                typeof row.token_hash !== 'string' ||
                !/^[a-f0-9]{64}$/.test(row.token_hash)
            )
                return null;
            if (
                rawToken !== undefined &&
                !timingSafeEqual(Buffer.from(fleetRelayTokenHash(rawToken), 'hex'), Buffer.from(row.token_hash, 'hex'))
            )
                return null;
            return { ownerId, boatId, relayId, tokenHash: row.token_hash };
        },
        async grant(binding) {
            const result = await client
                .rpc('read_ais_receiver_consent', {
                    p_owner: binding.ownerId,
                    p_boat: binding.boatId,
                    p_relay: binding.relayId,
                })
                .abortSignal(deadline());
            if (result.error) throw Error('Fleet consent unavailable');
            const row = result.data as unknown;
            if (!record(row)) return null;
            const parsed = parseFleetForwardBinding(row.binding);
            if (
                !parsed ||
                fleetForwardBindingKey(parsed) !== fleetForwardBindingKey(binding) ||
                typeof row.revision !== 'string' ||
                !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.revision) ||
                typeof row.spki !== 'string' ||
                row.spki.length > 256 ||
                typeof row.enabled !== 'boolean' ||
                typeof row.expiresAt !== 'number' ||
                !Number.isSafeInteger(row.expiresAt)
            )
                return null;
            return {
                binding: parsed,
                revision: row.revision,
                spki: row.spki,
                enabled: row.enabled,
                expiresAt: row.expiresAt,
            };
        },
        async configure(proposal) {
            const result = await client
                .rpc('set_ais_receiver_consent', {
                    p_owner: proposal.binding.ownerId,
                    p_binding: proposal.binding,
                    p_expected: proposal.expectedRevision,
                    p_enabled: proposal.enabled,
                    p_spki: proposal.publicKeySpki,
                    p_expires_at: proposal.expiresAt === null ? null : new Date(proposal.expiresAt).toISOString(),
                })
                .abortSignal(deadline());
            if (result.error)
                throw Error(result.error.code === '40001' ? 'Fleet consent changed' : 'Fleet consent not confirmed');
            const consent = parseFleetForwardConsent(result.data, now());
            if (
                !consent ||
                fleetForwardBindingKey(consent.binding) !== fleetForwardBindingKey(proposal.binding) ||
                consent.enabled !== proposal.enabled
            )
                throw Error('Fleet consent not confirmed');
            return consent;
        },
        async admit(batch, tokenHash, spki, receivedAt) {
            const result = await client
                .rpc('admit_ais_receiver_batch', {
                    p_binding: batch.binding,
                    p_revision: batch.consentRevision,
                    p_token_hash: tokenHash,
                    p_spki: spki,
                    p_boot: batch.bootId,
                    p_sequence: batch.sequence,
                    p_sent_at: new Date(batch.sentAt).toISOString(),
                    p_cell: batch.cell?.id ?? null,
                    p_fix_at: batch.cell ? new Date(batch.cell.measuredAt).toISOString() : null,
                    p_last_heard: receivedAt === null ? null : new Date(receivedAt).toISOString(),
                    p_received_ais: receivedAt !== null,
                })
                .abortSignal(deadline());
            if (result.error) throw Error('Fleet admission unavailable');
            return result.data === true;
        },
    };
}
