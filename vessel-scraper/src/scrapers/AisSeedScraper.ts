/**
 * AisSeedScraper — Phase 1: Self-seed from existing AIS data.
 *
 * Populates vessel_metadata directly from the `vessels` table + MMSI decoder.
 * No external API calls needed. Provides immediate coverage for all vessels.
 *
 * Data sources:
 *   - vessels.name          → vessel_name
 *   - vessels.call_sign     → call_sign
 *   - vessels.ship_type     → vessel_type (decoded via AIS type code)
 *   - vessels.imo_number    → imo_number
 *   - vessels.dimension_*   → loa, beam (calculated from AIS dimensions)
 *   - MMSI MID              → flag_country, flag_emoji
 */

import { supabase, VesselMetadataRow, upsertMetadata } from '../supabase';
import { getMid } from '../MmsiDecoder';

// ── Country lookup (MID → country name + flag emoji) ──
const MID_COUNTRY: Record<number, [string, string]> = {
    201: ['Albania', '🇦🇱'], 202: ['Andorra', '🇦🇩'], 203: ['Austria', '🇦🇹'],
    204: ['Azores (Portugal)', '🇵🇹'], 205: ['Belgium', '🇧🇪'], 206: ['Belarus', '🇧🇾'],
    207: ['Bulgaria', '🇧🇬'], 208: ['Vatican', '🇻🇦'], 209: ['Cyprus', '🇨🇾'],
    210: ['Cyprus', '🇨🇾'], 211: ['Germany', '🇩🇪'], 212: ['Cyprus', '🇨🇾'],
    213: ['Georgia', '🇬🇪'], 214: ['Moldova', '🇲🇩'], 215: ['Malta', '🇲🇹'],
    216: ['Armenia', '🇦🇲'], 218: ['Germany', '🇩🇪'], 219: ['Denmark', '🇩🇰'],
    220: ['Denmark', '🇩🇰'], 224: ['Spain', '🇪🇸'], 225: ['Spain', '🇪🇸'],
    226: ['France', '🇫🇷'], 227: ['France', '🇫🇷'], 228: ['France', '🇫🇷'],
    229: ['Malta', '🇲🇹'], 230: ['Finland', '🇫🇮'], 231: ['Faroe Islands', '🇫🇴'],
    232: ['United Kingdom', '🇬🇧'], 233: ['United Kingdom', '🇬🇧'],
    234: ['United Kingdom', '🇬🇧'], 235: ['United Kingdom', '🇬🇧'],
    236: ['Gibraltar', '🇬🇮'], 237: ['Greece', '🇬🇷'], 238: ['Croatia', '🇭🇷'],
    239: ['Greece', '🇬🇷'], 240: ['Greece', '🇬🇷'], 241: ['Greece', '🇬🇷'],
    242: ['Morocco', '🇲🇦'], 243: ['Hungary', '🇭🇺'], 244: ['Netherlands', '🇳🇱'],
    245: ['Netherlands', '🇳🇱'], 246: ['Netherlands', '🇳🇱'],
    247: ['Italy', '🇮🇹'], 248: ['Malta', '🇲🇹'], 249: ['Malta', '🇲🇹'],
    250: ['Ireland', '🇮🇪'], 251: ['Iceland', '🇮🇸'], 252: ['Liechtenstein', '🇱🇮'],
    253: ['Luxembourg', '🇱🇺'], 254: ['Monaco', '🇲🇨'], 255: ['Madeira (Portugal)', '🇵🇹'],
    256: ['Malta', '🇲🇹'], 257: ['Norway', '🇳🇴'], 258: ['Norway', '🇳🇴'],
    259: ['Norway', '🇳🇴'], 261: ['Poland', '🇵🇱'], 263: ['Portugal', '🇵🇹'],
    264: ['Romania', '🇷🇴'], 265: ['Sweden', '🇸🇪'], 266: ['Sweden', '🇸🇪'],
    267: ['Slovakia', '🇸🇰'], 268: ['San Marino', '🇸🇲'], 269: ['Switzerland', '🇨🇭'],
    270: ['Czech Republic', '🇨🇿'], 271: ['Turkey', '🇹🇷'], 272: ['Ukraine', '🇺🇦'],
    273: ['Russia', '🇷🇺'], 274: ['North Macedonia', '🇲🇰'], 275: ['Latvia', '🇱🇻'],
    276: ['Estonia', '🇪🇪'], 277: ['Lithuania', '🇱🇹'], 278: ['Slovenia', '🇸🇮'],
    279: ['Serbia', '🇷🇸'],
    // Americas
    303: ['USA', '🇺🇸'], 304: ['Antigua & Barbuda', '🇦🇬'], 305: ['Antigua & Barbuda', '🇦🇬'],
    306: ['Netherlands Antilles', '🇳🇱'], 307: ['Aruba', '🇦🇼'], 308: ['Bahamas', '🇧🇸'],
    309: ['Bahamas', '🇧🇸'], 310: ['Bermuda', '🇧🇲'], 311: ['Bahamas', '🇧🇸'],
    312: ['Belize', '🇧🇿'], 314: ['Barbados', '🇧🇧'], 316: ['Canada', '🇨🇦'],
    319: ['Cayman Islands', '🇰🇾'], 321: ['Costa Rica', '🇨🇷'], 323: ['Cuba', '🇨🇺'],
    325: ['Dominica', '🇩🇲'], 327: ['Dominican Republic', '🇩🇴'],
    329: ['Guadeloupe', '🇬🇵'], 330: ['Grenada', '🇬🇩'],
    332: ['Guatemala', '🇬🇹'], 334: ['Honduras', '🇭🇳'], 336: ['Haiti', '🇭🇹'],
    338: ['USA', '🇺🇸'], 339: ['USA', '🇺🇸'],
    341: ['St Kitts & Nevis', '🇰🇳'], 343: ['St Lucia', '🇱🇨'],
    345: ['Mexico', '🇲🇽'], 347: ['Martinique', '🇲🇶'],
    348: ['Montserrat', '🇲🇸'], 350: ['Nicaragua', '🇳🇮'],
    351: ['Panama', '🇵🇦'], 352: ['Panama', '🇵🇦'], 353: ['Panama', '🇵🇦'],
    354: ['Panama', '🇵🇦'], 355: ['Panama', '🇵🇦'], 356: ['Panama', '🇵🇦'],
    357: ['Panama', '🇵🇦'],
    358: ['Puerto Rico', '🇵🇷'], 359: ['El Salvador', '🇸🇻'],
    361: ['St Pierre & Miquelon', '🇵🇲'],
    362: ['Trinidad & Tobago', '🇹🇹'], 364: ['Turks & Caicos', '🇹🇨'],
    366: ['USA', '🇺🇸'], 367: ['USA', '🇺🇸'], 368: ['USA', '🇺🇸'], 369: ['USA', '🇺🇸'],
    370: ['Panama', '🇵🇦'], 371: ['Panama', '🇵🇦'], 372: ['Panama', '🇵🇦'],
    373: ['Panama', '🇵🇦'], 374: ['Panama', '🇵🇦'], 375: ['St Vincent', '🇻🇨'],
    376: ['St Vincent', '🇻🇨'], 377: ['St Vincent', '🇻🇨'],
    378: ['British Virgin Islands', '🇻🇬'],
    379: ['US Virgin Islands', '🇻🇮'],
    // Asia
    401: ['Afghanistan', '🇦🇫'], 403: ['Saudi Arabia', '🇸🇦'],
    405: ['Bangladesh', '🇧🇩'], 408: ['Bahrain', '🇧🇭'], 410: ['Bhutan', '🇧🇹'],
    412: ['China', '🇨🇳'], 413: ['China', '🇨🇳'], 414: ['China', '🇨🇳'],
    416: ['Taiwan', '🇹🇼'], 417: ['Sri Lanka', '🇱🇰'],
    419: ['India', '🇮🇳'], 422: ['Iran', '🇮🇷'], 423: ['Azerbaijan', '🇦🇿'],
    425: ['Iraq', '🇮🇶'], 428: ['Israel', '🇮🇱'], 431: ['Japan', '🇯🇵'],
    432: ['Japan', '🇯🇵'], 434: ['Turkmenistan', '🇹🇲'], 436: ['Kazakhstan', '🇰🇿'],
    437: ['Uzbekistan', '🇺🇿'], 438: ['Jordan', '🇯🇴'],
    440: ['South Korea', '🇰🇷'], 441: ['South Korea', '🇰🇷'],
    443: ['Palestine', '🇵🇸'], 445: ['North Korea', '🇰🇵'],
    447: ['Kuwait', '🇰🇼'], 450: ['Lebanon', '🇱🇧'],
    451: ['Kyrgyzstan', '🇰🇬'], 453: ['Macao', '🇲🇴'],
    455: ['Maldives', '🇲🇻'], 457: ['Mongolia', '🇲🇳'],
    459: ['Nepal', '🇳🇵'], 461: ['Oman', '🇴🇲'],
    463: ['Pakistan', '🇵🇰'], 466: ['Qatar', '🇶🇦'],
    468: ['Syria', '🇸🇾'], 470: ['UAE', '🇦🇪'],
    472: ['Tajikistan', '🇹🇯'], 473: ['Yemen', '🇾🇪'],
    475: ['Thailand', '🇹🇭'], 477: ['Hong Kong', '🇭🇰'],
    478: ['Bosnia', '🇧🇦'],
    // Oceania
    501: ['Antarctica', '🇦🇶'], 503: ['Australia', '🇦🇺'],
    506: ['Myanmar', '🇲🇲'], 508: ['Brunei', '🇧🇳'],
    510: ['Micronesia', '🇫🇲'], 511: ['Palau', '🇵🇼'],
    512: ['New Zealand', '🇳🇿'], 514: ['Cambodia', '🇰🇭'],
    515: ['Cambodia', '🇰🇭'], 516: ['Christmas Island', '🇨🇽'],
    518: ['Cook Islands', '🇨🇰'], 520: ['Fiji', '🇫🇯'],
    521: ['Cocos Islands', '🇨🇨'], 523: ['Heard Island', '🇦🇺'],
    525: ['Indonesia', '🇮🇩'], 529: ['Kiribati', '🇰🇮'],
    531: ['Laos', '🇱🇦'], 533: ['Malaysia', '🇲🇾'],
    536: ['N. Mariana Islands', '🇲🇵'], 538: ['Marshall Islands', '🇲🇭'],
    540: ['New Caledonia', '🇳🇨'], 542: ['Niue', '🇳🇺'],
    544: ['Nauru', '🇳🇷'], 546: ['French Polynesia', '🇵🇫'],
    548: ['Philippines', '🇵🇭'], 553: ['Papua New Guinea', '🇵🇬'],
    555: ['Pitcairn', '🇵🇳'], 557: ['Solomon Islands', '🇸🇧'],
    559: ['American Samoa', '🇦🇸'], 561: ['Samoa', '🇼🇸'],
    563: ['Singapore', '🇸🇬'], 564: ['Singapore', '🇸🇬'],
    565: ['Singapore', '🇸🇬'], 566: ['Singapore', '🇸🇬'],
    567: ['Thailand', '🇹🇭'], 570: ['Tonga', '🇹🇴'],
    572: ['Tuvalu', '🇹🇻'], 574: ['Vietnam', '🇻🇳'],
    576: ['Vanuatu', '🇻🇺'], 577: ['Vanuatu', '🇻🇺'],
    578: ['Wallis & Futuna', '🇼🇫'],
    // Africa
    601: ['South Africa', '🇿🇦'], 603: ['Angola', '🇦🇴'],
    605: ['Algeria', '🇩🇿'], 607: ['St Paul (France)', '🇫🇷'],
    608: ['Ascension', '🇬🇧'], 609: ['Burundi', '🇧🇮'],
    610: ['Benin', '🇧🇯'], 611: ['Botswana', '🇧🇼'],
    612: ['Central African Rep.', '🇨🇫'], 613: ['Cameroon', '🇨🇲'],
    615: ['Congo', '🇨🇬'], 616: ['Comoros', '🇰🇲'],
    617: ['Cabo Verde', '🇨🇻'], 618: ['Crozet (France)', '🇫🇷'],
    619: ['Ivory Coast', '🇨🇮'], 620: ['Comoros', '🇰🇲'],
    621: ['Djibouti', '🇩🇯'], 622: ['Egypt', '🇪🇬'],
    624: ['Ethiopia', '🇪🇹'], 625: ['Eritrea', '🇪🇷'],
    626: ['Gabon', '🇬🇦'], 627: ['Ghana', '🇬🇭'],
    629: ['Gambia', '🇬🇲'], 630: ['Guinea-Bissau', '🇬🇼'],
    631: ['Equatorial Guinea', '🇬🇶'], 632: ['Guinea', '🇬🇳'],
    633: ['Burkina Faso', '🇧🇫'], 634: ['Kenya', '🇰🇪'],
    635: ['Kerguelen (France)', '🇫🇷'], 636: ['Liberia', '🇱🇷'],
    637: ['Liberia', '🇱🇷'], 642: ['Libya', '🇱🇾'],
    644: ['Lesotho', '🇱🇸'], 645: ['Mauritius', '🇲🇺'],
    647: ['Madagascar', '🇲🇬'], 649: ['Mali', '🇲🇱'],
    650: ['Mozambique', '🇲🇿'], 654: ['Mauritania', '🇲🇷'],
    655: ['Malawi', '🇲🇼'], 656: ['Niger', '🇳🇪'],
    657: ['Nigeria', '🇳🇬'], 659: ['Namibia', '🇳🇦'],
    660: ['Reunion (France)', '🇫🇷'], 661: ['Rwanda', '🇷🇼'],
    662: ['Sudan', '🇸🇩'], 663: ['Senegal', '🇸🇳'],
    664: ['Seychelles', '🇸🇨'], 665: ['St Helena', '🇬🇧'],
    666: ['Somalia', '🇸🇴'], 667: ['Sierra Leone', '🇸🇱'],
    668: ['São Tomé', '🇸🇹'], 669: ['Eswatini', '🇸🇿'],
    670: ['Chad', '🇹🇩'], 671: ['Togo', '🇹🇬'],
    672: ['Tunisia', '🇹🇳'], 674: ['Tanzania', '🇹🇿'],
    675: ['Uganda', '🇺🇬'], 676: ['DR Congo', '🇨🇩'],
    677: ['Tanzania', '🇹🇿'], 678: ['Zambia', '🇿🇲'],
    679: ['Zimbabwe', '🇿🇼'],
};

