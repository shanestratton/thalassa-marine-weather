import { it, expect } from 'vitest';
import {
    enablePiFleetSharing,
    stopPiFleetSharing,
    type PiFleetStatus,
    type PiFleetTransactionDeps,
} from '../services/ais/piFleetTransaction';
import {
    AIS_FLEET_FORWARDING as LIMIT,
    type FleetConsentProposal,
    type FleetForwardConsent,
} from '../utils/aisFleetForwarding';
const now = 1800000000000;
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
    let epoch = 0,
        identity = 'A',
        nonce = 0;
    const events: string[] = [];
    const binding = {
        ownerId: uuid(1),
        boatId: uuid(2),
        piDeviceId: uuid(3),
        relayId: 'fixture-phone-relay140',
        pairingId: 'a'.repeat(64),
        controllerId: uuid(4),
        enrollmentRevision: 'b'.repeat(64),
        sourceKey: 'c'.repeat(64),
    };
    let proposal: FleetConsentProposal;
    const initial: PiFleetStatus = {
        operatorConfigured: true,
        state: 'off',
        consent: null,
        lastLocalRevision: null,
        lastAcknowledgedAt: null,
    };
    const consent = (): FleetForwardConsent => ({
        schema: 1,
        binding,
        revision: uuid(10),
        enabled: true,
        consentVersion: LIMIT.consentVersion,
        issuedAt: now,
        expiresAt: proposal.expiresAt!,
    });
    const status = (): PiFleetStatus => ({
        ...initial,
        state: 'listening',
        consent: consent(),
        lastLocalRevision: uuid(10),
    });
    const deps: PiFleetTransactionDeps = {
        current: () => epoch === 0 && identity === 'A',
        expected: {
            ownerId: binding.ownerId,
            boatId: binding.boatId,
            piDeviceId: binding.piDeviceId,
            controllerId: binding.controllerId,
            publicKeySpki: 'A'.repeat(120),
        },
        now: () => now,
        nonce: () => uuid(20 + ++nonce),
        prepare: async (expected, nonce, expiresAt) => {
            events.push('prepare');
            proposal = {
                schema: 1,
                binding,
                expectedRevision: expected,
                enabled: true,
                consentVersion: LIMIT.consentVersion,
                at: now,
                expiresAt,
                nonce,
                publicKeySpki: 'A'.repeat(120),
            };
            return { proposal, signature: 'fixture-paired-signature' };
        },
        verify: async () => {
            events.push('verify');
            return true;
        },
        cloudStatus: async () => {
            events.push('cloud-status');
            return null;
        },
        enable: async () => {
            events.push('cloud-enable');
            return { consent: consent(), nonce: proposal.nonce, mac: 'd'.repeat(64) };
        },
        confirm: async () => {
            events.push('confirm');
            return status();
        },
        stopPi: async () => {
            events.push('stop-pi');
        },
        withdraw: async () => {
            events.push('withdraw');
        },
    };
    return {
        deps,
        initial,
        binding,
        events,
        status,
        retire: () => {
            identity = 'B';
            epoch++;
            identity = 'A';
            epoch++;
        },
        proposal: () => proposal,
    };
}
it('fresh actual adapters execute prepare, paired proof, ownerCAS and Pi confirmation in order', async () => {
    const f = fixture();
    expect((await enablePiFleetSharing(f.deps, f.initial)).consent?.enabled).toBe(true);
    expect(f.events).toEqual(['prepare', 'verify', 'cloud-status', 'cloud-enable', 'confirm']);
});
it('unconfigured/off default cannot give consent or make any adapter call', async () => {
    const f = fixture();
    await expect(enablePiFleetSharing(f.deps, { ...f.initial, operatorConfigured: false })).rejects.toThrow(
        'stays off',
    );
    expect(f.events).toEqual([]);
});
for (const phase of ['prepare', 'verify', 'cloudStatus', 'enable', 'confirm'] as const)
    it('A/B/A retirement during ' + phase + ' cannot adopt or continue an old enable', async () => {
        const f = fixture(),
            original = f.deps[phase];
        f.deps[phase] = (async (...args: unknown[]) => {
            const value = await (original as (...v: unknown[]) => Promise<unknown>)(...args);
            f.retire();
            return value;
        }) as never;
        await expect(enablePiFleetSharing(f.deps, f.initial)).rejects.toThrow();
        expect(f.events.includes('confirm')).toBe(phase === 'confirm');
        expect(f.events.filter((e) => e === 'stop-pi')).toHaveLength(phase === 'confirm' ? 1 : 0);
    });
for (const field of ['ownerId', 'boatId', 'piDeviceId', 'controllerId'] as const)
    it('wrong ' + field + ' in a Pi proposal cannot reach cloud enable', async () => {
        const f = fixture(),
            prepare = f.deps.prepare;
        f.deps.prepare = async (...args) => {
            const p = await prepare(...args);
            return {
                ...p,
                proposal: { ...(p.proposal as FleetConsentProposal), binding: { ...f.binding, [field]: uuid(99) } },
            };
        };
        await expect(enablePiFleetSharing(f.deps, f.initial)).rejects.toThrow();
        expect(f.events).not.toContain('cloud-enable');
    });
it('old or fabricated receipt nonce cannot confirm on the Pi', async () => {
    const f = fixture(),
        enable = f.deps.enable;
    f.deps.enable = async (...args) => ({ ...((await enable(...args)) as object), nonce: uuid(99) });
    await expect(enablePiFleetSharing(f.deps, f.initial)).rejects.toThrow('exact consent');
    expect(f.events).not.toContain('confirm');
});
it('current cloud revision after local loss produces a new signed proposal before enabling', async () => {
    const f = fixture();
    f.deps.cloudStatus = async () => ({ binding: f.binding, revision: uuid(8), enabled: false, expiresAt: now + 1000 });
    await enablePiFleetSharing(f.deps, f.initial);
    expect(f.events.filter((e) => e === 'prepare')).toHaveLength(2);
    expect(f.proposal().expectedRevision).toBe(uuid(8));
});
it('paired signature refusal never reaches a service write', async () => {
    const f = fixture();
    f.deps.verify = async () => false;
    await expect(enablePiFleetSharing(f.deps, f.initial)).rejects.toThrow();
    expect(f.events).not.toContain('cloud-enable');
});
it('local stop happens first and failed cloud withdrawal stays honestly pending', async () => {
    const f = fixture();
    await f.deps.prepare(null, uuid(20), now + 10000);
    const known = f.status();
    f.deps.cloudStatus = async () => {
        f.events.push('cloud-status');
        return { binding: f.binding, revision: uuid(10), enabled: true, expiresAt: now + 10000 };
    };
    f.deps.withdraw = async () => {
        f.events.push('withdraw');
        throw Error('fixture outage');
    };
    f.events.length = 0;
    expect(await stopPiFleetSharing(f.deps, known)).toEqual({ localStopped: true, cloudWithdrawn: false });
    expect(f.events).toEqual(['stop-pi', 'cloud-status', 'withdraw']);
});
it('unreachable Pi may still have its cloud permission withdrawn, with no fabricated local acknowledgement', async () => {
    const f = fixture();
    await f.deps.prepare(null, uuid(20), now + 10000);
    const known = f.status();
    f.deps.stopPi = async () => {
        throw Error('LAN unavailable');
    };
    f.deps.cloudStatus = async () => ({
        binding: f.binding,
        revision: uuid(10),
        enabled: true,
        expiresAt: now + 10000,
    });
    expect(await stopPiFleetSharing(f.deps, known)).toEqual({ localStopped: false, cloudWithdrawn: true });
});
