import { utf8ByteLength } from '../enc/types';
import { signalkRecord, type SignalKNotice } from '../../pi-cache/src/signalkProtocol';
import type { SignalKNotificationSnapshot } from '../../pi-cache/src/signalKReadSession';

const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const exact = (row: Record<string, unknown>, keys: string[]) => Object.keys(row).every((key) => keys.includes(key));
const failure = () => new Error('Pi Signal K notification response unavailable');

/** Validate before allocating display state; no legacy/body coercion and no receipt-time restamping. */
export function parsePiSignalKNotifications(text: string, now = Date.now()): SignalKNotificationSnapshot {
    if (typeof text !== 'string' || text.length > 16_384 || utf8ByteLength(text, 16_384) > 16_384) throw failure();
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        throw failure();
    }
    const row = signalkRecord(data);
    if (
        !row ||
        !exact(row, ['schema', 'session', 'startedAt', 'state', 'servedAt', 'notices', 'truncated']) ||
        row.schema !== 1 ||
        !['stopped', 'connecting', 'reading', 'unavailable'].includes(String(row.state)) ||
        !integer(row.servedAt) ||
        row.servedAt > now + 5000 ||
        now - row.servedAt > 15_000 ||
        typeof row.truncated !== 'boolean' ||
        !Array.isArray(row.notices) ||
        row.notices.length > 64
    )
        throw failure();
    const hasSession =
        typeof row.session === 'string' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.session) &&
        integer(row.startedAt) &&
        row.startedAt <= row.servedAt;
    if (
        ['reading', 'connecting'].includes(String(row.state))
            ? !hasSession
            : row.session !== null || row.startedAt !== null
    )
        throw failure();
    if (row.state !== 'reading' && row.notices.length) throw failure();
    const servedAt = row.servedAt;
    const seen = new Set<string>();
    const notices: SignalKNotice[] = row.notices.map((item: unknown) => {
        const n = signalkRecord(item);
        if (
            !n ||
            !exact(n, ['path', 'source', 'at', 'receivedAt', 'message', 'state', 'soundRequested']) ||
            typeof n.path !== 'string' ||
            n.path.length > 160 ||
            !/^notifications\.[A-Za-z0-9_-]{1,40}(?:\.[A-Za-z0-9_-]{1,40}){0,3}$/.test(n.path) ||
            n.path.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)) ||
            typeof n.source !== 'string' ||
            !/^[A-Za-z0-9:._/-]{1,120}$/.test(n.source) ||
            !integer(n.at) ||
            !integer(n.receivedAt) ||
            n.at > n.receivedAt + 1000 ||
            n.receivedAt > servedAt + 1000 ||
            n.at > servedAt + 1000 ||
            servedAt - n.at > 72 * 3600_000 ||
            typeof n.message !== 'string' ||
            n.message.length > 160 ||
            /\p{Cc}/u.test(n.message) ||
            !['normal', 'alert', 'warn', 'alarm', 'emergency'].includes(String(n.state)) ||
            typeof n.soundRequested !== 'boolean'
        )
            throw failure();
        const key = `${n.source}|${n.path}`;
        if (seen.has(key)) throw failure();
        seen.add(key);
        return {
            path: n.path,
            source: n.source,
            at: n.at,
            receivedAt: n.receivedAt,
            message: n.message,
            state: n.state as SignalKNotice['state'],
            soundRequested: n.soundRequested,
        };
    });
    return {
        schema: 1,
        session: hasSession ? (row.session as string) : null,
        startedAt: hasSession ? (row.startedAt as number) : null,
        state: row.state as SignalKNotificationSnapshot['state'],
        servedAt: row.servedAt,
        notices,
        truncated: row.truncated,
    };
}
