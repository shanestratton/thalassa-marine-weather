/** Cache-only public weather assets from the paired boat LAN. Never a WAN fallback. */
import { piCache } from './PiCacheService';
import { getPairing, pinnedPiRequest } from './PiPairingService';

export interface PiAnalysisAsset {
    schema: 1;
    id: string;
    dataUrl: string;
    fetchedAt: number;
    sourceUrl: string;
    attribution: string;
}
export interface PiSatelliteFrames {
    schema: 1;
    fetchedAt: number;
    frames: { iso: string; timeMs: number; dataUrl: string }[];
}
export interface PiMarineBulletin {
    id: string;
    title: string;
    text: string;
    issuedAt: string;
    fetchedAt: number;
    sourceUrl: string;
    attribution: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
async function localRead(path: string, maxBytes: number): Promise<Record<string, unknown> | null> {
    const base = piCache.lanBaseUrlNow();
    const pairing = getPairing();
    if (!base || !pairing) return null;
    try {
        const response = await pinnedPiRequest({
            url: base + '/api/offline-weather/' + path,
            readTimeout: 4000,
            responseType: 'text',
        });
        if (
            response.status !== 200 ||
            response.data.length > maxBytes ||
            piCache.lanBaseUrlNow() !== base ||
            getPairing()?.publicKeySpki !== pairing.publicKeySpki
        )
            return null;
        const value: unknown = JSON.parse(response.data);
        return object(value) && value.schema === 1 ? value : null;
    } catch {
        return null;
    }
}
export async function readPiAnalysis(id: string): Promise<PiAnalysisAsset | null> {
    if (!/^[a-z0-9-]{1,40}$/.test(id)) return null;
    const value = await localRead('analysis/' + id, 2_900_000);
    return value &&
        value.id === id &&
        typeof value.dataUrl === 'string' &&
        /^data:image\/(gif|png);base64,[A-Za-z0-9+/]+=*$/.test(value.dataUrl) &&
        typeof value.fetchedAt === 'number' &&
        Number.isFinite(value.fetchedAt) &&
        value.fetchedAt > 0 &&
        value.fetchedAt <= Date.now() + 60_000 &&
        typeof value.sourceUrl === 'string' &&
        typeof value.attribution === 'string'
        ? (value as unknown as PiAnalysisAsset)
        : null;
}
export async function readPiSatellite(): Promise<PiSatelliteFrames | null> {
    const value = await localRead('satellite', 8_500_000);
    if (
        !value ||
        typeof value.fetchedAt !== 'number' ||
        !Number.isFinite(value.fetchedAt) ||
        value.fetchedAt <= 0 ||
        value.fetchedAt > Date.now() + 60_000 ||
        !Array.isArray(value.frames) ||
        value.frames.length < 1 ||
        value.frames.length > 6
    )
        return null;
    for (const frame of value.frames) {
        if (
            !object(frame) ||
            typeof frame.iso !== 'string' ||
            !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?Z$/.test(frame.iso) ||
            typeof frame.timeMs !== 'number' ||
            Date.parse(frame.iso) !== frame.timeMs ||
            frame.timeMs > Date.now() + 600_000 ||
            typeof frame.dataUrl !== 'string' ||
            frame.dataUrl.length > 1_400_000 ||
            !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(frame.dataUrl)
        )
            return null;
    }
    return value as unknown as PiSatelliteFrames;
}
export async function readPiMarineBulletins(): Promise<{
    schema: 1;
    bulletins: PiMarineBulletin[];
    coverage: string;
} | null> {
    const value = await localRead('bulletins', 600_000);
    if (!value || !Array.isArray(value.bulletins) || value.bulletins.length > 12 || typeof value.coverage !== 'string')
        return null;
    for (const bulletin of value.bulletins) {
        if (
            !object(bulletin) ||
            typeof bulletin.id !== 'string' ||
            typeof bulletin.title !== 'string' ||
            typeof bulletin.text !== 'string' ||
            bulletin.text.length > 100_000 ||
            typeof bulletin.issuedAt !== 'string' ||
            !Number.isFinite(Date.parse(bulletin.issuedAt)) ||
            Date.parse(bulletin.issuedAt) > Date.now() + 600_000 ||
            typeof bulletin.fetchedAt !== 'number' ||
            !Number.isFinite(bulletin.fetchedAt) ||
            bulletin.fetchedAt <= 0 ||
            bulletin.fetchedAt > Date.now() + 60_000 ||
            typeof bulletin.sourceUrl !== 'string' ||
            typeof bulletin.attribution !== 'string'
        )
            return null;
    }
    return value as unknown as { schema: 1; bulletins: PiMarineBulletin[]; coverage: string };
}
