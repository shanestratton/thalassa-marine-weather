/** Prepared private gateway. No import/download/install/timer/public ingress.
 * Node24 strips the same pure TS operation contract consumed by app and Edge.
 */
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { readFile, lstat } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    OWN_OSM_MAX_BYTES,
    OWN_OSM_MAX_ELEMENTS,
    OWN_OSM_MAX_SOURCE_AGE_MS,
    parseOwnedOsmRequest,
    parseOwnedOsmDocument,
    queryForOwnedOsm,
} from '../../services/osm/ownedOverpassContract.ts';

export const LOCAL_INTERPRETER = 'http://127.0.0.1:8080/api/interpreter';
export const READY_FILE = '/srv/thalassa-overpass/admitted.json';
export const GATEWAY_DEADLINE_MS = 20_000;
export const LOCAL_QUERY_MEMORY_BYTES = 134_217_728;
export function compileLocalQuery(operation) {
    // These are server-owned limits, never caller QL settings. The installed
    // dispatcher must additionally have one slot and a separately proved cap.
    return queryForOwnedOsm(operation, true)
        .replace('[out:json]', `[out:json][maxsize:${LOCAL_QUERY_MEMORY_BYTES}]`)
        .replace(/\[timeout:\d+\]/, '[timeout:20]');
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const result = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

export function parseAdmission(raw, now = Date.now()) {
    if (!Buffer.isBuffer(raw) || raw.length > 8192) throw Error('Admission size');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    const clock = Date.parse(value.sourceAt);
    if (
        value.schema !== 1 ||
        value.complete !== true ||
        value.coverage !== 'planet' ||
        value.licence !== 'ODbL-1.0' ||
        !Number.isFinite(clock) ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value.sourceAt) ||
        new Date(clock).toISOString().replace('.000Z', 'Z') !== value.sourceAt ||
        clock > now + 300_000 ||
        now - clock > OWN_OSM_MAX_SOURCE_AGE_MS ||
        !/^https:\/\/planet\.openstreetmap\.org\/pbf\/planet-\d{6}\.osm\.pbf$/.test(value.sourceUrl) ||
        !Number.isSafeInteger(value.sourceBytes) ||
        value.sourceBytes < 1_000_000_000 ||
        !['sourceSha256', 'cohortSha256', 'nativeImportProofSha256'].every((k) => /^[a-f0-9]{64}$/.test(value[k]))
    )
        throw Error('Full original planet admission unavailable');
    return { sourceAt: value.sourceAt, cohortSha256: value.cohortSha256, rawSha256: hash(raw) };
}

async function diskAdmission() {
    const facts = await lstat(READY_FILE);
    if (!facts.isFile() || facts.isSymbolicLink() || facts.size > 8192 || (facts.mode & 0o022) !== 0)
        throw Error('Admission is missing, mutable or non-regular');
    return parseAdmission(await readFile(READY_FILE));
}

function authorised(header, token) {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token ?? '')) return false;
    if (typeof header !== 'string' || header.length !== token.length + 7) return false;
    const candidate = Buffer.from(header ?? ''),
        expected = Buffer.from('Bearer ' + token);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function limited(response, maximum) {
    if (Number(response.headers.get('content-length')) > maximum || !response.body) throw Error('Body size');
    const reader = response.body.getReader(),
        chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maximum) throw Error('Body size');
            chunks.push(value);
        }
        return Buffer.concat(chunks, total);
    } finally {
        void reader.cancel().catch(() => {});
    }
}

