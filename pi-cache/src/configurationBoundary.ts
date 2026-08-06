import { randomUUID } from 'node:crypto';
import {
    chmodSync,
    closeSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const INVALID_PI_CONFIGURATION_CODE = 'INVALID_PI_CONFIGURATION';
export const MAX_SUPABASE_URL_LENGTH = 2_048;
export const MAX_SUPABASE_ANON_KEY_LENGTH = 8_192;
export const MIN_PREFETCH_RADIUS_DEG = 0.1;
export const MAX_PREFETCH_RADIUS_DEG = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PiConfigurationValidationError extends Error {
    readonly code = INVALID_PI_CONFIGURATION_CODE;

    constructor(message: string) {
        super(message);
        this.name = 'PiConfigurationValidationError';
    }
}

export interface ValidatedPiConfigurationFields {
    supabaseUrl?: string;
    supabaseAnonKey?: string;
    prefetchLat?: number;
    prefetchLon?: number;
    prefetchRadius?: number;
    userId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 32 || code === 127 || code === 0x2028 || code === 0x2029) return true;
    }
    return false;
}

function optionalSingleLineString(
    body: Record<string, unknown>,
    field: 'supabaseUrl' | 'supabaseAnonKey',
    maxLength: number,
): string | undefined {
    const value = body[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > maxLength || hasControlCharacter(value)) {
        throw new PiConfigurationValidationError(`${field} must be a bounded single-line string`);
    }
    return value;
}

/** Validate every request field that can reach process state or the .env file. */
export function validatePiConfigurationFields(value: unknown): ValidatedPiConfigurationFields {
    if (!isRecord(value)) throw new PiConfigurationValidationError('Configuration body must be an object');

    const validated: ValidatedPiConfigurationFields = {};
    const supabaseUrl = optionalSingleLineString(value, 'supabaseUrl', MAX_SUPABASE_URL_LENGTH);
    const supabaseAnonKey = optionalSingleLineString(value, 'supabaseAnonKey', MAX_SUPABASE_ANON_KEY_LENGTH);
    if (supabaseUrl !== undefined) validated.supabaseUrl = supabaseUrl;
    if (supabaseAnonKey !== undefined) validated.supabaseAnonKey = supabaseAnonKey;

    const userId = value.userId;
    if (userId !== undefined) {
        if (typeof userId !== 'string' || !UUID_RE.test(userId) || hasControlCharacter(userId)) {
            throw new PiConfigurationValidationError('userId must be a UUID');
        }
        validated.userId = userId;
    }

    const hasLat = value.prefetchLat !== undefined;
    const hasLon = value.prefetchLon !== undefined;
    const hasRadius = value.prefetchRadius !== undefined;
    if (hasLat !== hasLon) {
        throw new PiConfigurationValidationError('prefetchLat and prefetchLon must be provided together');
    }
    if (hasRadius && !hasLat) {
        throw new PiConfigurationValidationError('prefetchRadius requires prefetchLat and prefetchLon');
    }
    if (hasLat && hasLon) {
        const lat = value.prefetchLat;
        const lon = value.prefetchLon;
        if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) {
            throw new PiConfigurationValidationError('prefetchLat is outside the WGS84 range');
        }
        if (typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) {
            throw new PiConfigurationValidationError('prefetchLon is outside the WGS84 range');
        }
        validated.prefetchLat = lat;
        validated.prefetchLon = lon;
        if (hasRadius) {
            const radius = value.prefetchRadius;
            if (
                typeof radius !== 'number' ||
                !Number.isFinite(radius) ||
                radius < MIN_PREFETCH_RADIUS_DEG ||
                radius > MAX_PREFETCH_RADIUS_DEG
            ) {
                throw new PiConfigurationValidationError(
                    `prefetchRadius must be between ${MIN_PREFETCH_RADIUS_DEG} and ${MAX_PREFETCH_RADIUS_DEG} degrees`,
                );
            }
            validated.prefetchRadius = radius;
        }
    }

    return validated;
}

/**
 * Render one allowlisted dotenv assignment. dotenv has no escaping convention
 * that makes control characters safe, so reject them rather than quote them.
 */
export function piEnvironmentLine(name: string, value: string | number, maxLength = 8_192): string {
    const text = String(value);
    if (!text || text.length > maxLength || hasControlCharacter(text)) {
        throw new PiConfigurationValidationError(`${name} cannot be persisted safely`);
    }
    return `${name}=${text}`;
}

/**
 * Crash-safe .env replacement. A fresh file is private by default; an existing
 * regular file keeps its permission bits. Renaming the completed temporary file
 * replaces, rather than follows, a destination path and leaves the old file
 * intact if any write step fails.
 */
export function writeEnvironmentFileAtomic(filePath: string, contents: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    let mode = 0o600;
    try {
        const existing = lstatSync(filePath);
        if (!existing.isFile()) {
            throw new PiConfigurationValidationError('Refusing to replace a non-regular .env path');
        }
        mode = existing.mode & 0o777;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | null = null;
    try {
        descriptor = openSync(temporaryPath, 'wx', mode);
        writeFileSync(descriptor, contents, 'utf8');
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = null;
        chmodSync(temporaryPath, mode);
        renameSync(temporaryPath, filePath);
    } catch (error) {
        if (descriptor !== null) {
            try {
                closeSync(descriptor);
            } catch {
                // Preserve the original write failure.
            }
        }
        try {
            unlinkSync(temporaryPath);
        } catch {
            // The rename may have completed, or the temporary file never existed.
        }
        throw error;
    }
}
