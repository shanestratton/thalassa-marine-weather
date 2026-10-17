/** One durable receipt/tombstone; no AIS, receiver position or traffic retry file. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FLEET_LOCAL_BYTES, type FleetReceipt } from './contract.js';
import { fleetUuid, parseFleetForwardConsent } from '../fleetFeedWire.js';
export interface FleetLocalSnapshot {
    schema: 1;
    generation: string;
    receipt: FleetReceipt | null;
    blockedRevision: string | null;
}
export class FleetConsentStore {
    constructor(private readonly file: string) {}
    read(now: number): FleetLocalSnapshot {
        if (!fs.existsSync(this.file)) return { schema: 1, generation: 'absent', receipt: null, blockedRevision: null };
        const stat = fs.lstatSync(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FLEET_LOCAL_BYTES)
            throw Error('Fleet consent storage unavailable');
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as FleetLocalSnapshot;
        if (
            !raw ||
            Object.keys(raw).length !== 4 ||
            raw.schema !== 1 ||
            !fleetUuid(raw.generation) ||
            (raw.blockedRevision !== null && !fleetUuid(raw.blockedRevision)) ||
            (raw.receipt !== null &&
                (!parseFleetForwardConsent(raw.receipt?.consent, now) ||
                    typeof raw.receipt?.mac !== 'string' ||
                    !/^[a-f0-9]{64}$/.test(raw.receipt.mac)))
        )
            throw Error('Fleet consent storage unavailable');
        return raw;
    }
    save(receipt: FleetReceipt | null, blockedRevision: string | null): FleetLocalSnapshot {
        const value: FleetLocalSnapshot = { schema: 1, generation: randomUUID(), receipt, blockedRevision };
        const text = JSON.stringify(value);
        if (Buffer.byteLength(text) > FLEET_LOCAL_BYTES) throw Error('Fleet consent storage unavailable');
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        if (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink())
            throw Error('Fleet consent storage unavailable');
        const temporary = this.file + '.' + randomUUID() + '.tmp';
        try {
            fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
            fs.renameSync(temporary, this.file);
        } finally {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
        return value;
    }
    off(now: number): void {
        let revision: string | null = null;
        try {
            const prior = this.read(now);
            revision = prior.receipt?.consent.revision ?? prior.blockedRevision;
        } catch {
            /* corrupt state remains OFF */
        }
        this.save(null, revision);
    }
}
