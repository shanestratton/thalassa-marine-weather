import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { EncDeviceStore, createEncFrontDoor, type BoatLanView } from '../encDevices.js';
import { RadarRawReader } from '../radar/rawReader.js';
import { RadarContextSession } from '../radar/contextSession.js';
import { createRadarRoutes } from './radar.js';

test('mounted radar read independently requires physical boat LAN and current enrollment; no HTTP read starts a source', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-radar-door-'));
    let peer = '192.168.1.22',
        context: string | null = 'a'.repeat(64);
    const owner = {
        ownerId: '00000000-0000-4000-8000-000000000001',
        piDeviceId: '00000000-0000-4000-8000-000000000002',
        pairingId: 'b'.repeat(64),
        feedId: 'pi:00000000-0000-4000-8000-000000000002:' + 'c'.repeat(24),
    };
    const lan: BoatLanView = {
        gateways: ['192.168.1.1'],
        interfaces: {
            eth0: [
                {
                    address: '192.168.1.180',
                    netmask: '255.255.255.0',
                    family: 'IPv4',
                    internal: false,
                    cidr: '192.168.1.180/24',
                    mac: '',
                },
            ],
        },
    };
    const devices = new EncDeviceStore(path.join(directory, 'devices.json')),
        code = await devices.mintCode(),
        phone = await devices.enrol(code.code, 'Fictional radar phone', peer),
        reader = new RadarRawReader(),
        started = t.mock.method(reader, 'start'),
        session = new RadarContextSession(
            reader,
            () => context,
            () => owner,
        ),
        app = express();
    app.use(
        '/api/radar',
        createEncFrontDoor({ devices, lanView: () => lan, peerOf: () => peer }),
        createRadarRoutes(session),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    t.after(async () => {
        session.stop();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'thalassa-radar-door-'));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/radar/targets`,
        headers = { 'x-thalassa-chart-device': phone.token };
    assert.equal((await fetch(base)).status, 401);
    for (const unavailable of ['100.76.1.2', '127.0.0.1', '192.168.1.1', '192.168.1.180', '203.0.113.5']) {
        peer = unavailable;
        assert.equal((await fetch(base, { headers: { ...headers, 'x-forwarded-for': '192.168.1.22' } })).status, 403);
    }
    peer = '192.168.1.22';
    assert.equal((await fetch(base + '?url=https://invalid.example', { headers })).status, 400);
    let response = await fetch(base, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).connected, false);
    assert.equal(started.mock.callCount(), 0);
    session.refresh();
    assert.equal(started.mock.callCount(), 1);
    context = 'b'.repeat(64);
    response = await fetch(base, { headers });
    assert.equal((await response.json()).feedId, null);
    assert.equal(started.mock.callCount(), 1, 'an HTTP read must not start a changed context');
    await devices.remove(phone.deviceId);
    assert.equal((await fetch(base, { headers })).status, 401);
    assert.equal(started.mock.callCount(), 1);
});
