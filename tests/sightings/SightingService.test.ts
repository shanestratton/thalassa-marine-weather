/**
 * Sightings on the phone: visibility rules, which boat, signed-out logging
 * and adoption, photo slots, the life list, and the account-deletion purge.
 * Fictional people: Wren Hollis (skipper), Tamsin Reyes (crew), Odo Varga.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/supabase', () => ({ supabase: null }));
vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../services/sightings/photoStrip', () => ({
    // The real one re-encodes through a canvas (tests/sightings/PhotoStrip.test.ts).
    stripAndCompressPhoto: async (file: Blob) => file,
}));

import { setAuthIdentityScope } from '../../services/authIdentityScope';
import {
    getLocalSighting,
    getSightingMeta,
    listLocalSightings,
    memoryBackend,
    purgeSightingsForUser,
    putLocalSighting,
    putSightingMeta,
    setSightingStoreBackend,
} from '../../services/sightings/sightingStore';
import { sightingsOutboxFlagged } from '../../services/sightings/outboxFlag';
import {
    addSightingPhoto,
    adoptSignedOutSightings,
    applyContext,
    awaitSightingPosition,
    chooseDefaultVisibility,
    chooseSightingVessel,
    clampVisibility,
    cloudOwnerFor,
    editSighting,
    freePhotoSlot,
    lifeList,
    listMySightings,
    logSighting,
    newSightingId,
    removeSightingPhoto,
    retrySendingSighting,
    retrySightingPosition,
    setSightingDisplayName,
    signedOutSightingCount,
} from '../../services/sightings/sightingService';
import type { SightingContext } from '../../services/sightings/sightingContext';
import type { SightingRow } from '../../services/sightings/types';

const WREN = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const TAMSIN = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const ODO = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5c';
const KITTIWAKE_RUN = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

function context(ashore = false): SightingContext {
    return {
        capturedAt: Date.now(),
        position: {
            latitude: -20.2567,
            longitude: 148.9512,
            source: ashore ? 'phone' : 'pi',
            fixAt: Date.now(),
            accuracyM: 10,
            uncertaintyM: 10,
            ashore,
        },
        boatSilent: false,
        samplingProtocol: ashore ? 'opportunistic shore-based observation' : 'opportunistic vessel-based observation',
        seaTempC: null,
        seaTempSource: null,
        waterDepthM: null,
        depthReference: null,
        windSpeedKts: null,
        windDirDeg: null,
        windSource: null,
        waveHeightM: null,
        wxModel: null,
        sogKts: null,
        cogDeg: null,
        headingDeg: null,
    };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    localStorage.clear();
    setSightingStoreBackend(memoryBackend());
    setAuthIdentityScope(WREN);
});

afterEach(() => {
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

describe('visibility', () => {
    it('never lets fish be public, and Crew needs a boat', () => {
        expect(clampVisibility('fish', 'public', true)).toBe('crew');
        expect(clampVisibility('fish', 'public', false)).toBe('private');
        expect(clampVisibility('whale', 'crew', false)).toBe('private');
        expect(clampVisibility('whale', 'public', false)).toBe('public');
    });

    it('starts at Crew on a boat with people, else Private, never Public; then the last choice sticks', () => {
        expect(chooseDefaultVisibility({ group: 'whale', hasVessel: true, boatHasCrew: true, lastChoice: null })).toBe(
            'crew',
        );
        expect(chooseDefaultVisibility({ group: 'whale', hasVessel: true, boatHasCrew: false, lastChoice: null })).toBe(
            'private',
        );
        expect(
            chooseDefaultVisibility({ group: 'whale', hasVessel: true, boatHasCrew: true, lastChoice: 'public' }),
        ).toBe('public');
        expect(
            chooseDefaultVisibility({ group: 'fish', hasVessel: true, boatHasCrew: true, lastChoice: 'public' }),
        ).toBe('crew');
    });

    it('starts fish at Private even on a boat with crew; Crew only when chosen', () => {
        expect(chooseDefaultVisibility({ group: 'fish', hasVessel: true, boatHasCrew: true, lastChoice: null })).toBe(
            'private',
        );
        expect(chooseDefaultVisibility({ group: 'fish', hasVessel: true, boatHasCrew: true, lastChoice: 'crew' })).toBe(
            'crew',
        );
    });

    it('clamps an edit that makes a chosen-Public sighting a fish', async () => {
        const record = await logSighting({
            group: 'whale',
            eventAt: Date.now(),
            context: context(),
            vessel: { vesselOwnerId: WREN, boatId: KITTIWAKE_RUN, voyageId: null },
            visibility: 'crew',
        });
        await editSighting(record.id, { visibility: 'public' });
        const edited = await editSighting(record.id, {
            taxon_group: 'fish',
            scientific_name: 'Plectropomus leopardus',
        });
        expect(edited?.row.visibility).toBe('crew');
        expect(edited?.visibilityChosen).toBe(true);
    });

    it('a default Crew "Other" refined to a fish from the full list starts Private, like the Fish tile', async () => {
        const record = await logSighting({
            group: 'other',
            eventAt: Date.now(),
            context: context(),
            vessel: { vesselOwnerId: WREN, boatId: KITTIWAKE_RUN, voyageId: null },
            visibility: 'crew',
        });
        const edited = await editSighting(record.id, {
            taxon_group: 'fish',
            scientific_name: 'Scomberomorus commerson',
        });
        expect(edited?.row.visibility).toBe('private');
        // Chosen Crew for the fish after that: it sticks.
        const chosen = await editSighting(record.id, { visibility: 'crew' });
        expect(chosen?.row.visibility).toBe('crew');
    });
});

describe('which boat', () => {
    const base = {
        userId: TAMSIN,
        ashore: false,
        recording: null,
        ownActiveVesselId: null,
        crewingOwnerId: null,
        lastChoice: null,
    };

    it('takes your recording voyage first', () => {
        expect(
            chooseSightingVessel({
                ...base,
                userId: WREN,
                recording: { voyageId: 'voyage_1790000000000_kittiwake', boatId: KITTIWAKE_RUN },
                crewingOwnerId: ODO,
            }),
        ).toEqual({ vesselOwnerId: WREN, boatId: KITTIWAKE_RUN, voyageId: 'voyage_1790000000000_kittiwake' });
    });

    it("records the passage on a crew phone against the SKIPPER's boat, so the crew feed sees it", () => {
        expect(
            chooseSightingVessel({
                ...base,
                recording: { voyageId: 'voyage_1790000000000_tamsin', boatId: null },
                crewingOwnerId: WREN,
            }),
        ).toEqual({ vesselOwnerId: WREN, boatId: null, voyageId: 'voyage_1790000000000_tamsin' });
        // With a boat of her own bound to the recording, it is her own boat.
        expect(
            chooseSightingVessel({
                ...base,
                recording: { voyageId: 'voyage_1790000000000_tamsin', boatId: 'own-boat' },
                ownActiveVesselId: 'own-boat',
                crewingOwnerId: WREN,
            }),
        ).toMatchObject({ vesselOwnerId: TAMSIN, boatId: 'own-boat' });
    });

    it("takes the skipper's boat for crew with no boat of their own, or who chose it last time", () => {
        expect(chooseSightingVessel({ ...base, crewingOwnerId: WREN })).toEqual({
            vesselOwnerId: WREN,
            boatId: null,
            voyageId: null,
        });
        expect(
            chooseSightingVessel({ ...base, crewingOwnerId: WREN, ownActiveVesselId: 'own-boat', lastChoice: WREN }),
        ).toMatchObject({ vesselOwnerId: WREN });
        expect(chooseSightingVessel({ ...base, crewingOwnerId: WREN, ownActiveVesselId: 'own-boat' })).toEqual({
            vesselOwnerId: TAMSIN,
            boatId: 'own-boat',
            voyageId: null,
        });
    });

    it('has no boat when signed out, ashore, or told none', () => {
        expect(chooseSightingVessel({ ...base, userId: null, crewingOwnerId: WREN }).vesselOwnerId).toBeNull();
        expect(chooseSightingVessel({ ...base, ashore: true, crewingOwnerId: WREN }).vesselOwnerId).toBeNull();
        expect(chooseSightingVessel({ ...base, crewingOwnerId: WREN, lastChoice: 'none' }).vesselOwnerId).toBeNull();
        expect(chooseSightingVessel(base).vesselOwnerId).toBeNull();
    });

    it('drops the boat and voyage for a sighting made ashore', async () => {
        const record = await logSighting({
            group: 'seabird',
            eventAt: Date.now(),
            context: context(true),
            vessel: { vesselOwnerId: WREN, boatId: KITTIWAKE_RUN, voyageId: 'voyage_1' },
            visibility: 'crew',
        });
        expect(record.row).toMatchObject({
            vessel_owner_id: null,
            boat_id: null,
            voyage_id: null,
            visibility: 'private',
            position_source: 'phone',
            sampling_protocol: 'opportunistic shore-based observation',
        });
    });
});

describe('the tap and after', () => {
    it('makes v4 ids', () => {
        expect(newSightingId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('attaches a late position, or leaves the sighting needing one after 60 s', async () => {
        const record = await logSighting({
            group: 'dolphin',
            eventAt: Date.now(),
            context: null,
            vessel: { vesselOwnerId: WREN, boatId: null, voyageId: null },
            visibility: 'crew',
        });
        await expect(awaitSightingPosition(record.id, Promise.resolve(context()))).resolves.toBe('attached');

        const lost = await logSighting({
            group: 'dolphin',
            eventAt: Date.now(),
            context: null,
            vessel: { vesselOwnerId: WREN, boatId: null, voyageId: null },
            visibility: 'crew',
        });
        const waiting = awaitSightingPosition(lost.id, new Promise<SightingContext>(() => undefined));
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(waiting).resolves.toBe('needs-position');
        const mine = await listMySightings();
        expect(mine.find((r) => r.id === lost.id)?.sync.state).toBe('needs-position');
    });

    it('never reuses a photo slot whose old object is still waiting to be removed', async () => {
        const record = await logSighting({
            group: 'turtle',
            eventAt: Date.now(),
            context: context(),
            vessel: { vesselOwnerId: WREN, boatId: null, voyageId: null },
            visibility: 'crew',
        });
        const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]);
        await addSightingPhoto(record.id, jpeg());
        await addSightingPhoto(record.id, jpeg());
        const removed = await removeSightingPhoto(record.id, 0);
        expect(removed?.removedPhotoPaths).toEqual([`${WREN}/${record.id}/0.jpg`]);
        expect(removed && freePhotoSlot(removed)).toBe(2);
        const third = await addSightingPhoto(record.id, jpeg());
        expect(third?.photos.map((p) => p.slot).sort()).toEqual([1, 2]);
    });
});

describe('signed out', () => {
    it('keeps sightings logged signed out on the phone and adopts them, Private, at sign-in', async () => {
        setAuthIdentityScope(null);
        await logSighting({
            group: 'whale',
            eventAt: Date.now(),
            context: context(),
            vessel: { vesselOwnerId: WREN, boatId: null, voyageId: null },
            visibility: 'public',
        });
        expect(await signedOutSightingCount()).toBe(1);

        setAuthIdentityScope(TAMSIN);
        expect(await listMySightings()).toEqual([]);
        expect(await adoptSignedOutSightings()).toBe(1);
        const [mine] = await listMySightings();
        expect(mine.row).toMatchObject({ observer_id: TAMSIN, vessel_owner_id: null, visibility: 'private' });
        expect(mine.sync).toMatchObject({ state: 'pending', op: 'insert' });
        expect(await signedOutSightingCount()).toBe(0);
    });
});

describe('life list', () => {
    it("counts species by first sighting; group-only sightings don't count", () => {
        const list = lifeList([
            {
                scientific_name: 'Megaptera novaeangliae',
                taxon_group: 'whale',
                event_date: '2026-08-14T01:20:00Z',
                vernacular_name: 'Humpback whale',
            },
            { scientific_name: null, taxon_group: 'dolphin', event_date: '2026-08-10T01:20:00Z' },
            { scientific_name: 'Megaptera novaeangliae', taxon_group: 'whale', event_date: '2026-07-30T22:00:00Z' },
            { scientific_name: 'Chelonia mydas', taxon_group: 'turtle', event_date: '2026-08-01T03:00:00Z' },
        ]);
        expect(list.map((e) => [e.scientificName, e.firstSeen, e.sightings])).toEqual([
            ['Megaptera novaeangliae', '2026-07-30T22:00:00Z', 2],
            ['Chelonia mydas', '2026-08-01T03:00:00Z', 1],
        ]);
        expect(list[0].vernacularName).toBe('Humpback whale');
    });
});

describe('account deletion purge', () => {
    it("removes only the deleted account's sightings, photos and caches", async () => {
        const wrens = await logSighting({
            group: 'whale',
            eventAt: Date.now(),
            context: context(),
            vessel: { vesselOwnerId: WREN, boatId: null, voyageId: null },
            visibility: 'crew',
        });
        await addSightingPhoto(wrens.id, new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]));
        await putSightingMeta(WREN, `crew-feed:${WREN}`, { rows: [] });
        setAuthIdentityScope(ODO);
        await logSighting({
            group: 'seabird',
            eventAt: Date.now(),
            context: context(),
            vessel: { vesselOwnerId: null, boatId: null, voyageId: null },
            visibility: 'private',
        });
        await putSightingMeta(ODO, 'visibility:seabird', 'private');

        expect(await purgeSightingsForUser(WREN)).toBe(1);
        expect(await listLocalSightings(WREN)).toEqual([]);
        expect(await getSightingMeta(WREN, `crew-feed:${WREN}`)).toBeNull();
        expect(await listLocalSightings(ODO)).toHaveLength(1);
        expect(await getSightingMeta(ODO, 'visibility:seabird')).toBe('private');
    });

    it('applyContext never moves the boat for a vessel-based fix', () => {
        const row = applyContext(
            {
                ...({} as SightingRow),
                vessel_owner_id: WREN,
                boat_id: KITTIWAKE_RUN,
                voyage_id: 'v',
                visibility: 'crew',
                taxon_group: 'whale',
            },
            context(false),
        );
        expect(row).toMatchObject({
            vessel_owner_id: WREN,
            boat_id: KITTIWAKE_RUN,
            voyage_id: 'v',
            visibility: 'crew',
        });
    });
});

describe('a sighting left waiting for a position', () => {
    async function stranded(vesselOwnerId: string | null) {
        const record = await logSighting({
            group: 'whale',
            eventAt: Date.now(),
            context: null,
            vessel: { vesselOwnerId, boatId: null, voyageId: null },
            visibility: vesselOwnerId ? 'crew' : 'private',
        });
        expect(record.sync.state).toBe('needs-position');
        return record;
    }

    it("Retry finds the boat's position now, from THIS sighting's boat, and queues it", async () => {
        const record = await stranded(WREN);
        const owners: unknown[] = [];
        const result = await retrySightingPosition(record.id, async (owner) => {
            owners.push(owner);
            return context();
        });
        expect(result).toBe('attached');
        expect(owners).toEqual(['self']);
        const saved = await getLocalSighting(record.id, WREN);
        expect(saved?.sync.state).toBe('pending');
        expect(saved?.row.decimal_latitude).toBe(-20.2567);
    });

    it("asks for the skipper's row on a crewed boat, and for no cloud row with no boat", async () => {
        expect(cloudOwnerFor(WREN, WREN)).toBe('self');
        expect(cloudOwnerFor(WREN, TAMSIN)).toBe(WREN);
        expect(cloudOwnerFor(null, TAMSIN)).toBeNull();
        setAuthIdentityScope(TAMSIN);
        const crewed = await stranded(WREN);
        const owners: unknown[] = [];
        await retrySightingPosition(crewed.id, async (owner) => {
            owners.push(owner);
            return context();
        });
        const loose = await stranded(null);
        await retrySightingPosition(loose.id, async (owner) => {
            owners.push(owner);
            return context();
        });
        expect(owners).toEqual([WREN, null]);
    });

    it('stays waiting when there is still no fix', async () => {
        const record = await stranded(WREN);
        const result = await retrySightingPosition(record.id, async () => ({ ...context(), position: null }));
        expect(result).toBe('needs-position');
        expect((await getLocalSighting(record.id, WREN))?.sync.state).toBe('needs-position');
    });

    it('widens the uncertainty by how far the boat could have gone since the sighting', () => {
        const eventAt = Date.parse('2026-10-05T04:00:00Z');
        const fixAt = eventAt + 10 * 60_000; // ten minutes later, at 6 knots: one nautical mile
        const row = applyContext(
            { ...({} as SightingRow), event_date: new Date(eventAt).toISOString(), taxon_group: 'whale' },
            {
                ...context(),
                sogKts: 6,
                position: { ...context().position!, fixAt, uncertaintyM: 10 },
            },
        );
        // 10 m of receiver plus a nautical mile (1852 m), rounded up.
        expect(row.coordinate_uncertainty_in_meters).toBeGreaterThanOrEqual(10 + 1852);
        expect(row.coordinate_uncertainty_in_meters).toBeLessThanOrEqual(10 + 1853);
    });
});

describe('refused by the server', () => {
    it('Try again queues a failed sighting as it stands', async () => {
        const record = await logSighting({
            group: 'turtle',
            eventAt: Date.now(),
            context: context(),
            vessel: { vesselOwnerId: WREN, boatId: null, voyageId: null },
            visibility: 'crew',
        });
        await putLocalSighting({ ...record, sync: { ...record.sync, state: 'failed', lastError: '23514 check' } });
        const again = await retrySendingSighting(record.id);
        expect(again?.sync).toMatchObject({ state: 'pending', op: 'insert', lastError: null, attempts: 0 });
    });
});

describe('once threatened, always coarse (on the phone too)', () => {
    it('remembers that a sighting was once named a threatened species', async () => {
        const record = await logSighting({
            group: 'whale',
            eventAt: Date.now(),
            context: context(),
            vessel: { vesselOwnerId: WREN, boatId: null, voyageId: null },
            visibility: 'public',
        });
        expect((await setSightingDisplayName(record.id, 'Blue whale', true))?.everSensitive).toBe(true);
        expect((await setSightingDisplayName(record.id, 'Humpback whale', false))?.everSensitive).toBe(true);
    });
});

describe('the outbox hint for app start', () => {
    it('is set when a sighting waits to send, and cleared with the account', async () => {
        expect(sightingsOutboxFlagged(WREN)).toBe(false);
        await logSighting({
            group: 'dolphin',
            eventAt: Date.now(),
            context: context(),
            vessel: { vesselOwnerId: WREN, boatId: null, voyageId: null },
            visibility: 'crew',
        });
        expect(sightingsOutboxFlagged(WREN)).toBe(true);
        await purgeSightingsForUser(WREN);
        expect(sightingsOutboxFlagged(WREN)).toBe(false);
    });

    it('is not set for a sighting still waiting for a position (it cannot be sent yet)', async () => {
        await logSighting({
            group: 'dolphin',
            eventAt: Date.now(),
            context: null,
            vessel: { vesselOwnerId: WREN, boatId: null, voyageId: null },
            visibility: 'crew',
        });
        expect(sightingsOutboxFlagged(WREN)).toBe(false);
    });
});

describe('account deletion purge, when the phone store fails', () => {
    it('still removes what it can, then throws so the cleanup is reported incomplete', async () => {
        const backend = memoryBackend();
        setSightingStoreBackend(backend);
        const first = await logSighting({
            group: 'whale',
            eventAt: Date.now(),
            context: context(),
            vessel: { vesselOwnerId: WREN, boatId: null, voyageId: null },
            visibility: 'crew',
        });
        await logSighting({
            group: 'turtle',
            eventAt: Date.now(),
            context: context(),
            vessel: { vesselOwnerId: WREN, boatId: null, voyageId: null },
            visibility: 'crew',
        });
        const realDelete = backend.delete.bind(backend);
        backend.delete = async (id: string) => {
            if (id === first.id) throw new Error('IndexedDB transaction aborted');
            return realDelete(id);
        };
        await expect(purgeSightingsForUser(WREN)).rejects.toThrow(/could not be removed/);
        expect((await listLocalSightings(WREN)).map((r) => r.id)).toEqual([first.id]);
    });
});
