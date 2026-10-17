/** Bounded radar episodes over the same125 latch. Sensor loss is never a passed contact. */
import {
    advanceCollisionEncounters,
    encounterLostDetail,
    type CollisionEncounter,
    type EncounterEnd,
    type EncounterLostDetail,
    type EncounterOwnState,
} from './collisionEncounter.js';
import { COLLISION_RULE, collisionShouldSound, type CollisionAssessment } from './collisionRule.js';
import { worstRadarCandidates, type RadarCollisionCandidate } from './radarCollision.js';
import { radarContactKey } from './radarTarget.js';
export const RADAR_ENCOUNTER_CAP = 400;
const ARCHIVE_CAP = 5;
export interface RadarEncounterCard {
    family: 'radar';
    contactKey: string;
    episodeId: string;
    name: string;
    targetNumber: number;
    talker: string;
    sourceAt: number;
    reportAt: number;
    raisedAt: number;
    assessment: CollisionAssessment;
    closeQuarters: boolean;
    lost?: EncounterLostDetail;
    cleared?: 'passed' | 'lost';
}
interface Episode {
    id: string;
    raisedAt: number;
    closeRaisedAt: number | null;
}
interface Acknowledgement {
    episodeId: string;
    close: boolean;
    mutedUntil: number | null;
}
export interface RadarEncounterUpdate {
    ended: ReadonlyMap<string, EncounterEnd>;
    capacityExceeded: boolean;
}
export class RadarEncounters {
    private held = new Map<string, CollisionEncounter<RadarCollisionCandidate>>();
    private episodes = new Map<string, Episode>();
    private acknowledgements = new Map<string, Acknowledgement>();
    private archive: RadarEncounterCard[] = [];
    private serial = 0;
    private overflow: { sourceAt: number; ackedSourceAt: number | null } | null = null;
    constructor(readonly watchEpoch: string) {
        if (!/^[a-f0-9]{32}$/.test(watchEpoch)) throw Error('Invalid radar watch epoch');
    }
    private card(key: string, e: CollisionEncounter<RadarCollisionCandidate>): RadarEncounterCard {
        const episode = this.episodes.get(key)!,
            c = e.latest,
            close = e.last.assessment.closeQuarters;
        return {
            family: 'radar',
            contactKey: key,
            episodeId: episode.id,
            name: c.contact.name || `Radar ${c.contact.targetNumber}`,
            targetNumber: c.contact.targetNumber,
            talker: c.contact.talker,
            sourceAt: c.sourceAt ?? e.last.sourceAt!,
            reportAt: c.contact.at,
            raisedAt: close ? episode.closeRaisedAt! : episode.raisedAt,
            assessment: { ...c.assessment },
            closeQuarters: close,
            ...(e.lost ? { lost: encounterLostDetail(e) } : {}),
        };
    }
    update(
        candidates: readonly RadarCollisionCandidate[],
        own: (candidate: RadarCollisionCandidate | undefined, key: string) => EncounterOwnState,
        now: number,
    ): RadarEncounterUpdate {
        const qualified = candidates.map((c) => {
            const clocks = [c.sourceAt, c.contact.at];
            const identity =
                c.contact.source === 'radar' &&
                c.contact.contactKey === c.contactKey &&
                radarContactKey(c.contact.feedId, c.contact.talker, c.contact.targetNumber) === c.contactKey;
            if (
                identity &&
                c.sourceAt !== null &&
                c.sourceAt <= c.contact.at &&
                clocks.every((at) => Number.isSafeInteger(at) && at! > 0 && at! <= now + 1000 && now - at! <= 15000)
            )
                return c;
            return {
                ...c,
                assessment: {
                    ...c.assessment,
                    rangeOnly: true,
                    alarm: false,
                    cpaNm: null,
                    tcpaMin: null,
                    risk: 'NONE' as const,
                    closeQuarters: false,
                    reason: 'target-motion-unknown' as const,
                },
                opening: false,
                settled: false,
            };
        });
        const all = worstRadarCandidates(qualified),
            admitted: RadarCollisionCandidate[] = [];
        let added = 0;
        for (const c of all) {
            if (c.assessment.alarm && !this.episodes.has(c.contactKey)) {
                if (this.held.size + added >= RADAR_ENCOUNTER_CAP || this.serial >= 999999999) {
                    const sourceAt = c.sourceAt ?? c.contact.at;
                    if (!this.overflow) this.overflow = { sourceAt, ackedSourceAt: null };
                    else this.overflow.sourceAt = Math.max(this.overflow.sourceAt, sourceAt);
                    continue;
                }
                added++;
                this.episodes.set(c.contactKey, {
                    id: `${this.watchEpoch}:${++this.serial}`,
                    raisedAt: now,
                    closeRaisedAt: null,
                });
                this.archive = this.archive.filter((old) => old.contactKey !== c.contactKey);
            }
            const episode = this.episodes.get(c.contactKey);
            if (episode && c.assessment.alarm && c.assessment.closeQuarters) episode.closeRaisedAt ??= now;
            admitted.push(c);
        }
        // Capture prior cards before the shared engine removes completed encounters.
        const before = new Map(this.held);
        const ended = advanceCollisionEncounters(this.held, admitted, (c) => c.contactKey, own, now);
        for (const [key, end] of ended) {
            const previous = before.get(key);
            const prior = previous ? this.card(key, previous) : null;
            if (prior)
                this.archive.unshift({
                    ...prior,
                    cleared: end.how,
                    ...(end.how === 'lost' ? { lost: end.lost } : { lost: undefined }),
                });
            this.episodes.delete(key);
            this.acknowledgements.delete(key);
        }
        this.archive = this.archive.slice(0, ARCHIVE_CAP);
        return { ended, capacityExceeded: this.overflow !== null };
    }
    private sounds(card: RadarEncounterCard, now: number): boolean {
        const ack = this.acknowledgements.get(card.contactKey);
        if (ack?.episodeId === card.episodeId && ack.close) return false;
        return collisionShouldSound(
            { alarm: true, closeQuarters: card.closeQuarters },
            ack?.episodeId === card.episodeId ? ack.mutedUntil : null,
            now,
        );
    }
    sounding(now: number): RadarEncounterCard[] {
        return [...this.held]
            .map(([key, e]) => this.card(key, e))
            .filter((c) => this.sounds(c, now))
            .sort(
                (a, b) =>
                    Number(b.closeQuarters) - Number(a.closeQuarters) ||
                    (a.assessment.tcpaMin ?? Infinity) - (b.assessment.tcpaMin ?? Infinity),
            );
    }
    cards(now: number): RadarEncounterCard[] {
        return [...this.sounding(now), ...this.archive];
    }
    /** Exact family/source/episode/severity only. A delayed danger ack cannot silence an escalation. */
    acknowledge(
        input: { contactKey: string; episodeId: string; kind: 'radar-collision' | 'radar-close-quarters' },
        now: number,
    ): boolean {
        const e = this.held.get(input.contactKey);
        if (!e) return false;
        const card = this.card(input.contactKey, e);
        if (
            card.episodeId !== input.episodeId ||
            (card.closeQuarters ? 'radar-close-quarters' : 'radar-collision') !== input.kind
        )
            return false;
        this.acknowledgements.set(input.contactKey, {
            episodeId: card.episodeId,
            close: card.closeQuarters,
            mutedUntil: card.closeQuarters ? null : now + COLLISION_RULE.muteMinutes * 60000,
        });
        return true;
    }
    dismiss(contactKey: string, episodeId: string): void {
        this.archive = this.archive.filter((c) => c.contactKey !== contactKey || c.episodeId !== episodeId);
    }
    capacity(): Readonly<{ sourceAt: number; acknowledged: boolean }> | null {
        return this.overflow
            ? {
                  sourceAt: this.overflow.sourceAt,
                  acknowledged:
                      this.overflow.ackedSourceAt !== null && this.overflow.ackedSourceAt >= this.overflow.sourceAt,
              }
            : null;
    }
    acknowledgeCapacity(sourceAt: number): boolean {
        if (!this.overflow || sourceAt !== this.overflow.sourceAt) return false;
        this.overflow.ackedSourceAt = sourceAt;
        return true;
    }
    get size(): number {
        return this.held.size;
    }
    reset(): void {
        this.held.clear();
        this.episodes.clear();
        this.acknowledgements.clear();
        this.archive = [];
        this.overflow = null;
    }
}
