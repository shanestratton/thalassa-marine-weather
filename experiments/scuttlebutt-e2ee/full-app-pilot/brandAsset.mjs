/** Exactly one audited main-build asset. No publicDir copy or runtime authority. */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FULL_APP_BRAND_ASSET_FILE = 'thalassa-icon-128.png';
export const FULL_APP_BRAND_ASSET_SHA256 = '5beb04af8d53a700cddcfca1a4a0b9120ea22aa136e1cf03d79add6814b0aab1';
export const FULL_APP_BRAND_ASSET_BYTES = 9036;
const sourcePath = fileURLToPath(new URL('../../../public/' + FULL_APP_BRAND_ASSET_FILE, import.meta.url));
const refuse = () => {
    throw new Error('Pinned full App brand asset refused');
};

export function inspectFullAppBrandBytes(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length !== FULL_APP_BRAND_ASSET_BYTES) return refuse();
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (
        hash !== FULL_APP_BRAND_ASSET_SHA256 ||
        bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        bytes.readUInt32BE(16) !== 256 ||
        bytes.readUInt32BE(20) !== 256
    )
        return refuse();
    return Object.freeze({ sha256: hash, byteLength: bytes.length, width: 256, height: 256 });
}
export function readFullAppBrandAsset() {
    const metadata = lstatSync(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || realpathSync(sourcePath) !== sourcePath) return refuse();
    const bytes = readFileSync(sourcePath);
    return { path: sourcePath, bytes, ...inspectFullAppBrandBytes(bytes) };
}
export function createFullAppBrandAssetPlugin() {
    return {
        name: 'full-app-research-one-pinned-brand-asset',
        generateBundle() {
            const asset = readFullAppBrandAsset();
            this.emitFile({ type: 'asset', fileName: FULL_APP_BRAND_ASSET_FILE, source: asset.bytes });
        },
    };
}
