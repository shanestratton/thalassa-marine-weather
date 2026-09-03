/**
 * The Pi's broadcast and the shore view's expectations must agree.
 *
 * They did not. The shore view read `shoreData.config.rodeLength` and
 * `shoreData.config.waterDepth`; the Pi's buildPositionPayload sent no
 * `config` at all — so the shore device would have crashed on the Pi's FIRST
 * broadcast, after every other link in the chain worked. Found on 2026-09-03
 * by comparing the two shapes, not by waiting for it to happen at anchor.
 *
 * This is the same class of defect as the public page's `(36).toLowerCase()`:
 * a field assumed present on a payload written by something else.
 *
 * These assertions are deliberately cross-repo — the Pi package and the app
 * are built and tested separately, so nothing else looks at both ends at once.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const broadcaster = readFileSync('pi-cache/src/anchorBroadcaster.ts', 'utf8');
const sync = readFileSync('services/AnchorWatchSyncService.ts', 'utf8');
const page = readFileSync('components/AnchorWatchPage.tsx', 'utf8');
const handoff = readFileSync('services/anchorPiHandoff.ts', 'utf8');
const server = readFileSync('pi-cache/src/server.ts', 'utf8');
const relay = readFileSync('supabase/functions/anchor-relay/index.ts', 'utf8');

describe('the Pi and the shore device speak the same language', () => {
    it('every field the shore view reads is either sent by the Pi or optional-safe', () => {
        // The five the view reads unconditionally.
        for (const field of ['vessel', 'anchor', 'distance', 'swingRadius', 'isAlarm']) {
            expect(broadcaster, `Pi payload is missing ${field}`).toMatch(new RegExp(`${field}[,:]`));
        }
        // …and config, which the Pi can only send when the app told it.
        expect(broadcaster).toMatch(/config:/);
    });

    it('config is OPTIONAL in the type, so a reader cannot assume it', () => {
        expect(sync).toMatch(/config\?: Partial<AnchorWatchConfig>;/);
    });

    it('the shore view guards both reads that would have thrown', () => {
        // The enforcement that matters is the TYPE: with `config?` optional,
        // any unguarded shoreData.config.x is a compile error, which is
        // stronger than any regex here could be. A first attempt at this
        // assertion used a negative match and flagged the GUARDED read inside
        // the ternary — so it asserts the guards themselves instead.
        expect(page).toMatch(/shoreData\.config\?\.rodeLength !== undefined/);
        expect(page).toMatch(/shoreData\.config\?\.waterDepth !== undefined/);
    });

    it("the skipper's rode and depth reach the Pi, since only the phone knows them", () => {
        expect(handoff).toMatch(/rodeLength\?: number;/);
        expect(handoff).toMatch(/waterDepth\?: number;/);
        expect(page).toMatch(/rodeLength: snap\.config\?\.rodeLength/);
        expect(page).toMatch(/waterDepth: snap\.config\?\.waterDepth/);
        // And the Pi accepts them, validated rather than trusted.
        expect(server).toMatch(/Number\.isFinite\(rodeLength\) && rodeLength > 0/);
        expect(server).toMatch(/Number\.isFinite\(waterDepth\) && waterDepth > 0/);
    });

    it('the relay publishes to the topic and event the app is listening on', () => {
        // A mismatch here would be silent: the Pi reports "delivered", the
        // shore device simply never hears anything.
        expect(relay).toMatch(/topic: `anchor-watch-\$\{sessionCode\}`/);
        expect(relay).toMatch(/event: 'position'/);
        expect(relay).toMatch(/private: true/);
        expect(sync).toMatch(/const channelName = `anchor-watch-\$\{sessionCode\}`/);
        expect(sync).toMatch(/channel\.on\('broadcast', \{ event: 'position' \}/);
        expect(sync).toMatch(/private: true/);
    });
});
