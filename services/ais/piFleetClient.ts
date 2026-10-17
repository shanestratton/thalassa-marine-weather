/** Explicit foreground session only. No timer, auto-enabling or storage of consent authority. */
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from '../authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { getAuthenticatedFunctionHeaders } from '../supabaseAuth';
import { withDeadline, withTimeout } from '../../utils/deadline';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import * as pairingApi from '../PiPairingService';
import { piCache } from '../PiCacheService';
import { isPinnedTransportAvailable } from '../piTls';
import {
    fleetUuid,
    parseFleetForwardBinding,
    fleetConsentProposalBytes,
    AIS_FLEET_FORWARDING as LIMIT,
    type FleetForwardBinding,
    type FleetConsentProposal,
} from '../../utils/aisFleetForwarding';
import {
    enablePiFleetSharing,
    stopPiFleetSharing,
    parsePiFleetStatus,
    type PiFleetStatus,
    type PiFleetGrant,
    type PiFleetTransactionDeps,
} from './piFleetTransaction';
export function piFleetWorkerOrigin(value: unknown): string | null {
    try {
        if (typeof value !== 'string' || value.length > 512) return null;
        const url = new URL(value);
        return url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            ['/fleet-feed', LIMIT.batchPath].includes(url.pathname)
            ? url.origin
            : null;
    } catch {
        return null;
    }
}
export function isPiFleetSharingConfigured(): boolean {
    return !!piFleetWorkerOrigin(import.meta.env.VITE_FLEET_FEED_URL);
}
export function canStopPairedPiFleetSharing(): boolean {
    return !!pairingApi.getPairing() && !!piCache.lanBaseUrlNow() && isPinnedTransportAvailable();
}
/** Local privacy stop remains usable with no WAN/service configuration or readable receipt. */
export async function stopPairedPiFleetSharing(): Promise<void> {
    const scope = getAuthIdentityScope(),
        pair = pairingApi.getPairing(),
        base = piCache.lanBaseUrlNow(),
        revision = pairingApi.getPiEquipmentReadRevision();
    if (!pair || !base || !isPinnedTransportAvailable())
        throw Error('Connect to the paired Pi on the boat’s Wi-Fi to stop its local sender.');
    const current = () =>
        isAuthIdentityScopeCurrent(scope) &&
        pairingApi.getPiEquipmentReadRevision() === revision &&
        piCache.lanBaseUrlNow() === base &&
        pairingApi.getPairing()?.publicKeySpki === pair.publicKeySpki &&
        pairingApi.getPairing()?.deviceId === pair.deviceId &&
        pairingApi.getPairing()?.pairedAt === pair.pairedAt &&
        isPinnedTransportAvailable();
    const device = await withTimeout(pairingApi.getChartDevice(), null, 5000);
    if (!current() || !device) throw Error('The paired phone changed or is not enrolled.');
    const response = await withTimeout(
        pairingApi.pinnedPiRequest({
            url: base + '/api/fleet-sharing/off',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: { schema: 1 },
            connectTimeout: 2500,
            readTimeout: 4000,
            responseType: 'text',
            isCurrent: current,
        }),
        null,
        7000,
    );
    if (
        !current() ||
        !response ||
        response.status !== 200 ||
        typeof response.data !== 'string' ||
        response.data.length > 16384 ||
        new TextEncoder().encode(response.data).length > 16384
    )
        throw Error('The Pi’s local stop could not be confirmed.');
    const status = parsePiFleetStatus(JSON.parse(response.data), Date.now());
    if (!status || status.state !== 'off' || status.consent !== null)
        throw Error('The Pi’s local stop could not be confirmed.');
}
export interface PiFleetSession {
    initial: PiFleetStatus;
    vesselName: string;
    current(): boolean;
    enable(): Promise<PiFleetStatus>;
    off(): Promise<{ localStopped: boolean; cloudWithdrawn: boolean }>;
    release(): void;
}
export async function reviewPiFleetSharing(): Promise<PiFleetSession> {
    const scope = getAuthIdentityScope(),
        selected = useSettingsStore.getState(),
        boatId = selected.activeVesselId;
    if (!scope.userId || !boatId || !isPiFleetSharingConfigured())
        throw Error('Sign in and select an owned vessel with a configured fleet service.');
    const pair = pairingApi.getPairing(),
        base = piCache.lanBaseUrlNow(),
        pairRevision = pairingApi.getPiEquipmentReadRevision();
    if (!pair || !base || !isPinnedTransportAvailable()) throw Error('Connect to the paired Pi on the boat’s Wi-Fi.');
    let retired = false,
        epoch = 0,
        known: PiFleetStatus | null = null;
    let offAuth = () => {},
        offFleet = () => {},
        appState: Promise<{ remove(): Promise<void> }> | null = null;
    const controller = new AbortController();
    const samePi = () => {
        const p = pairingApi.getPairing();
        return (
            p?.deviceId === pair.deviceId &&
            p.publicKeySpki === pair.publicKeySpki &&
            p.pairedAt === pair.pairedAt &&
            pairingApi.getPiEquipmentReadRevision() === pairRevision &&
            piCache.lanBaseUrlNow() === base &&
            isPinnedTransportAvailable()
        );
    };
    const current = () => {
        const s = useSettingsStore.getState(),
            v = s.vesselFleet.find((row) => row.id === boatId);
        return (
            !retired &&
            isAuthIdentityScopeCurrent(scope) &&
            samePi() &&
            s.activeVesselId === boatId &&
            !!v &&
            v.owner_id === scope.userId &&
            !v.archived_at &&
            !v.releasedAt &&
            document.visibilityState !== 'hidden'
        );
    };
    const guard = () => {
        if (!current()) throw Error('The account, vessel or paired Pi changed. Review sharing again.');
    };
    const release = () => {
        if (retired) return;
        retired = true;
        epoch++;
        controller.abort();
        offAuth();
        offFleet();
        document.removeEventListener('visibilitychange', hidden);
        void appState?.then((h) => h.remove()).catch(() => undefined);
    };
    const hidden = () => {
        if (document.visibilityState === 'hidden') release();
    };
    offAuth = subscribeAuthIdentityScope(release);
    offFleet = useSettingsStore.subscribe((next, prior) => {
        const ownership = (s: typeof next) => {
            const v = s.vesselFleet?.find((row) => row.id === boatId);
            return JSON.stringify([
                s.activeVesselId,
                v?.owner_id ?? null,
                v?.archived_at ?? null,
                v?.releasedAt ?? null,
            ]);
        };
        if (ownership(next) !== ownership(prior)) release();
    });
    document.addEventListener('visibilitychange', hidden);
    try {
        guard();
        const { App } = await import('@capacitor/app');
        guard();
        appState = App.addListener('appStateChange', (s) => {
            if (!s.isActive) release();
        });
        if (retired) void appState.then((h) => h.remove()).catch(() => undefined);
        const setup = await withTimeout(Promise.all([pairingApi.getChartDevice(), App.getState()]), null, 5000);
        if (!setup) throw Error('The paired phone setup could not be confirmed.');
        const [device, foreground] = setup;
        guard();
        if (!device || !foreground.isActive) throw Error('Set up this phone on the boat’s Pi before sharing.');
        const read = (raw: unknown) => {
            if (typeof raw !== 'string' || raw.length > 16384 || new TextEncoder().encode(raw).length > 16384)
                throw Error('Pi sharing response unavailable.');
            return JSON.parse(raw);
        };
        const pi = async (path: string, body?: unknown, cleanup = false) => {
            if (!cleanup) guard();
            else if (!samePi()) throw Error('Original Pi unavailable for withdrawal.');
            const result = await withDeadline(
                pairingApi.pinnedPiRequest({
                    url: base + '/api/fleet-sharing/' + path,
                    method: body === undefined ? 'GET' : 'POST',
                    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
                    data: body,
                    connectTimeout: 2500,
                    readTimeout: 4000,
                    responseType: 'text',
                    isCurrent: cleanup ? samePi : current,
                }),
                7000,
                'Paired Pi sharing request',
            );
            if (!cleanup) guard();
            if (result.status !== 200) throw Error('The Pi could not confirm sharing. Review its local setup.');
            return read(result.data);
        };
        const cloud = async (path: string, body: unknown, signature?: string) => {
            guard();
            const origin = piFleetWorkerOrigin(import.meta.env.VITE_FLEET_FEED_URL)!;
            const headers = await withTimeout(getAuthenticatedFunctionHeaders(), null, 5000);
            guard();
            if (!headers) throw Error('Owner authentication could not be confirmed.');
            const abort = new AbortController(),
                timeout = setTimeout(() => abort.abort(), 6000),
                retire = () => abort.abort();
            controller.signal.addEventListener('abort', retire, { once: true });
            try {
                return await withDeadline(
                    (async () => {
                        const requestHeaders = {
                            'Content-Type': 'application/json',
                            Authorization: headers.Authorization,
                            ...(signature ? { 'X-Thalassa-Pi-Signature': signature } : {}),
                        };
                        if (Capacitor.isNativePlatform()) {
                            const response = await CapacitorHttp.post({
                                url: origin + path,
                                headers: requestHeaders,
                                data: JSON.stringify(body),
                                connectTimeout: 2500,
                                readTimeout: 6000,
                                disableRedirects: true,
                                responseType: 'text',
                            });
                            guard();
                            if (response.status !== 200)
                                throw Error('Fleet service did not confirm this request. Review the current consent.');
                            return read(response.data);
                        }
                        const response = await fetch(origin + path, {
                            method: 'POST',
                            headers: requestHeaders,
                            body: JSON.stringify(body),
                            signal: abort.signal,
                            redirect: 'error',
                            cache: 'no-store',
                        });
                        const reader = response.body?.getReader();
                        if (!reader) throw Error('Fleet service unavailable.');
                        let text = '',
                            bytes = 0;
                        const decoder = new TextDecoder('utf-8', { fatal: true });
                        try {
                            for (;;) {
                                const part = await reader.read();
                                if (part.done) break;
                                bytes += part.value.byteLength;
                                if (bytes > 16384) throw Error('Fleet service response too large.');
                                text += decoder.decode(part.value, { stream: true });
                            }
                        } finally {
                            await reader.cancel().catch(() => undefined);
                            reader.releaseLock();
                        }
                        guard();
                        if (response.status !== 200)
                            throw Error('Fleet service did not confirm this request. Review the current consent.');
                        return JSON.parse(text);
                    })(),
                    7000,
                    'Fleet consent request',
                );
            } finally {
                clearTimeout(timeout);
                controller.signal.removeEventListener('abort', retire);
            }
        };
        const parseStatus = (value: unknown) => {
            const status = parsePiFleetStatus(value, Date.now());
            if (!status) throw Error('Pi sharing status unavailable.');
            const binding = status.consent?.binding;
            if (
                binding &&
                (binding.ownerId !== scope.userId || binding.boatId !== boatId || binding.piDeviceId !== pair.deviceId)
            )
                throw Error('This Pi consent belongs to another account or vessel. Review the Pi’s owner setup.');
            return status;
        };
        known = parseStatus(await pi('status'));
        guard();
        const deps: PiFleetTransactionDeps = {
            current,
            expected: {
                ownerId: scope.userId,
                boatId,
                piDeviceId: pair.deviceId,
                controllerId: device.chartDeviceId,
                publicKeySpki: pair.publicKeySpki,
            },
            prepare: async (expected, nonce, expiresAt) =>
                pi('prepare', { schema: 1, boatId, expectedRevision: expected, nonce, expiresAt }),
            verify: async (proposal, signature) =>
                (
                    await pairingApi.verifySignedResponse(
                        pair,
                        fleetConsentProposalBytes(proposal),
                        LIMIT.consentPath,
                        { 'X-Pi-Signature': signature, 'X-Pi-Signature-Time': String(proposal.at) },
                    )
                ).ok,
            cloudStatus: async (binding: FleetForwardBinding): Promise<PiFleetGrant | null> => {
                const result = await cloud('/pi-fleet-consent/status/v1', { schema: 1, binding });
                if (!result || result.schema !== 1 || Object.keys(result).length !== 2)
                    throw Error('Fleet consent status unavailable.');
                if (result.grant === null) return null;
                const row = result.grant,
                    currentBinding = parseFleetForwardBinding(row?.binding);
                if (
                    !currentBinding ||
                    currentBinding.ownerId !== scope.userId ||
                    currentBinding.boatId !== boatId ||
                    currentBinding.relayId !== binding.relayId ||
                    !fleetUuid(row.revision) ||
                    typeof row.enabled !== 'boolean' ||
                    !Number.isSafeInteger(row.expiresAt)
                )
                    throw Error('Fleet consent status unavailable.');
                return {
                    binding: currentBinding,
                    revision: row.revision,
                    enabled: row.enabled,
                    expiresAt: row.expiresAt,
                };
            },
            enable: async (proposal, signature) => (await cloud(LIMIT.consentPath, proposal, signature)).receipt,
            confirm: async (receipt) => parseStatus(await pi('confirm', receipt)),
            stopPi: async () => {
                const stopped = parsePiFleetStatus(await pi('off', { schema: 1 }, true), Date.now());
                if (!stopped || stopped.state !== 'off' || stopped.consent !== null)
                    throw Error('The Pi’s local stop could not be confirmed.');
            },
            withdraw: async (proposal: FleetConsentProposal) => {
                await cloud(LIMIT.consentPath, proposal);
            },
        };
        const operation = async <T>(action: (scoped: PiFleetTransactionDeps) => Promise<T>): Promise<T> => {
            guard();
            const revision = ++epoch;
            const scoped = { ...deps, current: () => current() && epoch === revision };
            const result = await action(scoped);
            guard();
            if (epoch !== revision) throw Error('Sharing request retired.');
            return result;
        };
        const vessel = selected.vesselFleet.find((row) => row.id === boatId);
        return {
            initial: known,
            vesselName: vessel?.profile.name?.slice(0, 80) || 'Selected vessel',
            current,
            release,
            enable: () =>
                operation(async (scoped) => {
                    const result = await enablePiFleetSharing(scoped, known!);
                    known = result;
                    return result;
                }),
            off: () =>
                operation(async (scoped) => {
                    const result = await stopPiFleetSharing(scoped, known!);
                    if (result.localStopped) known = { ...known!, state: 'off', consent: null };
                    return result;
                }),
        };
    } catch (error) {
        release();
        throw error;
    }
}
