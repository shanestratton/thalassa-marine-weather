/**
 * S-57 RESTRN (Restriction, attribute code 131): ONE table for the chart
 * popup and the route advisories (build 125, 125-04).
 *
 * The popup and the router each kept their own partial copy, and both had
 * 14 as "no wake". In S-57, 13 is "no wake" and 14 is "area to be avoided", an
 * IMO routeing measure; the popup's 27 ("no anchoring / no fishing
 * (cable/pipeline)") was not an S-57 meaning at all: 27 is "speed restricted".
 *
 * The expected list below is the IHO's, checked against S-57 Appendix A,
 * Chapter 2 (Attributes), Edition 3.1, November 2000, page 2.177:
 * https://iho.int/uploads/user/pubs/standards/s-57/31ApAch2.pdf
 * The restriction applies worldwide: the same codes are charted by every
 * hydrographic office (an "area to be avoided" off Ushant reads the same as
 * one in the Coral Sea).
 */
import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';

import { ENC_VEC_LAYERS } from '../../components/map/encLayerIds';
import { buildFeaturePopupHtml } from '../../components/map/encPopup';
import { S57_RESTRN_MEANINGS, restrnCodes, restrnMeaning } from '../../services/enc/s57Restrn';
import { describeCautionCrossings } from '../../services/isochrone/landAvoidance';
import type { EncCautionArea } from '../../services/enc/EncSpatialIndex';

/** IHO S-57 Edition 3.1, RESTRN expected input, verbatim. */
const IHO_S57_31_RESTRN: Record<number, string> = {
    1: 'anchoring prohibited',
    2: 'anchoring restricted',
    3: 'fishing prohibited',
    4: 'fishing restricted',
    5: 'trawling prohibited',
    6: 'trawling restricted',
    7: 'entry prohibited',
    8: 'entry restricted',
    9: 'dredging prohibited',
    10: 'dredging restricted',
    11: 'diving prohibited',
    12: 'diving restricted',
    13: 'no wake',
    14: 'area to be avoided',
    15: 'construction prohibited',
    16: 'discharging prohibited',
    17: 'discharging restricted',
    18: 'industrial or mineral exploration/development prohibited',
    19: 'industrial or mineral exploration/development restricted',
    20: 'drilling prohibited',
    21: 'drilling restricted',
    22: 'removal of historical artifacts prohibited',
    23: 'cargo transhipment (lightering) prohibited',
    24: 'dragging prohibited',
    25: 'stopping prohibited',
    26: 'landing prohibited',
    27: 'speed restricted',
};
const CODES = Object.keys(IHO_S57_31_RESTRN).map(Number);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The popup's "Restriction" row for a caution area carrying this RESTRN. */
const popupRestriction = (restrn: unknown): string | undefined =>
    buildFeaturePopupHtml(ENC_VEC_LAYERS.CAUTION_AREA_FILL, { _caution: 'RESARE', RESTRN: restrn }).match(
        /<span>Restriction<\/span><b>([^<]*)<\/b>/,
    )?.[1];

const area = (restrn?: string, cls = 'RESARE'): EncCautionArea => ({ geometry: {} as Geometry, cls, restrn });

describe('the shared S-57 RESTRN table', () => {
    it('holds exactly the 27 IHO codes with their S-57 3.1 meanings', () => {
        expect(
            Object.keys(S57_RESTRN_MEANINGS)
                .map(Number)
                .sort((a, b) => a - b),
        ).toEqual(CODES);
        for (const code of CODES) {
            expect(S57_RESTRN_MEANINGS[String(code)], `RESTRN ${code}`).toBe(IHO_S57_31_RESTRN[code]);
            expect(restrnMeaning(String(code))).toBe(IHO_S57_31_RESTRN[code]);
        }
        expect(restrnMeaning('28')).toBe('restriction code 28');
    });

    it('reads a RESTRN list however the converter hands it over', () => {
        expect(restrnCodes('7,14')).toEqual(['7', '14']);
        expect(restrnCodes(' 7 , 14 ,')).toEqual(['7', '14']);
        expect(restrnCodes([7, 14])).toEqual(['7', '14']);
        expect(restrnCodes(13)).toEqual(['13']);
        expect(restrnCodes('07')).toEqual(['7']);
        expect(restrnCodes(undefined)).toEqual([]);
        expect(restrnCodes(null)).toEqual([]);
        expect(restrnCodes('')).toEqual([]);
    });
});

describe('the chart popup names every code as S-57 does', () => {
    it.each(CODES)('RESTRN %i', (code) => {
        expect(popupRestriction(String(code))).toBe(sentence(IHO_S57_31_RESTRN[code]));
    });

    it("14 is 'Area to be avoided', not 'No wake'; 13 is 'No wake'; 27 is 'Speed restricted'", () => {
        expect(popupRestriction('14')).toBe('Area to be avoided');
        expect(popupRestriction('13')).toBe('No wake');
        expect(popupRestriction('27')).toBe('Speed restricted');
    });

    it('a list reads in order, and an unknown code stays look-up-able', () => {
        expect(popupRestriction('1,14')).toBe('Anchoring prohibited · Area to be avoided');
        expect(popupRestriction([7, 27])).toBe('Entry prohibited · Speed restricted');
        expect(popupRestriction('28')).toBe('restriction code 28');
    });

    it('a restriction folded into the water popup uses the same words', () => {
        const html = buildFeaturePopupHtml(
            ENC_VEC_LAYERS.DEPARE,
            { DRVAL1: 12, DRVAL2: 20 },
            { cautions: [{ _caution: 'RESARE', RESTRN: '14' }] },
        );
        expect(html).toContain('Area to be avoided');
        expect(html).not.toContain('No wake');
    });
});

describe('the route advisories name every code as S-57 does', () => {
    it.each(CODES)('RESTRN %i', (code) => {
        expect(describeCautionCrossings([area(String(code))])!.text).toContain(
            `restricted area (${IHO_S57_31_RESTRN[code]})`,
        );
    });

    it('an area to be avoided grades like entry prohibited / restricted: a caution, not a note', () => {
        for (const code of ['7', '8', '14']) {
            expect(describeCautionCrossings([area(code)])!.severity, `RESTRN ${code}`).toBe('caution');
        }
        expect(describeCautionCrossings([area('1,14')])!.severity).toBe('caution');
        for (const code of CODES.filter((c) => c !== 7 && c !== 8 && c !== 14)) {
            expect(describeCautionCrossings([area(String(code))])!.severity, `RESTRN ${code}`).toBe('note');
        }
    });
});