// ── AIS Ship Type decoder (ITU-R M.1371 Table 50) ──
function decodeShipType(code: number): string {
    if (code >= 20 && code <= 29) return 'Wing in Ground';
    if (code === 30) return 'Fishing';
    if (code === 31 || code === 32) return 'Towing';
    if (code === 33) return 'Dredger';
    if (code === 34) return 'Diving Operations';
    if (code === 35) return 'Military Operations';
    if (code === 36) return 'Sailing Vessel';
    if (code === 37) return 'Pleasure Craft';
    if (code >= 40 && code <= 49) return 'High Speed Craft';
    if (code === 50) return 'Pilot Vessel';
    if (code === 51) return 'Search & Rescue';
    if (code === 52) return 'Tug';
    if (code === 53) return 'Port Tender';
    if (code === 54) return 'Anti-Pollution';
    if (code === 55) return 'Law Enforcement';
    if (code === 58) return 'Medical Transport';
    if (code === 59) return 'Non-Combatant';
    if (code >= 60 && code <= 69) return 'Passenger';
    if (code >= 70 && code <= 79) return 'Cargo';
    if (code >= 80 && code <= 89) return 'Tanker';
    if (code >= 90 && code <= 99) return 'Other';
    return 'Vessel';
}

/**
 * Batch seed vessel_metadata from the existing `vessels` table.
 * Runs in batches of 500 to avoid timeout.
 */
