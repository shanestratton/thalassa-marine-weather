/**
 * GribWindParser — Converts downloaded GRIB wind data to WindGrid format.
 *
 * Binary .wind.bin format:
 *   Header (28 bytes):
 *     - float32: south latitude
 *     - float32: north latitude
 *     - float32: west longitude
 *     - float32: east longitude
 *     - uint32:  width (columns)
 *     - uint32:  height (rows)
 *     - uint32:  totalHours
 *
 *   Data (width × height × totalHours × 3 × 4 bytes):
 *     For each hour, 3 interleaved Float32Arrays:
 *       - U component  (width × height floats)
 *       - V component  (width × height floats)
 *       - Speed scalar (width × height floats)
 *
 * Lat grid stored bottom-up (row 0 = south) for GL texture compatibility.
 */

import type { WindGrid } from './windField';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

const HEADER_BYTES = 28; // 4 floats + 3 uint32s

/**
 * Parse a .wind.bin binary buffer into a WindGrid.
 */
export function parseWindBin(buffer: ArrayBuffer): WindGrid {
    const header = new DataView(buffer, 0, HEADER_BYTES);

    const south = header.getFloat32(0, true);
    const north = header.getFloat32(4, true);
    const west = header.getFloat32(8, true);
    const east = header.getFloat32(12, true);
    const width = header.getUint32(16, true);
    const height = header.getUint32(20, true);
    const totalHours = header.getUint32(24, true);

    const cellsPerHour = width * height;
    const floatsPerHour = cellsPerHour * 3; // U, V, speed

    const data = new Float32Array(buffer, HEADER_BYTES);

    const u: Float32Array[] = [];
    const v: Float32Array[] = [];
    const speed: Float32Array[] = [];

    for (let h = 0; h < totalHours; h++) {
        const offset = h * floatsPerHour;
        u.push(data.subarray(offset, offset + cellsPerHour));
        v.push(data.subarray(offset + cellsPerHour, offset + cellsPerHour * 2));
        speed.push(data.subarray(offset + cellsPerHour * 2, offset + cellsPerHour * 3));
    }

    // Generate lat/lon arrays
    const latStep = (north - south) / (height - 1);
    const lonStep = (east - west) / (width - 1);
    const lats: number[] = [];
    const lons: number[] = [];
    for (let r = 0; r < height; r++) lats.push(south + r * latStep);
    for (let c = 0; c < width; c++) lons.push(west + c * lonStep);

    return {
        u, v, speed,
        width, height,
        lats, lons,
        north, south, west, east,
        totalHours,
    };
}

/**
 * Serialize a WindGrid to .wind.bin binary format.
 * Used after downloading GRIB data to cache it locally.
 */
export function encodeWindBin(grid: WindGrid): ArrayBuffer {
    const cellsPerHour = grid.width * grid.height;
    const floatsPerHour = cellsPerHour * 3;
    const dataBytes = floatsPerHour * grid.totalHours * 4;
    const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);

    // Write header
    const header = new DataView(buffer, 0, HEADER_BYTES);
    header.setFloat32(0, grid.south, true);
    header.setFloat32(4, grid.north, true);
    header.setFloat32(8, grid.west, true);
    header.setFloat32(12, grid.east, true);
    header.setUint32(16, grid.width, true);
    header.setUint32(20, grid.height, true);
    header.setUint32(24, grid.totalHours, true);

    // Write data: U, V, speed interleaved per hour
    const data = new Float32Array(buffer, HEADER_BYTES);
    for (let h = 0; h < grid.totalHours; h++) {
        const offset = h * floatsPerHour;
        data.set(grid.u[h], offset);
        data.set(grid.v[h], offset + cellsPerHour);
        data.set(grid.speed[h], offset + cellsPerHour * 2);
    }

    return buffer;
}

/**
 * Load a .wind.bin file from the Capacitor filesystem.
 */
export async function loadLocalWindFile(filename: string): Promise<WindGrid> {
    try {
        const result = await Filesystem.readFile({
            path: filename,
            directory: Directory.Documents,
            encoding: undefined as unknown as Encoding, // binary read
        });

        // Capacitor returns base64 for binary files
        const base64 = result.data as string;
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        return parseWindBin(bytes.buffer);
    } catch (e) {
        console.error('[GribWindParser] Failed to load local wind file:', e);
        throw new Error(`Failed to load wind file: ${filename}`);
    }
}

/**
 * Save a WindGrid as a .wind.bin file to the Capacitor filesystem.
 */
export async function saveLocalWindFile(grid: WindGrid, filename = 'passage_wind.wind.bin'): Promise<string> {
    const buffer = encodeWindBin(grid);
    const bytes = new Uint8Array(buffer);

    // Convert to base64 for Capacitor
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    const result = await Filesystem.writeFile({
        path: filename,
        data: base64,
        directory: Directory.Documents,
    });

    console.log(`[GribWindParser] Saved wind file: ${result.uri} (${buffer.byteLength} bytes)`);
    return filename;
}
