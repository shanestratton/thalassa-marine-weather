import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
    context: 'account-a:boat-a:1',
    vesselId: 'boat-a',
    pair: {
        deviceId: 'pi-a',
        publicKeySpki: 'public-key',
        fingerprint: 'fingerprint',
        pairedAt: '2026-10-01',
        host: 'boat.invalid',
        boatName: 'Boat',
    },
    request: vi.fn(),
    session: vi.fn(),
    events: [] as string[],
}));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => h.pair,
    pinnedPiRequest: (options: unknown) => h.request(options),
}));
vi.mock('../services/anchorSafeZoneContext', () => ({ anchorSafeZoneContextKey: () => h.context }));
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ activeVesselId: h.vesselId }) } }));
vi.mock('../services/supabase', () => ({ supabase: { auth: { getSession: () => h.session() } } }));
import { anchorZonePosition } from '../utils/anchorSafeZone';
import { authoriseRelay, handOffToPi, sendAssignmentToPi, type PiWatchAssignment } from '../services/anchorPiHandoff';
import { anchorAssignmentSafeArea } from '../services/anchorSafeAreaAssignment';
const anchor = { latitude: -27, longitude: 179.99999 };
const assignment: PiWatchAssignment = {
    sessionCode: 'ABC123DEF456',
    anchorLat: anchor.latitude,
    anchorLon: anchor.longitude,
    swingRadius: 60,
    safeZone: {
        version: 1,
        kind: 'polygon',
        anchor,
        vertices: [
            [-20, -20],
            [20, -20],
            [20, 20],
            [-20, 20],
        ].map(([x, y]) => anchorZonePosition(anchor, x, y)!),
    },
    safeAreaRevision: '11111111-1111-4111-8111-111111111111',
    safeAreaVesselId: 'boat-a',
};
const reply = (body: unknown) => ({ status: 200, data: JSON.stringify(body), headers: {}, peerSpki: '' });
beforeEach(() => {
    h.context = 'account-a:boat-a:1';
    h.vesselId = 'boat-a';
    h.pair.pairedAt = '2026-10-01';
    h.events = [];
    h.session.mockReset().mockResolvedValue({ data: { session: { access_token: 'fictional-jwt' } } });
    h.request.mockReset().mockImplementation(async (options: { url: string; data?: PiWatchAssignment }) => {
        if (options.url.endsWith('/capability')) {
            h.events.push('capability');
            return reply({ safeZoneVersion: 1, watchRevision: 'boot:1' });
        }
        h.events.push('assignment');
        return reply({
            safeZoneVersion: 1,
            safeArea: anchorAssignmentSafeArea(options.data!),
            safeAreaRevision: options.data!.safeAreaRevision,
            safeAreaVesselId: options.data!.safeAreaVesselId,
        });
    });
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.invalid');
    vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, options: { body: string }) => {
            h.events.push('authorise');
            const body = JSON.parse(options.body);
            return new Response(
                JSON.stringify({
                    safeZoneVersion: 1,
                    safe_area: body.safe_area,
                    safe_area_revision: body.safe_area_revision,
                    safe_area_vessel_id: body.safe_area_vessel_id,
                }),
                { status: 200 },
            );
        }),
    );
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});
describe('custom-area handoff needs exact backend and Pi acknowledgement', () => {
    it('authorises the exact manual frame/zone/UUID, then sends a fresh expected Pi watch revision', async () => {
        expect(await handOffToPi(assignment, 'relay-a', 'https://boat.invalid')).toBe(true);
        expect(h.events).toEqual(['authorise', 'capability', 'assignment']);
        expect(h.request).toHaveBeenLastCalledWith(
            expect.objectContaining({ data: { ...assignment, expectedWatchRevision: 'boot:1' } }),
        );
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(body.safe_area).toEqual(anchorAssignmentSafeArea(assignment));
        expect(body.safe_area_revision).toBe(assignment.safeAreaRevision);
        expect(body.safe_area_vessel_id).toBe('boat-a');
    });
    it('keeps the phone watch when the relay is an older deployment or echoes a different area UUID', async () => {
        for (const body of [
            {},
            { safeZoneVersion: 1, safe_area: anchorAssignmentSafeArea(assignment), safe_area_revision: 'old' },
        ]) {
            vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
            expect(await handOffToPi(assignment, 'relay-a', 'https://boat.invalid')).toBe(false);
        }
        expect(h.request).not.toHaveBeenCalled();
    });
    it('sends no assignment to an older Pi that only watches the circle', async () => {
        h.request.mockResolvedValueOnce(reply({ capable: true }));
        const result = await sendAssignmentToPi(assignment, 'https://boat.invalid');
        expect(result).toMatchObject({ taken: false, status: 409 });
        expect(h.request).toHaveBeenCalledOnce();
    });
    it('treats a 2xx without the exact boundary acknowledgement as unknown, never as a confirmed refusal or success', async () => {
        h.request
            .mockResolvedValueOnce(reply({ safeZoneVersion: 1, watchRevision: 'boot:1' }))
            .mockResolvedValueOnce(
                reply({ safeZoneVersion: 1, safeArea: null, safeAreaRevision: assignment.safeAreaRevision }),
            );
        expect(await sendAssignmentToPi(assignment, 'https://boat.invalid')).toMatchObject({
            taken: false,
            status: null,
        });
    });
    it.each(['account', 'vessel', 'pairing'])(
        'fences %s replacement while capability is pending, before sending the command',
        async (kind) => {
            h.request.mockImplementationOnce(async () => {
                if (kind === 'pairing') h.pair.pairedAt = '2026-10-02';
                else h.context = `${kind}:A/B/A:3`;
                return reply({ safeZoneVersion: 1, watchRevision: 'boot:1' });
            });
            expect(await sendAssignmentToPi(assignment, 'https://boat.invalid')).toMatchObject({
                taken: false,
                status: 409,
            });
            expect(h.request).toHaveBeenCalledOnce();
        },
    );
    it('does not authorise with a session returned after the original account lease was retired', async () => {
        h.session.mockImplementationOnce(async () => {
            h.context = 'account-b:2';
            return { data: { session: { access_token: 'other-account-fictional' } } };
        });
        expect(await authoriseRelay('relay-a', assignment.sessionCode, assignment)).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('honours the phone watch-revision lease both before and after remote acceptance', async () => {
        const current = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        expect(await handOffToPi(assignment, 'relay-a', 'https://boat.invalid', undefined, current)).toBe(false);
        expect(h.request).not.toHaveBeenCalled();
        h.request
            .mockImplementationOnce(async () => reply({ safeZoneVersion: 1, watchRevision: 'boot:1' }))
            .mockImplementationOnce(async () => {
                h.context = 'retired:2';
                return reply({
                    safeZoneVersion: 1,
                    safeArea: anchorAssignmentSafeArea(assignment),
                    safeAreaRevision: assignment.safeAreaRevision,
                    safeAreaVesselId: assignment.safeAreaVesselId,
                });
            });
        expect(await handOffToPi(assignment, 'relay-a', 'https://boat.invalid')).toBe(false);
    });
    it('makes a return to circle-only explicit and gives it a new revision', async () => {
        const circle = { ...assignment, safeZone: null, safeAreaRevision: '22222222-2222-4222-8222-222222222222' };
        expect(await handOffToPi(circle, 'relay-a', 'https://boat.invalid')).toBe(true);
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(body.safe_area.zone).toBeNull();
        expect(body.safe_area.frame).toEqual({ latitude: anchor.latitude, longitude: anchor.longitude, radiusM: 60 });
        expect(body.safe_area_revision).toBe(circle.safeAreaRevision);
    });
    it('refuses an assignment or reply bound to a different selected vessel', async () => {
        expect(
            await authoriseRelay('relay-a', assignment.sessionCode, { ...assignment, safeAreaVesselId: 'boat-b' }),
        ).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
        expect(
            await sendAssignmentToPi({ ...assignment, safeAreaVesselId: 'boat-b' }, 'https://boat.invalid'),
        ).toMatchObject({ taken: false, status: 409 });
        expect(h.request).not.toHaveBeenCalled();
        vi.mocked(fetch).mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    safeZoneVersion: 1,
                    safe_area: anchorAssignmentSafeArea(assignment),
                    safe_area_revision: assignment.safeAreaRevision,
                    safe_area_vessel_id: 'boat-b',
                }),
                { status: 200 },
            ),
        );
        expect(await authoriseRelay('relay-a', assignment.sessionCode, assignment)).toBe(false);
    });
});
