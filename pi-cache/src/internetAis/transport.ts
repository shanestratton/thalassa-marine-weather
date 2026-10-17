import { createServer, type Socket } from 'node:net';
import { outboundFetch, normaliseExactHttpOrigin } from '../outboundHttp.js';
import { INTERNET_AIS, type InternetAisRequest } from '../internetAisWire.js';
import type { InternetAisAuthority } from './publisher.js';
import type { RequestInit, Response } from 'undici';

export function internetAisEndpoint(origin: string): string {
    const normalized = normaliseExactHttpOrigin(origin);
    if (!normalized.startsWith('https://')) throw Error('Internet AIS requires the configured HTTPS trust anchor');
    return new URL('/functions/v1/pi-internet-ais', normalized).href;
}
export function internetAisFetcher(
    endpoint: string,
    fetchImpl: (url: string, init: RequestInit) => Promise<Response> = outboundFetch,
) {
    const url = new URL(endpoint);
    if (internetAisEndpoint(url.origin) !== endpoint) throw Error('Invalid AIS endpoint');
    return async (
        request: InternetAisRequest,
        authority: InternetAisAuthority,
        signal: AbortSignal,
    ): Promise<unknown> => {
        const response = await fetchImpl(endpoint, {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                apikey: authority.anonKey,
                Authorization: `Bearer ${authority.anonKey}`,
                'X-Thalassa-Pi-Relay-Id': authority.relayId,
                'X-Thalassa-Pi-Relay-Token': authority.token,
            },
            body: JSON.stringify(request),
        });
        if (
            !response.ok ||
            !response.body ||
            Number(response.headers.get('content-length') || '0') > INTERNET_AIS.bytes
        ) {
            void response.body?.cancel().catch(() => undefined);
            throw Error('AIS reader unavailable');
        }
        const reader = response.body.getReader();
        let rejectAbort: (() => void) | undefined;
        const abort = new Promise<never>((_, reject) => {
            rejectAbort = () => reject(Error('AIS read retired'));
            signal.addEventListener('abort', rejectAbort, { once: true });
            if (signal.aborted) rejectAbort();
        });
        const chunks: Uint8Array[] = [];
        let bytes = 0,
            count = 0;
        try {
            for (;;) {
                const { value, done } = await Promise.race([reader.read(), abort]);
                if (done) break;
                if (!value.byteLength || ++count > 512 || (bytes += value.byteLength) > INTERNET_AIS.bytes)
                    throw Error('AIS response bound');
                chunks.push(value.slice());
            }
            if (signal.aborted) throw Error('AIS read retired');
            const all = new Uint8Array(bytes);
            let at = 0;
            for (const chunk of chunks) {
                all.set(chunk, at);
                at += chunk.byteLength;
            }
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
        } finally {
            if (rejectAbort) signal.removeEventListener('abort', rejectAbort);
            void reader.cancel().catch(() => undefined);
        }
    };
}
/** Read-only local Signal K JSON transport. No NMEA0183/2000 encoder or gateway connection. */
export function createInternetAisTcp(options: { beforeClient(): boolean }) {
    const clients = new Set<Socket>();
    const server = createServer((socket) => {
        if (
            !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket.remoteAddress ?? '') ||
            clients.size >= 2 ||
            !options.beforeClient()
        ) {
            socket.destroy();
            return;
        }
        clients.add(socket);
        socket.setNoDelay(true);
        socket.setTimeout(125_000, () => socket.destroy());
        socket.on('data', () => socket.destroy());
        socket.on('error', () => socket.destroy());
        socket.on('close', () => clients.delete(socket));
    });
    server.maxConnections = 3;
    const retire = () => {
        for (const client of clients) client.destroy();
        clients.clear();
    };
    return {
        server,
        clients: () => clients.size,
        emit(line: string, current: () => boolean) {
            if (Buffer.byteLength(line) > 1024 || !current()) return;
            for (const client of clients) {
                if (!current() || client.destroyed || client.writableLength > 65536 || !client.write(line))
                    client.destroy();
            }
        },
        retire,
        close() {
            retire();
            server.close();
        },
    };
}
