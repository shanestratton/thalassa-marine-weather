import { describe, expect, it } from 'vitest';
import { findImportSpecifiers, stripComments } from '../scripts/check-deps.mjs';

/**
 * Regression: 2026-08-25 CI red (fixed by rewording in c32a4234, scanner
 * fixed for real after). The import regex spans newlines, so an `export
 * const` line followed a few lines later by a doc comment whose prose
 * read `from "now"` scanned as a phantom import of the npm package 'now'
 * (services/weather/api/cmemsPassageCurrents.ts). check-deps must strip
 * comments before its import regexes run — without stripping string
 * contents, where '//' is load-bearing (URLs).
 *
 * Fixtures are arrays of single-line strings joined with newlines on
 * purpose: check-deps scans this test file too, and a fixture laid out
 * as a multi-line template literal would hand the real scanner the very
 * line-anchored bait it is being tested against.
 */
describe('check-deps comment stripping', () => {
    it('does not read block-comment prose after an export line as an import', () => {
        // The shape of the original incident, pre-reword.
        const poisoned = [
            'export const CMEMS_PASSAGE_MAX_VECTORS = 300;',
            '',
            '/** A pipeline whose nearest frame is further than this from "now" is dead',
            ' *  or wedged — fall back rather than brief on old water. */',
            'export const CMEMS_PASSAGE_MAX_FRAME_SKEW_MS = 48 * 3_600_000;',
        ].join('\n');
        expect(findImportSpecifiers(stripComments(poisoned))).toEqual([]);
    });

    it('does not read line-comment prose after an export line as an import', () => {
        const poisoned = ['export function refresh() {}', '// values are re-read from "later" on every tick'].join(
            '\n',
        );
        expect(findImportSpecifiers(stripComments(poisoned))).toEqual([]);
    });

    it('still finds real imports, including multi-line ones, next to comments', () => {
        const source = [
            "/* header */ import React from 'react';",
            'import {',
            '    renderHook, // trailing comment on a specifier line',
            "} from '@testing-library/react';",
            "export { helper } from './local';",
        ].join('\n');
        const specs = findImportSpecifiers(stripComments(source));
        expect(specs).toEqual(['react', '@testing-library/react', './local']);
    });

    it('preserves string contents that contain double slashes', () => {
        const source = "export const DOCS_URL = 'https://example.com/docs';\n";
        expect(stripComments(source)).toBe(source);
    });

    it('keeps template contents while stripping comments inside interpolations', () => {
        const source = 'const label = `wind ${speed /* knots */} kn — see https://bom.gov.au`;';
        const stripped = stripComments(source);
        expect(stripped).toContain('https://bom.gov.au');
        expect(stripped).not.toContain('knots');
    });
});