export async function seedFromAis(mmsis: number[]): Promise<number> {
    console.log(`[AIS-SEED] Seeding ${mmsis.length} vessels from AIS data...`);
    const results: VesselMetadataRow[] = [];

    // Fetch all vessel data in one query (up to 200)
    const { data: vessels, error } = await supabase
        .from('vessels')
        .select('mmsi, name, call_sign, ship_type, imo_number, dimension_a, dimension_b, dimension_c, dimension_d')
        .in('mmsi', mmsis);

    if (error || !vessels) {
        console.error('[AIS-SEED] Failed to fetch vessels:', error?.message);
        return 0;
    }

    for (const v of vessels) {
        const mid = getMid(v.mmsi);
        const country = MID_COUNTRY[mid];

        // Calculate LOA (dimension_a + dimension_b) and Beam (dimension_c + dimension_d)
        const loa = (v.dimension_a && v.dimension_b) ? v.dimension_a + v.dimension_b : null;
        const beam = (v.dimension_c && v.dimension_d) ? v.dimension_c + v.dimension_d : null;

        results.push({
            mmsi: v.mmsi,
            vessel_name: v.name || null,
            vessel_type: v.ship_type ? decodeShipType(v.ship_type) : null,
            flag_country: country?.[0] ?? null,
            flag_emoji: country?.[1] ?? null,
            call_sign: v.call_sign || null,
            imo_number: v.imo_number || null,
            loa: loa ? loa : null,
            beam: beam ? beam : null,
            data_source: 'AIS',
            is_verified: false,
        });
    }

    const upserted = await upsertMetadata(results);
    console.log(`[AIS-SEED] Upserted ${upserted} vessels from AIS data`);
    return upserted;
}
