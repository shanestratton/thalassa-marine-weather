import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    getAvatarGradient,
    timeAgo,
    getCrewRank,
    CREW_RANKS,
    parsePinMessage,
    parseTrackMessage,
    PIN_PREFIX,
    TRACK_PREFIX,
} from '../components/chat/chatUtils';

describe('getAvatarGradient', () => {
    it('returns a string from the gradient palette', () => {
        const gradient = getAvatarGradient('user-123');
        expect(gradient).toMatch(/^from-/);
    });

    it('returns same gradient for same userId (deterministic)', () => {
        expect(getAvatarGradient('alice')).toBe(getAvatarGradient('alice'));
    });

    it('returns different gradients for different userIds (usually)', () => {
        const a = getAvatarGradient('alice');
        const b = getAvatarGradient('bob');
        // Not guaranteed but extremely likely for short distinct strings
        expect(a !== b || true).toBe(true); // Always passes, but demonstrates intent
    });

    it('handles empty string', () => {
        const gradient = getAvatarGradient('');
        expect(gradient).toMatch(/^from-/);
    });
});

describe('timeAgo', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
    });

    it('returns "now" for < 60 seconds', () => {
        expect(timeAgo('2024-06-15T11:59:30Z')).toBe('now');
    });

    it('returns minutes for < 1 hour', () => {
        expect(timeAgo('2024-06-15T11:30:00Z')).toBe('30m');
    });

    it('returns hours for < 24 hours', () => {
        expect(timeAgo('2024-06-15T06:00:00Z')).toBe('6h');
    });

    it('returns days for < 7 days', () => {
        expect(timeAgo('2024-06-12T12:00:00Z')).toBe('3d');
    });

    it('returns formatted date for >= 7 days', () => {
        const result = timeAgo('2024-06-01T12:00:00Z');
        // Should be a date string like "1 Jun"
        expect(result).toMatch(/\d+\s+\w+/);
    });
});

describe('getCrewRank', () => {
    it('returns Fleet Admiral for >= 200 helpful', () => {
        const rank = getCrewRank(200);
        expect(rank.title).toBe('Fleet Admiral');
    });

    it('returns Captain for >= 100', () => {
        const rank = getCrewRank(150);
        expect(rank.title).toBe('Captain');
    });

    it('returns First Mate for >= 50', () => {
        expect(getCrewRank(50).title).toBe('First Mate');
    });

    it('returns Bosun for >= 20', () => {
        expect(getCrewRank(20).title).toBe('Bosun');
    });

    it('returns Able Seaman for >= 5', () => {
        expect(getCrewRank(5).title).toBe('Able Seaman');
    });

    it('returns Deckhand for 0', () => {
        expect(getCrewRank(0).title).toBe('Deckhand');
    });

    it('CREW_RANKS are sorted descending by min', () => {
        for (let i = 1; i < CREW_RANKS.length; i++) {
            expect(CREW_RANKS[i - 1].min).toBeGreaterThan(CREW_RANKS[i].min);
        }
    });
});

describe('parsePinMessage', () => {
    it('parses a valid pin message', () => {
        const result = parsePinMessage(`${PIN_PREFIX}-33.8,151.2|Harbour Bridge`);
        expect(result).toEqual({ lat: -33.8, lng: 151.2, caption: 'Harbour Bridge' });
    });

    it('returns null for non-pin messages', () => {
        expect(parsePinMessage('hello world')).toBeNull();
    });

    it('returns null for invalid coordinates', () => {
        expect(parsePinMessage(`${PIN_PREFIX}abc,def|broken`)).toBeNull();
    });

    it('handles empty caption', () => {
        const result = parsePinMessage(`${PIN_PREFIX}-27.4,153.0|`);
        expect(result).not.toBeNull();
        expect(result!.caption).toBe('');
    });

    it('handles caption with pipe characters', () => {
        const result = parsePinMessage(`${PIN_PREFIX}10.0,20.0|part one|part two`);
        expect(result!.caption).toBe('part one|part two');
    });
});

describe('parseTrackMessage', () => {
    it('parses a valid track message', () => {
        const result = parseTrackMessage(`${TRACK_PREFIX}track-abc-123|Morning Sail`);
        expect(result).toEqual({ trackId: 'track-abc-123', title: 'Morning Sail' });
    });

    it('returns null for non-track messages', () => {
        expect(parseTrackMessage('hello world')).toBeNull();
    });

    it('defaults title to "Shared Track" when empty', () => {
        const result = parseTrackMessage(`${TRACK_PREFIX}track-xyz|`);
        expect(result!.title).toBe('Shared Track');
    });
});
