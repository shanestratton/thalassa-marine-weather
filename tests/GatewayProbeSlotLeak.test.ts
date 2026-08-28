/**
 * A YDWG-02 serves exactly THREE TCP clients. A scan that strands sockets
 * does not just waste handles — it takes the gateway away from the app that
 * is scanning, for the life of the process, and then blames a chartplotter
 * for slots it is sitting on itself.
 *
 * The leak: `withDeadline` cannot cancel the native call. When it fires we
 * reach the `finally` with `clientId` still null — the deadline firing IS the
 * statement that the `.then` has not run — so nothing is closed. The client id
 * then arrives with nobody holding it. The file header claimed "a background
 * sweep closes any that were abandoned"; there was no such sweep anywhere in
 * the repo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const socket = vi.hoisted(() => ({
    connect: vi.fn(),
    read: vi.fn(),
    disconnect: vi.fn(),
}));

vi.mock('capacitor-tcp-socket', () => ({
    TcpSocket: { connect: socket.connect, read: socket.read, disconnect: socket.disconnect },
}));

import { nativeTcpProbe } from '../services/nmea/nativeTcpProbe';

const settle = async (turns = 8) => {
    for (let i = 0; i < turns; i++) await Promise.resolve();
};

beforeEach(() => {
    socket.connect.mockReset();
    socket.read.mockReset();
    socket.disconnect.mockReset();
    socket.disconnect.mockResolvedValue(undefined);
    socket.read.mockResolvedValue({ result: '' });
});

describe('probe socket discipline', () => {
    it('closes a connection that lands after the deadline gave up on it', async () => {
        // The leak, exactly: connect resolves late, long after the probe
        // reported {open:false} and moved on.
        let land: (v: { client: number }) => void = () => {};
        socket.connect.mockReturnValue(new Promise((r) => (land = r)));

        const result = await nativeTcpProbe('192.168.1.151', 1456, 5);
        expect(result.open).toBe(false);
        expect(socket.disconnect).not.toHaveBeenCalled(); // nothing to close yet

        land({ client: 42 });
        await settle(20);

        expect(socket.disconnect).toHaveBeenCalledWith({ client: 42 });
    });

    it('closes a socket it did hold, on the ordinary path', async () => {
        socket.connect.mockResolvedValue({ client: 7 });
        await nativeTcpProbe('192.168.1.151', 1456, 2000);
        await settle(20);
        expect(socket.disconnect).toHaveBeenCalledWith({ client: 7 });
    });

    it('closes it exactly once, not twice', async () => {
        // Double-release would be harmless against the plugin but is a sign
        // the disown flag and the finally are both claiming the same socket.
        socket.connect.mockResolvedValue({ client: 9 });
        await nativeTcpProbe('192.168.1.151', 1456, 2000);
        await settle(20);
        expect(socket.disconnect.mock.calls.filter((c) => c[0]?.client === 9)).toHaveLength(1);
    });

    it('still reports a live listener as open', async () => {
        socket.connect.mockResolvedValue({ client: 3 });
        socket.read.mockResolvedValue({ result: '$YDRMC,041153.00,A*1B\r\n' });
        const result = await nativeTcpProbe('192.168.1.151', 1456, 2000);
        expect(result.open).toBe(true);
        expect(result.sample).toContain('$YDRMC');
    });

    it('does not promise a background sweep that does not exist', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync('services/nmea/nativeTcpProbe.ts', 'utf8');
        expect(src).not.toContain('a background sweep closes any that were abandoned');
    });
});
