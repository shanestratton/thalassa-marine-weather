/** Bounded140 Pi HTTP front door. No auth cache, provider/socket or timer at import. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AIS_FLEET_FORWARDING as LIMIT, fleetUuid, parseFleetForwardBinding } from './fleetForwardingWire.js';
import { processPiFleetBatch, processPiFleetConsent } from './piFleetFeed.js';
import type { PiFleetStore } from './piFleetStore.js';
import type { VesselRecord } from './parser.js';
export interface PiFleetHttpDeps {
    store: PiFleetStore | null;
    operatorEnabled: boolean;
    authenticateOwner(authorization: string, signal: AbortSignal): Promise<string | null>;
    enqueue(record: VesselRecord): void;
    scheduleForward(line: string): void;
    origins?: string;
}
function readBody(req: IncomingMessage, signal: AbortSignal, limit: number): Promise<string | null> {
    return new Promise((resolve) => {
        let bytes = 0,
            settled = false;
        const chunks: Buffer[] = [];
        const done = (value: string | null) => {
            if (settled) return;
            settled = true;
            req.off('data', data);
            req.off('end', end);
            req.off('error', abort);
            signal.removeEventListener('abort', abort);
            resolve(value);
        };
        const abort = () => done(null);
        const data = (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > limit) {
                req.pause();
                done(null);
                return;
            }
            chunks.push(chunk);
        };
        const end = () => {
            try {
                done(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            } catch {
                done(null);
            }
        };
        req.on('data', data);
        req.once('end', end);
        req.once('error', abort);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
}
export function createPiFleetHttp(deps: PiFleetHttpDeps) {
    let active = 0;
    return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
        if (![LIMIT.batchPath, LIMIT.consentPath, '/pi-fleet-consent/status/v1'].includes(req.url ?? '')) return false;
        const allowed = (deps.origins ?? '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        const headers = {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': allowed.length
                ? origin && allowed.includes(origin)
                    ? origin
                    : allowed[0]
                : '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'authorization,content-type,x-thalassa-pi-signature,x-thalassa-relay',
            Vary: 'Origin',
        };
        const reply = (status: number, body: Record<string, unknown>) => {
            if (res.destroyed || res.writableEnded) return;
            res.writeHead(status, headers);
            res.end(JSON.stringify(body));
        };
        if (req.method === 'OPTIONS') {
            res.writeHead(204, headers);
            res.end();
            return true;
        }
        if (req.method !== 'POST') {
            reply(405, { error: 'POST required' });
            return true;
        }
        if (!deps.store) {
            reply(503, { error: 'fleet-service-unavailable' });
            return true;
        }
        const batch = req.url === LIMIT.batchPath;
        if (batch && !deps.operatorEnabled) {
            reply(503, { error: 'fleet-prerequisites-held' });
            return true;
        }
        if (active >= 16) {
            reply(503, { error: 'fleet-capacity-held' });
            return true;
        }
        const authorization = req.headers.authorization,
            signature = req.headers['x-thalassa-pi-signature'];
        const relay = req.headers['x-thalassa-relay'];
        if (
            typeof authorization !== 'string' ||
            !/^Bearer [^\s]{1,8192}$/.test(authorization) ||
            (batch && typeof signature !== 'string') ||
            (batch && (typeof relay !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(relay))) ||
            (signature !== undefined && (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)))
        ) {
            reply(401, { error: 'fleet-authentication-required' });
            return true;
        }
        if (
            req.headers['content-encoding'] ||
            req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json'
        ) {
            reply(415, { error: 'uncompressed-json-required' });
            return true;
        }
        const limit = batch ? LIMIT.batchBytes : 12 * 1024;
        const declared = req.headers['content-length'];
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
            reply(413, { error: 'fleet-body-too-large' });
            return true;
        }
        const controller = new AbortController(),
            timeout = setTimeout(() => controller.abort(), 8000);
        timeout.unref();
        const abort = () => controller.abort(),
            closed = () => {
                if (!res.writableEnded) abort();
            };
        req.once('aborted', abort);
        res.once('close', closed);
        active++;
        try {
            const body = await readBody(req, controller.signal, limit);
            if (body === null) {
                reply(controller.signal.aborted ? 408 : 413, { error: 'fleet-body-unavailable' });
                return true;
            }
            if (req.url === '/pi-fleet-consent/status/v1') {
                const raw = JSON.parse(body),
                    binding = parseFleetForwardBinding(raw?.binding);
                if (!raw || Object.keys(raw).length !== 2 || raw.schema !== 1 || !binding) {
                    reply(400, { error: 'invalid-pi-fleet-status' });
                    return true;
                }
                const owner = await deps.authenticateOwner(authorization, controller.signal);
                if (controller.signal.aborted || !owner || owner !== binding.ownerId) {
                    reply(401, { error: 'owner-required' });
                    return true;
                }
                const authority = await deps.store.relay(owner, binding.boatId, binding.relayId);
                if (!authority || controller.signal.aborted) {
                    reply(403, { error: 'owned-vessel-pi-required' });
                    return true;
                }
                const grant = await deps.store.currentGrant(owner, binding.boatId, binding.relayId);
                if (controller.signal.aborted) {
                    reply(499, { error: 'cancelled' });
                    return true;
                }
                reply(200, {
                    schema: 1,
                    grant: grant
                        ? {
                              binding: grant.binding,
                              revision: grant.revision,
                              enabled: grant.enabled,
                              expiresAt: grant.expiresAt,
                          }
                        : null,
                });
                return true;
            }
            const result = batch
                ? await processPiFleetBatch(
                      body,
                      typeof signature === 'string' ? signature : '',
                      relay as string,
                      authorization.slice(7),
                      {
                          store: deps.store,
                          operatorEnabled: deps.operatorEnabled,
                          signal: controller.signal,
                          enqueue: deps.enqueue,
                          scheduleForward: deps.scheduleForward,
                      },
                  )
                : await processPiFleetConsent(body, typeof signature === 'string' ? signature : null, {
                      store: deps.store,
                      operatorEnabled: deps.operatorEnabled,
                      signal: controller.signal,
                      authenticateOwner: async () => {
                          const owner = await deps.authenticateOwner(authorization, controller.signal);
                          return fleetUuid(owner) ? owner : null;
                      },
                  });
            reply(result.status, result.body);
            return true;
        } catch {
            reply(503, { error: 'fleet-service-unavailable' });
            return true;
        } finally {
            active--;
            clearTimeout(timeout);
            req.off('aborted', abort);
            res.off('close', closed);
        }
    };
}
