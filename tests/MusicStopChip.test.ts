/**
 * Apple Music has an off switch on the page.
 *
 * Shane, 2026-09-06: "there is not off switch for the music … you can go out
 * of the page and turn it off from the floating pill, but non intuitive. can
 * we have a kill switch here … just beside the speaker button, something
 * like STOP".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('the STOP chip', () => {
    it('sits beside the speaker chip on the playing stage', () => {
        const stage = read('components/music/musicPage/NowPlayingStage.tsx');
        const row = stage.slice(
            stage.indexOf('<StopChip onStop={onStop} />'),
            stage.indexOf('</section>', stage.indexOf('<StopChip')),
        );
        expect(row).toContain('<SpeakerChip speaker={speaker} onPick={onPickSpeaker} />');
        expect(read('components/music/musicPage/types.ts')).toContain('onStop: () => void;');
    });

    it('stops — pause plus clear the queue — rather than just pausing', () => {
        const page = read('components/music/MusicPage.tsx');
        const handler = page.slice(
            page.indexOf('const handleStop = useCallback'),
            page.indexOf('const handleResume = useCallback'),
        );
        expect(handler).toContain('await stopMusic()');
        expect(handler).toContain('setActivePlaylistId(null)');
        expect(page).toContain('onStop={() => void handleStop()}');
        const chip = read('components/music/musicPage/StopChip.tsx');
        expect(chip).toContain('aria-label="Stop the music and clear the queue"');
        expect(chip).toContain('min-h-[44px]');
    });
});
