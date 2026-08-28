/**
 * Shane 2026-08-28: "can we get rid of the Rainbow.AI wording in the bottom
 * right of the rain card".
 *
 * Which API answered is a developer's question. The card is read at a glance
 * from a cockpit and does not need to name a supplier — so the vendor names
 * moved into the modal, where someone standing in rain the card called dry
 * comes looking for them.
 *
 * "Estimated" is NOT a vendor name and stays on the face. It warns that the
 * numbers are modelled rather than observed, and a rain forecast that hides
 * that is the one thing this card must never be.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/dashboard/RainForecastCard.tsx', 'utf8');
/** The card body, up to where the modal component begins. */
const cardFace = src.slice(0, src.indexOf('interface ModalProps'));

describe('rain card face', () => {
    it('names no vendor', () => {
        expect(cardFace).not.toContain("return 'Rainbow.ai'");
        expect(cardFace).not.toContain("return 'Apple'");
    });

    it('still says when the numbers are estimated rather than measured', () => {
        expect(cardFace).toContain("const sourceLabel = source === 'synthetic' ? 'Estimated' : ''");
        expect(cardFace).toContain('{sourceLabel}');
    });
});

describe('rain modal', () => {
    it('is handed the source so the provenance is not simply lost', () => {
        expect(src).toContain("source?: 'rainbow' | 'weatherkit' | 'synthetic' | 'unknown';");
        expect(src).toContain('source={source}');
        expect(src).toContain('{feedProvenance}');
    });

    it('names the feed AND how far ahead it can see', () => {
        // The horizon is the half that actually answers "why does this card
        // say dry when it is raining" — WeatherKit sees an hour, Rainbow four.
        expect(src).toContain("if (source === 'rainbow') return 'Rainbow.ai nowcast · 1 km, 4 hours ahead';");
        expect(src).toContain(
            "if (source === 'weatherkit') return 'Apple WeatherKit · minute-by-minute, 1 hour ahead';",
        );
        expect(src).toContain(
            "if (source === 'synthetic') return 'Estimated from the hourly forecast — not a live rain feed';",
        );
    });

    it('says nothing at all rather than guessing when the source is unknown', () => {
        expect(src).toContain('return null;');
        expect(src).toContain('{feedProvenance && (');
    });
});