export function createHandler({
    token,
    fetcher = fetch,
    admission = diskAdmission,
    now = Date.now,
    deadlineMs = GATEWAY_DEADLINE_MS,
} = {}) {
    let active = false;
    return async (request) => {
        if (!authorised(request.headers.get('authorization'), token)) return result({ code: 'UNAUTHORISED' }, 401);
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/osm/query' || new URL(request.url).search)
            return result({ code: 'OPERATION_REFUSED' }, 400);
        if (active) return result({ code: 'BUSY' }, 429);
        active = true;
        const controller = new AbortController();
        const cancel = () => controller.abort();
        request.signal.addEventListener('abort', cancel, { once: true });
        let timer, response, work;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(Error('Gateway deadline'));
            }, deadlineMs);
        });
        try {
            work = (async () => {
                if (request.signal.aborted) throw Error('Cancelled');
                const body = await limited(request, 4096);
                const operation = parseOwnedOsmRequest(
                    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)),
                );
                if (!operation) return result({ code: 'OPERATION_REFUSED' }, 400);
                const before = await admission();
                if (controller.signal.aborted) throw Error('Cancelled');
                response = await fetcher(LOCAL_INTERPRETER, {
                    method: 'POST',
                    redirect: 'error',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                    body: 'data=' + encodeURIComponent(compileLocalQuery(operation)),
                    signal: controller.signal,
                });
                if (!response.ok || controller.signal.aborted) throw Error('Local interpreter unavailable');
                const raw = await limited(response, OWN_OSM_MAX_BYTES);
                if (controller.signal.aborted) throw Error('Cancelled');
                const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
                if (
                    !Array.isArray(decoded?.elements) ||
                    decoded.elements.length > OWN_OSM_MAX_ELEMENTS ||
                    decoded.osm3s?.timestamp_osm_base !== before.sourceAt ||
                    decoded.remark
                )
                    throw Error('Original query incomplete or from another database clock');
                const after = await admission();
                if (before.rawSha256 !== after.rawSha256 || controller.signal.aborted)
                    throw Error('Database cohort retired during query');
                const output = parseOwnedOsmDocument(
                    {
                        ...decoded,
                        thalassaSource: {
                            schema: 1,
                            complete: true,
                            licence: 'ODbL-1.0',
                            cohortSha256: before.cohortSha256,
                            sourceAt: before.sourceAt,
                        },
                    },
                    operation,
                    now(),
                );
                // Do not echo generator/server diagnostics or arbitrary extra upstream fields.
                return result(output);
            })();
            // If a transport ignores AbortSignal, keep the single lease busy
            // until that original work really retires; no orphan amplification.
            void work.then(
                () => {
                    active = false;
                },
                () => {
                    active = false;
                },
            );
            return await Promise.race([work, deadline]);
        } catch {
            return result({ code: 'OWN_OSM_UNAVAILABLE' }, 503);
        } finally {
            clearTimeout(timer);
            controller.abort();
            if (!work) active = false;
            request.signal.removeEventListener('abort', cancel);
            if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
        }
    };
}

export function servePreparedGateway() {
    const token = process.env.THALASSA_WX_OSM_TOKEN;
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token ?? '')) throw Error('Separate private OSM credential required');
    const handler = createHandler({ token });
    const server = createServer((req, res) => {
        // TLS ingress is a separately reviewed prerequisite; this unit binds loopback only.
        if (!authorised(req.headers.authorization, token)) {
            res.writeHead(401);
            res.end();
            return;
        }
        if (req.method !== 'POST' || req.url !== '/osm/query') {
            res.writeHead(400);
            res.end();
            return;
        }
        let total = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > 4096) {
                res.writeHead(413);
                res.end();
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on('error', () => {
            if (!res.destroyed) res.destroy();
        });
        req.on('end', async () => {
            if (total > 4096 || res.destroyed) return;
            const controller = new AbortController();
            res.on('close', () => controller.abort());
            const request = new Request('http://127.0.0.1:8092' + req.url, {
                method: req.method,
                headers: { authorization: req.headers.authorization },
                ...(req.method === 'POST' ? { body: Buffer.concat(chunks, total) } : {}),
                signal: controller.signal,
            });
            try {
                const reply = await handler(request);
                res.writeHead(reply.status, Object.fromEntries(reply.headers));
                res.end(Buffer.from(await reply.arrayBuffer()));
            } catch {
                if (!res.headersSent) res.writeHead(503);
                res.end();
            }
        });
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.maxConnections = 8;
    server.listen(8092, '127.0.0.1');
    return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) servePreparedGateway();
