/**
 * Calypso is parked. MAYDAY read-out is not.
 *
 * Shane, 2026-08-09: "i feel like poor old Calypso is not ready to be released
 * on the world… i would like to use his voice for the reading of the maydays
 * calls, the radio positions etc."
 *
 * That boundary is the whole point of this file. "Turning off the voice" is
 * the kind of change that quietly takes a safety feature with it, because both
 * things are called Calypso and both come out of a speaker. They share a voice
 * and nothing else: the console is an LLM answering an unverified transcript,
 * while a MAYDAY read-out is scripted text the skipper has already read on
 * screen, spoken through a path that falls back to the OS voice when the
 * network fails.
 *
 * These tests fail loudly if a future tidy-up conflates the two.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const featureVisibility = read('utils/featureVisibility.ts');
const app = read('App.tsx');
const registry = read('viewRegistry.tsx');
const betaProfile = JSON.parse(read('config/public-beta-features.json'));

describe('the console is parked', () => {
    it('is held by a flag, not deleted — bringing him back is one boolean', () => {
        expect(featureVisibility).toMatch(/calypsoConsole:\s*false/);
    });

    it('hides both mic entry points', () => {
        expect(app).toMatch(/FEATURE_VISIBILITY\.calypsoConsole && canAccess\(/);
        // Every mic button reads from the one gate.
        const micButtons = app.match(/Open Calypso voice console/g) ?? [];
        expect(micButtons.length).toBeGreaterThan(0);
        for (const guard of app.match(/\{canUseBosunVoice[^}]*&&/g) ?? []) {
            expect(guard).toContain('canUseBosunVoice');
        }
        expect((app.match(/\{canUseBosunVoice/g) ?? []).length).toBe(micButtons.length);
    });

    it('closes the route as well as the buttons', () => {
        // A persisted currentView or a stale previousView can still resolve to
        // 'voice'. Hiding the button is not the same as closing the door.
        expect(registry).toMatch(/const BosunConsolePage = FEATURE_VISIBILITY\.calypsoConsole\s*\?/);
        expect(registry).toContain('CalypsoParkedPage');
    });

    it('records the hold in the public-beta profile', () => {
        expect(betaProfile.heldCapabilities).toContain('calypso-voice-console');
    });

    it('says on the parked page that MAYDAY read-out still works', () => {
        // "Voice is off" would read as the safety read-out being off too.
        expect(registry).toMatch(/MAYDAY calls, DSC and radio position reports/);
    });
});

describe('safety read-out is untouched', () => {
    const safetyTts = read('services/voice/safetyTts.ts');
    const mob = read('components/vessel/MobPage.tsx');
    const radio = read('components/vessel/RadioConsolePage.tsx');

    it('MOB and Radio still speak, through safetyTts', () => {
        expect(mob).toContain('speakSafetyMessage');
        expect(radio).toContain('speakSafetyMessage');
    });

    it('neither is gated on the parked console', () => {
        expect(mob).not.toContain('calypsoConsole');
        expect(radio).not.toContain('calypsoConsole');
        expect(safetyTts).not.toContain('calypsoConsole');
    });

    it('keeps its network-independent fallback — the reason it survives the park', () => {
        // A distress call cannot fail because ElevenLabs is unreachable. This
        // is precisely the property the console never had.
        expect(safetyTts).toContain('SpeechSynthesisUtterance');
        expect(safetyTts).toMatch(/Promise\.race/);
    });

    it('does not route through the console component at all', () => {
        expect(safetyTts).not.toContain('BosunConsole');
        expect(safetyTts).not.toContain('orchestrator');
    });
});
