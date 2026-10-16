import { describe, expect, it } from 'vitest';
import {
    advanceCollisionEncounters,
    type CollisionEncounter,
    type EncounterCandidate,
} from '../utils/collisionEncounter';
import { assessCollision } from '../utils/collisionRule';
interface Candidate extends EncounterCandidate {
    id: number | string;
}
const assessment = assessCollision(
    { lat: 0, lon: 0, sogKn: 5, cogDeg: 0, atAnchor: false },
    { lat: 1 / 60, lon: 0, sogKn: 5, cogDeg: 180, source: 'radar', reportAgeSec: 0 },
)!;
const danger = (id: number | string): Candidate => ({ id, assessment, opening: false });
const opening = (id: number | string): Candidate => ({
    id,
    assessment: { ...assessment, risk: 'SAFE', alarm: false, closeQuarters: false, tcpaMin: -1 },
    opening: true,
});
describe('the shared125 source-identity encounter latch', () => {
    it('keeps numeric AIS and real radar identities separate while requiring actual held clear evidence', () => {
        const held = new Map<number | string, CollisionEncounter<Candidate>>();
        advanceCollisionEncounters(held, [danger(123456789), danger('radar:pi:input:RA:1')], (c) => c.id, 'moving', 0);
        for (const now of [1000, 16000])
            expect(advanceCollisionEncounters(held, [opening(123456789)], (c) => c.id, 'moving', now).size).toBe(0);
        const ended = advanceCollisionEncounters(held, [opening(123456789)], (c) => c.id, 'moving', 31000);
        expect(ended.get(123456789)).toEqual({ how: 'passed' });
        expect(held.has('radar:pi:input:RA:1')).toBe(true);
        expect(held.get('radar:pi:input:RA:1')!.lost!.reason).toBe('gone');
    });
    it('an intervening unknown dependency resets clear proof and cannot relabel loss as passed', () => {
        const held = new Map<number | string, CollisionEncounter<Candidate>>();
        advanceCollisionEncounters(held, [danger('radar:input')], (c) => c.id, 'moving', 0);
        advanceCollisionEncounters(held, [opening('radar:input')], (c) => c.id, 'moving', 1000);
        advanceCollisionEncounters(held, [opening('radar:input')], (c) => c.id, 'unknown', 16000);
        expect(held.get('radar:input')!.clearSince).toBeNull();
        expect(advanceCollisionEncounters(held, [opening('radar:input')], (c) => c.id, 'moving', 31000).size).toBe(0);
        const ended = advanceCollisionEncounters(held, [], (c) => c.id, 'no-fix', 800000);
        expect(ended.get('radar:input')).toMatchObject({ how: 'lost', lost: { reason: 'no-fix' } });
    });
});
