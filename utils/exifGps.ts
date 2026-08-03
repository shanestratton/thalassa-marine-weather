/**
 * exifGps — extract the GPS position (and capture time) a photo was
 * TAKEN at, from the original file's EXIF, before any processing.
 *
 * Why this exists (Shane, 2026-08-03): a photo taken mid-voyage showed
 * at the START of the 31-July track. Diary entries are pinned at the
 * position where the entry is COMPOSED (fresh device fix), and writing
 * up the day back at the berth pins the story at the marina — which is
 * where every track starts. The photo itself knows where it was taken;
 * this reads it.
 *
 * Must run on the ORIGINAL File from the picker: the upload pipeline
 * compresses through a canvas, which strips EXIF from the stored copy.
 *
 * Scope: JPEG APP1/TIFF EXIF only (the iOS picker delivers JPEG to
 * file inputs). Anything else — HEIC passthrough, screenshots, PNGs,
 * stripped files — returns null and the caller falls back to the
 * device fix. Parser is defensive: any malformed offset returns null
 * rather than throwing.
 */

export interface PhotoExif {
    lat: number;
    lon: number;
    /** EXIF DateTimeOriginal as epoch-ms in LOCAL time, or null. */
    takenAt: number | null;
}

/** How much of the file to read — APP1 must appear near the head. */
const HEAD_BYTES = 256 * 1024;

export async function extractPhotoExif(file: Blob): Promise<PhotoExif | null> {
    try {
        const buf = await file.slice(0, HEAD_BYTES).arrayBuffer();
        return parseExif(new DataView(buf));
    } catch {
        return null;
    }
}

/** Exported for tests — parse a JPEG head buffer directly. */
export function parseExif(view: DataView): PhotoExif | null {
    try {
        if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not JPEG

        // Walk JPEG segments looking for APP1 "Exif\0\0".
        let off = 2;
        let tiffStart = -1;
        while (off + 4 <= view.byteLength) {
            if (view.getUint8(off) !== 0xff) return null;
            const marker = view.getUint8(off + 1);
            if (marker === 0xda) return null; // start-of-scan — no EXIF found
            const size = view.getUint16(off + 2);
            if (marker === 0xe1 && off + 10 <= view.byteLength && view.getUint32(off + 4) === 0x45786966) {
                tiffStart = off + 10; // past "Exif\0\0"
                break;
            }
            off += 2 + size;
        }
        if (tiffStart < 0 || tiffStart + 8 > view.byteLength) return null;

        const byteOrder = view.getUint16(tiffStart);
        const little = byteOrder === 0x4949; // 'II'
        if (!little && byteOrder !== 0x4d4d) return null;
        const u16 = (o: number) => view.getUint16(o, little);
        const u32 = (o: number) => view.getUint32(o, little);
        if (u16(tiffStart + 2) !== 0x002a) return null;

        const ifd0 = tiffStart + u32(tiffStart + 4);

        // Scan an IFD for a set of tags → entry offsets.
        const scanIfd = (ifdOff: number, wanted: Set<number>): Map<number, number> => {
            const found = new Map<number, number>();
            if (ifdOff + 2 > view.byteLength) return found;
            const count = u16(ifdOff);
            for (let i = 0; i < count; i++) {
                const entry = ifdOff + 2 + i * 12;
                if (entry + 12 > view.byteLength) break;
                const tag = u16(entry);
                if (wanted.has(tag)) found.set(tag, entry);
            }
            return found;
        };

        const ifd0Tags = scanIfd(ifd0, new Set([0x8825, 0x8769])); // GPS IFD, Exif IFD
        const gpsEntry = ifd0Tags.get(0x8825);
        if (gpsEntry === undefined) return null;
        const gpsIfd = tiffStart + u32(gpsEntry + 8);

        const gpsTags = scanIfd(gpsIfd, new Set([0x0001, 0x0002, 0x0003, 0x0004]));
        const latRefE = gpsTags.get(0x0001);
        const latE = gpsTags.get(0x0002);
        const lonRefE = gpsTags.get(0x0003);
        const lonE = gpsTags.get(0x0004);
        if (latRefE === undefined || latE === undefined || lonRefE === undefined || lonE === undefined) return null;

        // ASCII ref chars are stored inline in the value slot.
        const refChar = (entryOff: number) => String.fromCharCode(view.getUint8(entryOff + 8));

        // Deg/min/sec as three unsigned rationals at the pointed-to offset.
        const dms = (entryOff: number): number | null => {
            const valOff = tiffStart + u32(entryOff + 8);
            if (valOff + 24 > view.byteLength) return null;
            const rat = (o: number): number | null => {
                const num = u32(o);
                const den = u32(o + 4);
                return den === 0 ? (num === 0 ? 0 : null) : num / den;
            };
            const d = rat(valOff);
            const m = rat(valOff + 8);
            const s = rat(valOff + 16);
            if (d === null || m === null || s === null) return null;
            return d + m / 60 + s / 3600;
        };

        const latAbs = dms(latE);
        const lonAbs = dms(lonE);
        if (latAbs === null || lonAbs === null) return null;
        const lat = refChar(latRefE) === 'S' ? -latAbs : latAbs;
        const lon = refChar(lonRefE) === 'W' ? -lonAbs : lonAbs;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
        // (0,0) is the classic stripped-GPS sentinel — treat as absent.
        if (lat === 0 && lon === 0) return null;

        // DateTimeOriginal (0x9003) lives in the Exif sub-IFD; best-effort.
        let takenAt: number | null = null;
        const exifEntry = ifd0Tags.get(0x8769);
        if (exifEntry !== undefined) {
            const exifIfd = tiffStart + u32(exifEntry + 8);
            const dtoEntry = scanIfd(exifIfd, new Set([0x9003])).get(0x9003);
            if (dtoEntry !== undefined) {
                const strOff = tiffStart + u32(dtoEntry + 8);
                if (strOff + 19 <= view.byteLength) {
                    let s = '';
                    for (let i = 0; i < 19; i++) s += String.fromCharCode(view.getUint8(strOff + i));
                    // "YYYY:MM:DD HH:MM:SS" — EXIF has no timezone; parse as local.
                    const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
                    if (m) {
                        const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
                        if (Number.isFinite(t)) takenAt = t;
                    }
                }
            }
        }

        return { lat, lon, takenAt };
    } catch {
        return null;
    }
}
