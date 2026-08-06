/**
 * piTls — the ONE way the app talks to the boat's Pi.
 *
 * The Pi serves TLS with a certificate issued from its own pairing identity
 * key (pi-cache/src/tlsIdentity.ts), so the channel is validated by comparing
 * the leaf's SubjectPublicKeyInfo to the key pinned at pairing — not by asking
 * a CA, which could never answer for a box on a boat with no DNS and no
 * internet. The comparison happens natively, in
 * ios/App/App/PiTlsPlugin.swift, because iOS rejects the certificate in both
 * WKWebView `fetch` and CapacitorHttp before any JavaScript runs.
 *
 * This module is deliberately the only door. CapacitorHttp must not be called
 * against a Pi URL anywhere else: it would either fail the handshake (native)
 * or, worse, succeed against something that is not the skipper's Pi.
 *
 * Layering, so it is clear what this does and does not add:
 *   · TLS here          → confidentiality (new — this is what was missing)
 *   · pairing challenge → authentication  (PiPairingService, unchanged)
 *   · X-Pi-Signature    → integrity       (PiPairingService, unchanged)
 * The pin and the challenge check the same key, so TLS termination is now
 * proof of the same thing the challenge proves. They are not redundant: the
 * challenge is per-connection and the signatures are per-payload, which still
 * matters for anything cached, relayed, or replayed.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';

const log = createLogger('PiTls');

export interface PiTlsResponse {
    status: number;
    headers: Record<string, string>;
    /** Text, or base64 when responseType is 'arraybuffer'. */
    data: string;
    /** Base64 SPKI DER of the key that terminated the TLS session. */
    peerSpki: string;
}

interface PiTlsPlugin {
    request(options: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        data?: string;
        pinnedSpki?: string;
        connectTimeout?: number;
        readTimeout?: number;
        responseType?: 'text' | 'arraybuffer';
    }): Promise<PiTlsResponse>;
}

const PiTls = registerPlugin<PiTlsPlugin>('PiTls');

export interface PiRequestOptions {
    url: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    data?: unknown;
    /** Base64 SPKI DER from the pairing record. Omit ONLY for /api/pair/info. */
    pinnedSpki?: string;
    connectTimeout?: number;
    readTimeout?: number;
    responseType?: 'text' | 'arraybuffer';
}

/**
 * True when the pinning transport is actually present. Everything that could
 * reach the Pi is gated on this: without it there is no way to verify the
 * certificate, and the correct behaviour is to have no Pi rather than an
 * unverified one.
 */
export function isPinnedTransportAvailable(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('PiTls');
}

/**
 * Browser lane. `fetch` here reaches a Pi only when the developer has told the
 * browser to trust the certificate (or is being served BY the Pi, where it is
 * same-origin and already trusted). There is no pinning: browsers do not
 * expose the peer certificate to script, so this cannot verify anything and
 * must never be the lane a shipped build takes — see piPublicBetaBoundary.ts,
 * which only opens the Pi in production when the native plugin is present.
 */
async function browserRequest(options: PiRequestOptions): Promise<PiTlsResponse> {
    const { url, method = 'GET', headers = {}, data, readTimeout = 30000, responseType = 'text' } = options;
    const res = await fetch(url, {
        method,
        headers: data ? { 'Content-Type': 'application/json', ...headers } : headers,
        body: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data),
        signal: AbortSignal.timeout(readTimeout),
    });

    const collected: Record<string, string> = {};
    res.headers.forEach((value, key) => {
        collected[key] = value;
    });

    let body: string;
    if (responseType === 'arraybuffer') {
        const bytes = new Uint8Array(await res.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
        body = btoa(binary);
    } else {
        body = await res.text();
    }

    // No peer key is observable from script — callers that need the binding
    // (pairing) must be on the native lane, and enforce that themselves.
    return { status: res.status, headers: collected, data: body, peerSpki: '' };
}

/**
 * Perform one request to the Pi over the pinned channel.
 *
 * Throws rather than returning a status when the pin fails: a certificate
 * mismatch is not a bad response from the Pi, it is something that is not the
 * Pi, and no caller should get the chance to read a body off it.
 */
export async function piRequest(options: PiRequestOptions): Promise<PiTlsResponse> {
    if (!options.url.startsWith('https://')) {
        throw new Error(`Refusing a non-HTTPS Pi URL: ${options.url}`);
    }

    if (!isPinnedTransportAvailable()) return browserRequest(options);

    const { data, ...rest } = options;
    return PiTls.request({
        ...rest,
        method: options.method ?? 'GET',
        data: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data),
    });
}

/**
 * The pairing fetch — the single unpinned request the app ever makes, and only
 * ever for the pairing card. The native side independently refuses any other
 * path without a pin, so this convenience cannot be pointed somewhere else.
 *
 * Returns the body together with the key that terminated the session. The
 * caller MUST check that key against both the advertised publicKeySpki and a
 * signed challenge before storing anything — see pairWithPi.
 */
export async function piPairingFetch(baseUrl: string): Promise<PiTlsResponse> {
    const url = `${baseUrl}/api/pair/info`;
    if (!isPinnedTransportAvailable()) {
        log.warn('pairing over a browser lane — the TLS channel cannot be bound to the pairing key here');
    }
    return piRequest({ url, connectTimeout: 4000, readTimeout: 4000, responseType: 'text' });
}
