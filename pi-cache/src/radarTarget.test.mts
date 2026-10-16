import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseRadarSentence, qualifyRadarReport } from './radar/radarTarget.js';
test('Pi uses the shared original-clock relative radar solution; true ambiguity stays unknown', () => {
    const frame = (body: string) =>
        `$${body}*${[...body]
            .reduce((v, c) => v ^ c.charCodeAt(0), 0)
            .toString(16)
            .padStart(2, '0')}`;
    const now = Date.UTC(2026, 0, 2, 12);
    const feedId = 'pi:generated:verified-vessel';
    const context = { feedId, receivedAt: now, now };
    const own = {
        feedId,
        position: { lat: 0, lon: 179.999, at: now },
        heading: { trueDeg: 0, at: now },
        motion: { sogKn: 5, sogAt: now, cogTrueDeg: 0, cogAt: now },
    };
    const body = 'RATTM,01,1,90,T,10,180,R,0.2,6,N,Generated echo,T,,120000,A';
    const report = parseRadarSentence(frame(body), context)!;
    const contact = qualifyRadarReport(report, own, now);
    assert.ok(contact.position!.lon < -179.98);
    assert.ok(Math.abs(contact.motion!.sogKn - 5) < 1e-9);
    assert.equal(contact.motion!.cogTrueDeg, 180);
    assert.equal(qualifyRadarReport(report, own, now + 16_000).motion, null);
    const trueMotion = parseRadarSentence(frame(body.replace(',180,R,', ',180,T,')), context)!;
    assert.equal(qualifyRadarReport(trueMotion, own, now).motionReason, 'true-reference-unknown');
    assert.equal(parseRadarSentence(frame(body).split('*')[0], context), null);
});
