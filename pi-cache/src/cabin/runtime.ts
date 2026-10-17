import http from 'node:http';
import path from 'node:path';
import { CabinAccess } from './access.js';
import { readCabinCode, invalidateCabinCode } from './codeFile.js';
import { createCabinApp } from './server.js';
import { classifyPeer, readBoatLanView } from '../encDevices.js';
import type { LanTelemetryPayload } from '../lanTelemetry.js';

/** Separate, explicitly enabled listener. Importing this file starts nothing. */
export function startCabinRuntime(options: {
    enabled: boolean;
    host: string;
    port: number;
    mainPort: number;
    cacheDirectory: string;
    assets: string;
    context(): string | null;
    binding(): string | null;
    read(): Promise<LanTelemetryPayload>;
    anchor?(): { running: boolean; dragging: boolean } | null;
}) {
    if (!options.enabled) return null;
    if (
        !Number.isInteger(options.port) ||
        options.port < 1024 ||
        options.port > 65535 ||
        options.port === options.mainPort
    ) {
        console.warn('[cabin] Read-only display port configuration unavailable');
        return null;
    }
    const codeFile = path.join(options.cacheDirectory, 'cabin', 'access.json');
    try {
        invalidateCabinCode(codeFile);
    } catch {
        console.warn('[cabin] Read-only display code could not be retired');
        return null;
    }
    const access = new CabinAccess({
        context: options.context,
        binding: options.binding,
        code: () => readCabinCode(codeFile),
    });
    const server = http.createServer(
        createCabinApp({
            access,
            assets: options.assets,
            read: options.read,
            anchor: options.anchor,
            peerAllowed: (address) =>
                address === '127.0.0.1' ||
                address === '::1' ||
                address === '::ffff:127.0.0.1' ||
                classifyPeer(address, readBoatLanView()).boatLan,
        }),
    );
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.maxHeadersCount = 40;
    server.maxConnections = 16;
    server.on('error', () => {
        access.close();
        console.warn('[cabin] Read-only display listener unavailable');
    });
    try {
        server.listen(options.port, options.host);
    } catch {
        access.close();
        console.warn('[cabin] Read-only display listener unavailable');
        return null;
    }
    return {
        server,
        close() {
            access.close();
            server.close();
            server.closeAllConnections();
        },
    };
}
