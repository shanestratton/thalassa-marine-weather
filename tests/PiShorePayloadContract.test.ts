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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShoreWatchReadings } from '../components/anchor-watch/ShoreWatchReadings';
import type { PositionBroadcast } from '../services/AnchorWatchSyncService';
import { ANCHOR_LIVE_KEYS } from '../services/anchorLiveConditions';

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

    it.each([undefined, {}, { rodeLength: 30 }, { waterDepth: 5 }])(
        'the extracted shore readings render a Pi payload with missing or partial config: %j',
        (config) => {
            // The page passes the Pi payload through without filling in
            // invented setup values. Exercise both optional reads in the
            // real presentation component, including one-field payloads.
            expect(page).toMatch(/<ShoreWatchReadings\s+data=\{shoreData\}/);
            const timestamp = Date.UTC(2026, 8, 25, 0, 0);
            const data: PositionBroadcast = {
                type: 'position',
                vessel: { latitude: -20.25, longitude: 148.81, accuracy: 3, heading: 20, speed: 0, timestamp },
                anchor: { latitude: -20.25, longitude: 148.81, timestamp },
                distance: 10,
                swingRadius: 35,
                isAlarm: false,
                timestamp,
                ...(config === undefined ? {} : { config }),
            };
            const markup = renderToStaticMarkup(
                createElement(ShoreWatchReadings, {
                    data,
                    fresh: true,
                    isAlarm: false,
                    statusLabel: 'Holding',
                    showMute: false,
                    muted: false,
                    onMute: () => undefined,
                    lengthUnit: 'm',
                    speedUnit: 'kts',
                    trail: [],
                }),
            );
            const container = document.createElement('div');
            container.innerHTML = markup;
            const metrics = Object.fromEntries(
                [...container.querySelectorAll('dt')].map((label) => [
                    label.textContent,
                    label.nextElementSibling?.textContent,
                ]),
            );
            expect(metrics.Rode).toBe(config && 'rodeLength' in config ? '30 m' : '--');
            expect(metrics.Depth).toBe(config && 'waterDepth' in config ? '5.0 m' : '--');
            expect(metrics['Swing Radius']).toBe('35 m');
        },
    );

    // 126-03a renders the boat's live depth and wind; 126-05 makes the Pi send
    // them. Whichever lands second must not rename a field the other reads.
    describe('the live depth and wind block (126-05 shape)', () => {
        const liveType = sync.match(/live\?: \{([\s\S]*?)\};/)?.[1] ?? '';

        it('`live` is optional in the type, so an older Pi or a phone-kept watch sends none', () => {
            expect(sync).toMatch(/live\?: \{/);
        });

        it('the type and the reader name the same keys, each optional', () => {
            const typed = [...liveType.matchAll(/(\w+)\?:/g)].map((m) => m[1]).sort();
            expect(typed).toEqual([...ANCHOR_LIVE_KEYS].sort());
        });

        it('every live key the readings read is written by the Pi, or the Pi writes no live block yet', () => {
            // A `live` key in the payload (`live: …` or the `{ live }` shorthand),
            // not the word in a comment.
            const piWritesLive = /\blive\s*:|[{,]\s*live\s*[,}]/.test(broadcaster);
            for (const key of ANCHOR_LIVE_KEYS) {
                if (piWritesLive) expect(broadcaster, `Pi live block is missing ${key}`).toContain(key);
            }
            // The readings read the block only through the reader, so a key the
            // reader does not know is never read.
            const readings = readFileSync('components/anchor-watch/ShoreWatchReadings.tsx', 'utf8');
            expect(readings).toMatch(/readAnchorLiveConditions\(data\.live/);
            expect(readings).not.toMatch(/data\.live\.\w+/);
        });

        it.each([
            ['missing', undefined],
            ['empty', {}],
        ])('the readings render a payload with live %s, and show no live rows', (_label, live) => {
            const timestamp = Date.UTC(2026, 9, 10, 2, 0);
            const data: PositionBroadcast = {
                type: 'position',
                vessel: { latitude: -43.61, longitude: 172.72, accuracy: 3, heading: 20, speed: 0, timestamp },
                anchor: { latitude: -43.61, longitude: 172.72, timestamp },
                distance: 10,
                swingRadius: 35,
                isAlarm: false,
                timestamp,
                ...(live === undefined ? {} : { live }),
            };
            const markup = renderToStaticMarkup(
                createElement(ShoreWatchReadings, {
                    data,
                    fresh: true,
                    isAlarm: false,
                    statusLabel: 'Holding',
                    showMute: false,
                    muted: false,
                    onMute: () => undefined,
                    lengthUnit: 'ft',
                    speedUnit: 'kmh',
                    trail: [],
                    now: timestamp,
                }),
            );
            expect(markup).not.toContain('Wind');
            expect(markup).not.toContain('Depth below');
            expect(markup).not.toContain('NaN');
        });
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
        expect(relay).toContain("const event = gpsAvailable ? 'position' : 'status'");
        expect(relay).toMatch(/private: true/);
        expect(sync).toMatch(/const channelName = `anchor-watch-\$\{sessionCode\}`/);
        expect(sync).toMatch(/channel\.on\('broadcast', \{ event: 'position' \}/);
        expect(sync).toMatch(/private: true/);
    });
});
