/**
 * thalassa-cache's side of the chart vault socket (127-C-d decision 1).
 *
 * thalassa-cache stays the front door (pinned TLS, device tokens, the boat-LAN
 * check, signing) and streams the vault's bytes straight through: it never
 * parses, hashes or holds a whole cell, so nothing CPU-bound about charts runs
 * in the watch's thread. The vault hands it the hash it already checked.
 *
 * This module imports no parser and no decoder (watchIsolation.test.mts).
 */
import http from 'node:http';
import type { Readable } from 'node:stream';
import { DEFAULT_VAULT_SOCKET, VAULT_LIMITS } from './vault/limits.js';
import {
    VAULT_SHA_HEADER,
    type VaultCellMeta,
    type VaultRefusalCode,
    type VaultRescanWire,
    type VaultStatusWire,
    type VaultLookaheadRequest,
    type VaultLookaheadResponse,
} from './vault/protocol.js';

/** A refusal from the vault, or the vault not answering at all (read as vault-starting: systemd restarts it). */
export class VaultUnavailableError extends Error {
    constructor(
        public readonly code: VaultRefusalCode,
        public readonly status: number,
        public readonly retryAfterSeconds?: number,
    ) {
        super(code);
        this.name = 'VaultUnavailableError';
    }
}

export interface VaultClient {
    lookahead?(request: VaultLookaheadRequest): Promise<VaultLookaheadResponse>;
    /** Null when the vault does not answer. */
    status(): Promise<VaultStatusWire | null>;
    index(): Promise<VaultCellMeta[]>;
    openCell(cellId: string): Promise<{ sha256: string; size: number; stream: Readable }>;
    rescan(cellIds?: string[]): Promise<VaultRescanWire>;
    remove(cellId: string): Promise<boolean>;
    /** False when the vault did not take it (restarting): the caller tells it again next time. */
    hint(h: { lat?: number; lon?: number; watching?: boolean }): Promise<boolean | void>;
}

interface Answer {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: http.IncomingMessage;
}

export function createVaultClient(socketPath = process.env.VAULT_SOCKET || DEFAULT_VAULT_SOCKET): VaultClient {
    const ask = (method: 'GET' | 'POST', route: string, body?: unknown, timeoutMs = 10_000): Promise<Answer> =>
        new Promise((resolve, reject) => {
            const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
            const req = http.request(
                {
                    socketPath,
                    method,
                    path: route,
                    headers: payload
                        ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
                        : undefined,
                },
                (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }),
            );
            req.setTimeout(timeoutMs, () => req.destroy(new Error('vault timeout')));
            req.on('error', () =>
                reject(new VaultUnavailableError('vault-starting', 503, VAULT_LIMITS.retryAfterSeconds)),
            );
            req.end(payload);
        });

    const json = async (answer: Answer): Promise<Record<string, unknown>> => {
        const chunks: Buffer[] = [];
        for await (const chunk of answer.body) chunks.push(chunk as Buffer);
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
            return {};
        }
    };

    const refusal = async (answer: Answer): Promise<VaultUnavailableError> => {
        const body = await json(answer);
        const code = typeof body.code === 'string' ? (body.code as VaultRefusalCode) : 'vault-starting';
        const retry = Number(answer.headers['retry-after']);
        return new VaultUnavailableError(code, answer.status, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    };

    return {
        async lookahead(request) {
            const answer = await ask('POST', '/v1/lookahead', request, 2500);
            if (answer.status !== 200) throw await refusal(answer);
            const body = await json(answer);
            if (
                !['charted', 'partial', 'unavailable'].includes(String(body.coverage)) ||
                typeof body.danger !== 'boolean'
            )
                return { coverage: 'unavailable', danger: false };
            return { coverage: body.coverage as VaultLookaheadResponse['coverage'], danger: body.danger };
        },
        async status() {
            try {
                const answer = await ask('GET', '/v1/status', undefined, 2_000);
                if (answer.status !== 200) return null;
                return (await json(answer)) as unknown as VaultStatusWire;
            } catch {
                return null;
            }
        },
        async index() {
            const answer = await ask('GET', '/v1/index');
            if (answer.status !== 200) throw await refusal(answer);
            const body = await json(answer);
            return Array.isArray(body.cells) ? (body.cells as VaultCellMeta[]) : [];
        },
        async openCell(cellId) {
            // A cold decode of the largest cell plus the queue ahead of it.
            const answer = await ask('GET', `/v1/cells/${encodeURIComponent(cellId)}`, undefined, 120_000);
            if (answer.status !== 200) throw await refusal(answer);
            const sha256 = answer.headers[VAULT_SHA_HEADER];
            const size = Number(answer.headers['content-length']);
            if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(size)) {
                answer.body.destroy();
                throw new VaultUnavailableError('vault-cell-unreadable', 502);
            }
            return { sha256, size, stream: answer.body };
        },
        async rescan(cellIds) {
            // A new set is ~930 cold decodes: minutes, not seconds.
            const answer = await ask('POST', '/v1/rescan', cellIds ? { cellIds } : {}, 30 * 60 * 1000);
            if (answer.status !== 200) throw await refusal(answer);
            return (await json(answer)) as unknown as VaultRescanWire;
        },
        async remove(cellId) {
            const answer = await ask('POST', '/v1/remove', { cellId });
            if (answer.status !== 200) throw await refusal(answer);
            return (await json(answer)).removed === true;
        },
        async hint(h) {
            try {
                const answer = await ask('POST', '/v1/hint', h, 2_000);
                answer.body.resume();
                return answer.status === 204;
            } catch {
                return false;
            }
        },
    };
}

