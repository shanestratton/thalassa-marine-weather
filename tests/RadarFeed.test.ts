import { describe, expect, it } from 'vitest';
import { RadarFeed, RADAR_HISTORY_MS } from '../utils/radarFeed';
import { RADAR_TARGET_CAP } from '../utils/radarTarget';
const T = Date.UTC(2026, 0, 2, 12);
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}`;
const rmc = (time = '120000', status = 'A', mode = 'A', date = '020126') =>
    frame(`GPRMC,${time},${status},0000.000,N,17959.940,E,5,0,${date},,,${mode}`);
const hdt = (heading = 0) => frame(`HEHDT,${heading},T`);
const ttm = (time = '120000', id = 1, status = 'T') =>
    frame(`RATTM,${id},1,0,R,10,180,R,0.2,6,N,Generated echo,${status},,${time},A`);
const tll = (time = '120001', status = 'T') =>
    frame(`RATLL,1,0001.000,N,17959.940,E,Generated echo,${time},${status},`);
const feed = () => new RadarFeed('pi:generated:verified-vessel:input1');
const prepared = () => {
    const f = feed();
    f.ingest(rmc(), T, T);
    f.ingest(hdt(), T, T);
    return f;
};

describe('bounded original-clock radar input session', () => {
    it('captures the exact ingress navigation so later yaw cannot rotate an old echo', () => {
        const f = prepared();
        expect(f.ingest(ttm(), T, T)).toBe('target');
        const original = f.contacts(T)[0];
        expect(original.motion!.sogKn).toBeCloseTo(5, 12);
        f.ingest(hdt(90), T + 1000, T + 1000);
        expect(f.contacts(T + 1000)[0]).toEqual(original);
        expect(f.ingest(ttm(), T + 2000, T + 2000)).toBeNull();
        expect(f.contacts(T + 2000)[0]).toEqual(original);
        f.ingest(ttm('120002'), T + 2000, T + 2000);
        const next = f.contacts(T + 2000)[0];
        expect(next.position!.lon).toBeLessThan(-179.98);
        expect(next.position!.lat).toBeCloseTo(0, 12);
        expect(next.motion!.sogKn).toBeCloseTo(Math.sqrt(125), 12);
    });
    it('retains independent TTM/TLL evidence without fabricating TLL motion or doubling identities', () => {
        const f = prepared();
        f.ingest(ttm(), T, T);
        f.ingest(tll(), T + 1000, T + 1000);
        const contacts = f.contacts(T + 1000);
        expect(f.targetCount).toBe(1);
        expect(contacts).toHaveLength(2);
        expect(new Set(contacts.map((contact) => contact.contactKey)).size).toBe(1);
        expect(contacts[0].motion!.sogKn).toBeCloseTo(5, 12);
        expect(contacts[0].at).toBe(T);
        expect(contacts[1].motion).toBeNull();
        expect(contacts[1].at).toBe(T + 1000);
    });
    it('a newer lost/acquiring observation suppresses old tracking evidence without claiming clear', () => {
        for (const status of ['L', 'Q']) {
            const f = prepared();
            f.ingest(ttm(), T, T);
            f.ingest(tll('120001', status), T + 1000, T + 1000);
            expect(f.contacts(T + 1000)).toHaveLength(1);
            expect(f.contacts(T + 1000)[0].status).toBe(status === 'L' ? 'lost' : 'acquiring');
            expect(f.contacts(T + 1000)[0].motion).toBeNull();
            expect(f.ingest(ttm(), T + 2000, T + 2000)).toBeNull();
            expect(f.contacts(T + 2000)[0].motion).toBeNull();
        }
    });
    it('new tracking requires advancing original observation time after loss', () => {
        const f = prepared();
        f.ingest(ttm('120000', 1, 'L'), T, T);
        expect(f.ingest(ttm(), T + 500, T + 500)).toBeNull();
        f.ingest(ttm('120001'), T + 1000, T + 1000);
        expect(f.contacts(T + 1000)[0].status).toBe('tracking');
        expect(f.contacts(T + 1000)[0].motion).not.toBeNull();
    });
    it('polling retains original clocks and retires stale dependencies instead of refreshing them', () => {
        const f = prepared();
        f.ingest(ttm(), T, T);
        const stale = f.contacts(T + 16_000)[0];
        expect(stale.at).toBe(T);
        expect(stale.receivedAt).toBe(T);
        expect(stale.fresh).toBe(false);
        expect(stale.position).not.toBeNull();
        expect(stale.motion).toBeNull();
        expect(f.contacts(T + RADAR_HISTORY_MS + 1)).toEqual([]);
        expect(f.targetCount).toBe(0);
    });
    it('a caller cannot mutate a returned point or velocity and poison the retained observation', () => {
        const f = prepared();
        f.ingest(ttm(), T, T);
        const a = f.contacts(T)[0];
        a.position!.lat = 90;
        a.motion!.sogKn = 99;
        expect(f.contacts(T)[0].position!.lat).not.toBe(90);
        expect(f.contacts(T)[0].motion!.sogKn).toBeCloseTo(5, 12);
    });
    it('caps target identities deterministically, not by unbounded target-number churn', () => {
        const f = prepared();
        for (let id = 0; id <= RADAR_TARGET_CAP; id++) f.ingest(ttm('120000', id), T, T);
        expect(f.targetCount).toBe(RADAR_TARGET_CAP);
        expect(f.contacts(T)).toHaveLength(RADAR_TARGET_CAP);
        expect(f.contacts(NaN)).toEqual([]);
    });
    it('requires checksum-qualified measured navigation; simulator/manual GPS and magnetic heading never qualify', () => {
        for (const bad of [
            rmc('120000', 'V'),
            rmc('120000', 'A', 'S'),
            rmc('120000', 'A', 'M'),
            rmc('120000', 'A', 'A', '010126'),
            rmc().split('*')[0],
        ]) {
            const f = feed();
            f.ingest(bad, T, T);
            f.ingest(hdt(), T, T);
            f.ingest(ttm(), T, T);
            expect(f.contacts(T)[0].position).toBeNull();
            expect(f.contacts(T)[0].motion).toBeNull();
        }
        const f = feed();
        f.ingest(rmc(), T, T);
        f.ingest(frame('HEHDM,0,M'), T, T);
        f.ingest(ttm(), T, T);
        expect(f.contacts(T)[0].position).toBeNull();
    });
    it('cannot resurrect an explicit heading-invalid state using an older delayed frame', () => {
        const f = prepared();
        f.ingest(frame('HETHS,0,V'), T + 1000, T + 1000);
        expect(f.ingest(hdt(), T, T + 1000)).toBeNull();
        f.ingest(ttm('120001'), T + 1000, T + 1000);
        expect(f.contacts(T + 1000)[0].position).toBeNull();
        f.ingest(frame('HETHS,0,A'), T + 2000, T + 2000);
        f.ingest(ttm('120002'), T + 2000, T + 2000);
        expect(f.contacts(T + 2000)[0].motion).not.toBeNull();
    });
    it('requires coherent explicit ground vectors rather than mixing inconsistent VTG units', () => {
        const f = feed();
        f.ingest(frame('GPGGA,120000,0000.000,N,17959.940,E,1,08,1,0,M,0,M,,'), T, T);
        f.ingest(hdt(), T, T);
        f.ingest(frame('GPVTG,0,T,,M,5,N,18.52,K,A'), T, T);
        f.ingest(ttm(), T, T);
        expect(f.contacts(T)[0].position).not.toBeNull();
        expect(f.contacts(T)[0].motion).toBeNull();
        f.ingest(frame('GPVTG,0,T,,M,5,N,9.26,K,A'), T + 1000, T + 1000);
        f.ingest(ttm('120001'), T + 1000, T + 1000);
        expect(f.contacts(T + 1000)[0].motion!.sogKn).toBeCloseTo(5, 12);
    });
    it('separate feed sessions and reset cannot inherit another input navigation or target history', () => {
        const a = prepared(),
            b = new RadarFeed('pi:generated:other-input');
        a.ingest(ttm(), T, T);
        b.ingest(ttm(), T, T);
        expect(a.contacts(T)[0].motion).not.toBeNull();
        expect(b.contacts(T)[0].motion).toBeNull();
        expect(a.contacts(T)[0].contactKey).not.toBe(b.contacts(T)[0].contactKey);
        a.reset();
        expect(a.contacts(T)).toEqual([]);
        a.ingest(ttm('120001'), T + 1000, T + 1000);
        expect(a.contacts(T + 1000)[0].motion).toBeNull();
    });
});
