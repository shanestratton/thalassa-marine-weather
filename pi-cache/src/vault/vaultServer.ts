/**
 * The vault's only door (127-C-d decision 1): HTTP on a unix socket,
 * /run/thalassa-chart-vault/vault.sock, mode 0600, for thalassa-cache (the
 * same user). The vault opens no network socket at all; its unit runs it with
 * PrivateNetwork and AF_UNIX only. Routes: protocol.ts.
 */
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { VaultRefusal } from './chartVault.js';
import { VAULT_SHA_HEADER } from './protocol.js';
import type { VaultService } from './vaultService.js';
import { validLookaheadRequest } from './lookahead.js';

const MAX_BODY = 4096;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(text)),
        'Cache-Control': 'no-store',
        ...headers,
    });
    res.end(text);
}

function refuse(res: ServerResponse, error: unknown): void {
    if (error instanceof VaultRefusal) {
        send(
            res,
            error.status,
            { code: error.code, error: error.message },
            error.retryAfterSeconds ? { 'Retry-After': String(error.retryAfterSeconds) } : {},
        );
        return;
    }
    // Never the error's text: it could name a path.
    send(res, 500, { code: 'vault-error', error: 'The chart vault failed to answer.' });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) throw new VaultRefusal('vault-busy', 413, 'Request too large');
        chunks.push(chunk as Buffer);
    }
    if (size === 0) return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export function createVaultHttpServer(service: VaultService): http.Server {
    return http.createServer((req, res) => {
        void (async () => {
            const url = new URL(req.url ?? '/', 'http://vault');
            const route = `${req.method} ${url.pathname}`;
            try {
                if (route === 'GET /v1/status') return send(res, 200, service.status());
                if (route === 'GET /v1/index') return send(res, 200, { cells: service.index() });
                if (route === 'POST /v1/lookahead') {
                    const body = await readJson(req);
                    if (!validLookaheadRequest(body)) return send(res, 400, { code: 'bad-request' });
                    return send(res, 200, await service.lookahead(body));
                }
                const cell = /^GET \/v1\/cells\/([A-Za-z0-9_-]{1,128})$/.exec(route);
                if (cell) {
                    const { bytes, sha256 } = await service.cell(cell[1]);
                    res.writeHead(200, {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Content-Length': String(bytes.length),
                        'Cache-Control': 'no-store',
                        [VAULT_SHA_HEADER]: sha256,
                    });
                    res.end(bytes);
                    return;
                }
                if (route === 'POST /v1/rescan') {
                    const body = await readJson(req);
                    const ids = Array.isArray(body.cellIds)
                        ? body.cellIds.filter((id): id is string => typeof id === 'string').slice(0, 10_000)
                        : undefined;
                    return send(res, 200, await service.rescan(ids));
                }
                if (route === 'POST /v1/remove') {
                    const body = await readJson(req);
                    if (typeof body.cellId !== 'string') return send(res, 400, { code: 'bad-request' });
                    return send(res, 200, { removed: await service.remove(body.cellId) });
                }
                if (route === 'POST /v1/hint') {
                    service.hint(await readJson(req));
                    res.writeHead(204, { 'Cache-Control': 'no-store' });
                    res.end();
                    return;
                }
                return send(res, 404, { code: 'no-such-route' });
            } catch (error) {
                if (!res.headersSent) refuse(res, error);
                else res.destroy();
            }
        })();
    });
}

/** Listen on the socket, 0600; a stale socket from a crashed run is replaced, anything else is not. */
export async function listenOnSocket(server: http.Server, socketPath: string): Promise<void> {
    try {
        const stat = await fs.lstat(socketPath);
        if (!stat.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
        await fs.unlink(socketPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
            server.off('error', reject);
            resolve();
        });
    });
    await fs.chmod(socketPath, 0o600);
}
