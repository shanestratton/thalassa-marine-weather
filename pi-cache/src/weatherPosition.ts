import { createHash } from 'node:crypto';
import { validSignalKSelf } from './signalkProtocol.js';
import {
    parseWeatherPositionRequest,
    weatherPositionFix,
    weatherPositionRelay,
    type WeatherPositionSource,
    type WeatherPositionRequest,
    type WeatherPositionProof,
    WEATHER_TELEMETRY_BYTES,
} from './weatherPositionWire.js';
const record = (v: unknown): Record<string, unknown> | null =>
    !!v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Direct selected position leaf only; parent/report/receipt clocks and phone supplements cannot qualify. */
export function readWeatherPositionSource(
    document: unknown,
    relayId: string,
    now: number,
): WeatherPositionSource | null {
    const doc = record(document),
        navigation = record(doc?.navigation),
        leaf = record(navigation?.position),
        value = record(leaf?.value);
    if (
        !weatherPositionRelay(relayId) ||
        !validSignalKSelf(doc?.uuid) ||
        typeof leaf?.$source !== 'string' ||
        !/^[A-Za-z\d:._/-]{1,120}$/.test(leaf.$source) ||
        typeof leaf.timestamp !== 'string'
    )
        return null;
    const fix = weatherPositionFix(
        { lat: value?.latitude, lon: value?.longitude, at: Date.parse(leaf.timestamp) },
        now,
    );
    if (!fix) return null;
    return {
        schema: 1,
        relayId,
        selfKey: hash([1, 'self', doc.uuid]),
        sourceKey: hash([1, 'navigation.position', doc.uuid, leaf.$source]),
        position: fix,
        servedAt: now,
    };
}
export function weatherPositionProof(
    document: unknown,
    relayId: string,
    request: WeatherPositionRequest | null,
    now: number,
): WeatherPositionProof | null {
    const valid = parseWeatherPositionRequest(request, now),
        source = readWeatherPositionSource(document, relayId, now);
    return valid && source && valid.selfKey === source.selfKey && valid.sourceKey === source.sourceKey
        ? {
              schema: 1,
              revision: valid.revision,
              selfKey: source.selfKey,
              sourceKey: source.sourceKey,
              ...source.position,
          }
        : null;
}
/** Never trim scalar telemetry or raise its existing hard envelope to fit optional consent proof. */
export function appendWeatherPosition(
    body: Record<string, unknown>,
    proof: WeatherPositionProof | null,
): string | null {
    const original = JSON.stringify(body);
    if (Buffer.byteLength(original, 'utf8') > WEATHER_TELEMETRY_BYTES) return null;
    if (!proof) return original;
    const candidate = JSON.stringify({ ...body, weather_position_v1: proof });
    return Buffer.byteLength(candidate, 'utf8') <= WEATHER_TELEMETRY_BYTES ? candidate : original;
}
/** A bounded optional response never changes the success of the legacy telemetry POST. */
export async function readWeatherPositionRequest(
    response: { body?: ReadableStream<Uint8Array> | null },
    now: number,
): Promise<WeatherPositionRequest | null> {
    if (!response.body?.getReader) return null;
    const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
            void reader.cancel().catch(() => undefined);
            reject(new Error('Position response timeout'));
        }, 2000);
    });
    let bytes = 0;
    try {
        for (;;) {
            const { value, done } = await Promise.race([reader.read(), expiry]);
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 2048) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
        const all = new Uint8Array(bytes);
        let at = 0;
        for (const part of chunks) {
            all.set(part, at);
            at += part.length;
        }
        const body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)));
        return parseWeatherPositionRequest(body?.weather_position_request, now);
    } catch {
        return null;
    } finally {
        if (timeout) clearTimeout(timeout);
        reader.releaseLock();
    }
}