/** The vault's last status, as thalassa-cache last heard it, and how long ago. */
export interface VaultStatusView {
    /** Null when the vault has not answered, or not within VAULT_LIMITS.statusStaleMs. */
    status: VaultStatusWire | null;
    /** Milliseconds since that answer; null when there has been none. */
    ageMs: number | null;
}

export interface VaultLink {
    /** Never waits on the vault: the answer of the last check (every statusEveryMs). */
    lastStatus(): VaultStatusView;
    stop(): void;
}

/**
 * thalassa-cache's standing link to the vault (decisions 7 and 11).
 *
 * - Its status is asked for every statusEveryMs, off the request path, so
 *   /api/admin/status (the app's Pi health probe) answers from memory. The
 *   vault decodes on one thread; a large cell blocks its loop for seconds,
 *   and the watch's own health probe must never wait on that.
 * - The watch state is sent on every check (watchCheckMs), not only when it
 *   changes: a vault that restarted knows nothing, and until told it counts a
 *   watch as on (no index pass, no prewarm). A status that says watching:null,
 *   or a watch state that differs from ours, is answered at once, with the fix.
 * - The boat's fix goes every hintEveryMs, for prewarm. The vault has no
 *   network of its own, so this is how it knows either.
 */
export function startVaultLink(options: {
    client: VaultClient;
    watching: () => boolean;
    fix: () => Promise<{ lat: number; lon: number } | null>;
    statusEveryMs?: number;
    checkMs?: number;
    everyMs?: number;
    staleMs?: number;
    now?: () => number;
}): VaultLink {
    const now = options.now ?? Date.now;
    const staleMs = options.staleMs ?? VAULT_LIMITS.statusStaleMs;
    let last: { status: VaultStatusWire; at: number } | null = null;
    let lastFixAt = 0;
    let hinting = false;
    let checking = false;
    let stopped = false;

    const hint = async (withFix: boolean) => {
        if (hinting || stopped) return;
        hinting = true;
        try {
            const watching = options.watching();
            const due = withFix || now() - lastFixAt >= (options.everyMs ?? VAULT_LIMITS.hintEveryMs);
            let fix: { lat: number; lon: number } | null = null;
            if (due) fix = await options.fix().catch(() => null);
            const taken = await options.client.hint({ watching, ...(fix ? { lat: fix.lat, lon: fix.lon } : {}) });
            // Not taken (the vault is restarting): the fix goes again with the next hint.
            if (due) lastFixAt = taken === false ? 0 : now();
        } finally {
            hinting = false;
        }
    };

    const check = async () => {
        if (checking || stopped) return;
        checking = true;
        try {
            const status = await options.client.status();
            if (!status) return;
            last = { status, at: now() };
            // A vault that has not heard (it restarted), or heard something else: tell it now.
            if (status.watching === null || status.watching !== options.watching())
                await hint(status.watching === null);
        } finally {
            checking = false;
        }
    };

    void check();
    void hint(true);
    const statusTimer = setInterval(() => void check(), options.statusEveryMs ?? VAULT_LIMITS.statusEveryMs);
    const hintTimer = setInterval(() => void hint(false), options.checkMs ?? VAULT_LIMITS.watchCheckMs);
    statusTimer.unref();
    hintTimer.unref();
    return {
        lastStatus() {
            if (!last) return { status: null, ageMs: null };
            const ageMs = Math.max(0, now() - last.at);
            return { status: ageMs > staleMs ? null : last.status, ageMs };
        },
        stop() {
            stopped = true;
            clearInterval(statusTimer);
            clearInterval(hintTimer);
        },
    };
}
