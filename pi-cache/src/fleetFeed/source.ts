/** Read-only locally declared Signal K receiver rebroadcast, never the boat gateway. */
import { createConnection, type Socket } from 'node:net';
import { fleetHash, type FleetPiContext } from './contract.js';
import { validFleetAisSentence, fleetCoverageCell, AIS_FLEET_FORWARDING as LIMIT } from '../fleetFeedWire.js';
import { readWeatherPositionLeaf } from '../weatherPosition.js';
import { validSignalKSelf } from '../signalkProtocol.js';
import { wakePairingId, wakeEnrollmentRevision } from '../wakeKeeper/contract.js';
import type { ChartDevicePublic } from '../encDevices.js';

export function localFleetSource(options: {
    port?: number;
    reference?: string;
}): { port: number; reference: string } | null {
    return Number.isInteger(options.port) &&
        options.port! >= 1 &&
        options.port! <= 65535 &&
        typeof options.reference === 'string' &&
        /^[\x20-\x7e]{1,160}$/.test(options.reference) &&
        options.reference.trim()
        ? { port: options.port!, reference: options.reference }
        : null;
}
/** Port/source review is an operator assertion, not RF provenance attestation.
 * The declaration must name a receiver-only local rebroadcast, without provider inputs. */
export function currentFleetContext(input: {
    source: ReturnType<typeof localFleetSource>;
    document: unknown;
    now: number;
    ownerId: string;
    relayId: string;
    token: string;
    piDeviceId: string;
    boatId: string;
    device: ChartDevicePublic;
    allowInternet: boolean;
}): FleetPiContext | null {
    const doc = input.document as { uuid?: unknown } | null;
    if (!input.source || !doc || !validSignalKSelf(doc.uuid)) return null;
    const leaf = readWeatherPositionLeaf(input.document, input.now);
    const cellId =
        leaf && input.now - leaf.position.at <= LIMIT.fixAgeMs
            ? fleetCoverageCell(leaf.position.lat, leaf.position.lon)
            : null;
    return {
        binding: {
            ownerId: input.ownerId,
            boatId: input.boatId,
            piDeviceId: input.piDeviceId,
            relayId: input.relayId,
            pairingId: wakePairingId(input.ownerId, input.piDeviceId, input.relayId),
            controllerId: input.device.id,
            enrollmentRevision: wakeEnrollmentRevision(input.device),
            sourceKey: fleetHash(
                JSON.stringify([
                    1,
                    'local-signalk-ais-receiver',
                    input.piDeviceId,
                    input.source.port,
                    input.source.reference,
                    doc.uuid,
                ]),
            ),
        },
        token: input.token,
        allowInternet: input.allowInternet,
        cell: cellId && leaf ? { id: cellId, measuredAt: leaf.position.at } : null,
    };
}
export class FleetAisInput {
    private context: string | null = null;
    private socket: Socket | null = null;
    private retry: ReturnType<typeof setTimeout> | null = null;
    private generation = 0;
    constructor(
        private readonly port: number | null,
        private readonly receive: (sentence: string, at: number, context: string) => void,
        private readonly now = Date.now,
    ) {
        if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))
            throw Error('Invalid local receiver port');
    }
    setContext(key: string | null): void {
        if (key === this.context) return;
        this.generation++;
        this.context = key;
        if (this.retry) clearTimeout(this.retry);
        this.retry = null;
        const socket = this.socket;
        this.socket = null;
        socket?.destroy();
        if (key && this.port !== null) this.connect(this.generation, key);
    }
    private connect(generation: number, key: string): void {
        if (!this.port || generation !== this.generation || key !== this.context) return;
        const socket = createConnection({ host: '127.0.0.1', port: this.port });
        this.socket = socket;
        const current = () => this.socket === socket && generation === this.generation && key === this.context;
        let line = '',
            discard = false,
            bytes = 0,
            epoch = this.now();
        socket.setTimeout(15000);
        socket.on('data', (chunk: Buffer) => {
            if (!current()) return;
            const at = this.now();
            if (at < epoch || at - epoch >= 1000) {
                epoch = at;
                bytes = 0;
            }
            bytes += chunk.length;
            if (chunk.length > 65536 || bytes > 1024 * 1024) {
                socket.destroy();
                return;
            }
            for (const byte of chunk) {
                if (byte === 10) {
                    const value = line.endsWith('\r') ? line.slice(0, -1) : line;
                    if (!discard && validFleetAisSentence(value)) this.receive(value, at, key);
                    line = '';
                    discard = false;
                } else if (!discard) {
                    if (line.length >= LIMIT.sentenceBytes || byte < 13 || byte > 126 || (byte > 13 && byte < 32)) {
                        line = '';
                        discard = true;
                    } else line += String.fromCharCode(byte);
                }
            }
        });
        socket.on('error', () => {
            /* Raw traffic, credentials and endpoints never enter logs. */
        });
        socket.on('timeout', () => socket.destroy());
        socket.on('close', () => {
            if (!current()) return;
            this.socket = null;
            this.retry = setTimeout(() => {
                this.retry = null;
                this.connect(generation, key);
            }, 2000);
            this.retry.unref();
        });
    }
}
