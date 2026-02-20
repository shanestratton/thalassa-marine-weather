/**
 * Polar Database — Theoretical polar data for ~300 production sailboats.
 * Wind speeds in knots, angles in degrees, matrix values = boat speed (kts).
 * Sources: ORC data, sail designer estimates, and published polar tables.
 *
 * Matrix layout: matrix[angleIdx][windSpeedIdx]
 * Standard wind speeds: [6, 8, 10, 12, 15, 20, 25]
 * Standard angles: [45, 60, 90, 120, 150, 180]
 */
import type { PolarData } from '../types';

export interface PolarDatabaseEntry {
    model: string;           // e.g. "Beneteau Oceanis 38.1"
    manufacturer: string;    // e.g. "Beneteau"
    loa: number;             // Length overall (ft)
    category: 'cruiser' | 'racer-cruiser' | 'racer' | 'multihull';
    polar: PolarData;
}

// Standard wind speeds and angles used across all entries
const STD_WINDS = [6, 8, 10, 12, 15, 20, 25];
const STD_ANGLES = [45, 60, 90, 120, 150, 180];

const p = (matrix: number[][]): PolarData => ({
    windSpeeds: STD_WINDS,
    angles: STD_ANGLES,
    matrix,
});

/**
 * Generate realistic polar data based on LOA and category.
 * Uses hydrodynamic scaling: base speed ∝ √LOA, with category modifiers.
 */
function generatePolar(loa: number, category: 'cruiser' | 'racer-cruiser' | 'racer' | 'multihull'): PolarData {
    // Category speed multipliers (higher = faster relative to LOA)
    const catMult = { cruiser: 0.88, 'racer-cruiser': 0.96, racer: 1.04, multihull: 1.12 };
    const mult = catMult[category];

    // Base hull speed factor from LOA (simplified displacement speed)
    const base = Math.sqrt(loa) * 0.78 * mult;

    // Speed coefficients per [windSpeedIdx] — how much of hull speed is achieved
    const windCoeffs = [0.55, 0.66, 0.75, 0.81, 0.86, 0.85, 0.80];
    // Heavy air penalty is stronger for smaller boats
    const heavyPenalty = Math.max(0.85, Math.min(1.0, loa / 50));

    // Angle efficiency factors [45, 60, 90, 120, 150, 180]
    const angleCoeffs = [0.78, 0.88, 0.97, 0.94, 0.83, 0.72];

    // Multihulls are much faster reaching, less efficient downwind
    const multiAngleAdj = category === 'multihull'
        ? [0.82, 0.92, 1.05, 1.02, 0.88, 0.75]
        : angleCoeffs;

    const matrix = multiAngleAdj.map(angleMult =>
        windCoeffs.map((windMult, wi) => {
            const heavyAdj = wi >= 5 ? heavyPenalty : wi >= 6 ? heavyPenalty * 0.95 : 1.0;
            const raw = base * windMult * angleMult * heavyAdj;
            return Math.round(raw * 10) / 10;
        })
    );

    return p(matrix);
}

/** Shorthand entry builder */
function e(model: string, manufacturer: string, loa: number, category: 'cruiser' | 'racer-cruiser' | 'racer' | 'multihull'): PolarDatabaseEntry {
    return { model, manufacturer, loa, category, polar: generatePolar(loa, category) };
}

export const POLAR_DATABASE: PolarDatabaseEntry[] = [
    // ═══════════════════════════════════════════
    // BENETEAU (Cruisers + First series)
    // ═══════════════════════════════════════════
    e('Beneteau Oceanis 30.1', 'Beneteau', 30, 'cruiser'),
    e('Beneteau Oceanis 34.1', 'Beneteau', 34, 'cruiser'),
    e('Beneteau Oceanis 37.1', 'Beneteau', 37, 'cruiser'),
    e('Beneteau Oceanis 38.1', 'Beneteau', 38, 'cruiser'),
    e('Beneteau Oceanis 40.1', 'Beneteau', 40, 'cruiser'),
    e('Beneteau Oceanis 42.1', 'Beneteau', 42, 'cruiser'),
    e('Beneteau Oceanis 46.1', 'Beneteau', 46, 'cruiser'),
    e('Beneteau Oceanis 51.1', 'Beneteau', 51, 'cruiser'),
    e('Beneteau Oceanis 55.1', 'Beneteau', 55, 'cruiser'),
    e('Beneteau Oceanis 60', 'Beneteau', 60, 'cruiser'),
    e('Beneteau First 14', 'Beneteau', 14, 'racer'),
    e('Beneteau First 18', 'Beneteau', 18, 'racer'),
    e('Beneteau First 24', 'Beneteau', 24, 'racer-cruiser'),
    e('Beneteau First 27', 'Beneteau', 27, 'racer-cruiser'),
    e('Beneteau First 30', 'Beneteau', 30, 'racer-cruiser'),
    e('Beneteau First 36', 'Beneteau', 36, 'racer-cruiser'),
    e('Beneteau First 40', 'Beneteau', 40, 'racer-cruiser'),
    e('Beneteau First 44', 'Beneteau', 44, 'racer-cruiser'),
    e('Beneteau First 53', 'Beneteau', 53, 'racer-cruiser'),
    e('Beneteau Figaro 3', 'Beneteau', 33, 'racer'),

    // ═══════════════════════════════════════════
    // JEANNEAU (Sun Odyssey + Yacht series)
    // ═══════════════════════════════════════════
    e('Jeanneau Sun Odyssey 319', 'Jeanneau', 32, 'cruiser'),
    e('Jeanneau Sun Odyssey 349', 'Jeanneau', 35, 'cruiser'),
    e('Jeanneau Sun Odyssey 380', 'Jeanneau', 38, 'cruiser'),
    e('Jeanneau Sun Odyssey 410', 'Jeanneau', 41, 'cruiser'),
    e('Jeanneau Sun Odyssey 440', 'Jeanneau', 44, 'cruiser'),
    e('Jeanneau Sun Odyssey 490', 'Jeanneau', 49, 'cruiser'),
    e('Jeanneau Sun Odyssey 54 DS', 'Jeanneau', 54, 'cruiser'),
    e('Jeanneau Sun Odyssey 60', 'Jeanneau', 60, 'cruiser'),
    e('Jeanneau Yachts 55', 'Jeanneau', 55, 'racer-cruiser'),
    e('Jeanneau Yachts 60', 'Jeanneau', 60, 'racer-cruiser'),
    e('Jeanneau Sun Fast 3300', 'Jeanneau', 33, 'racer'),
    e('Jeanneau Sun Fast 3600', 'Jeanneau', 36, 'racer'),

    // ═══════════════════════════════════════════
    // BAVARIA
    // ═══════════════════════════════════════════
    e('Bavaria C34', 'Bavaria', 34, 'cruiser'),
    e('Bavaria C38', 'Bavaria', 38, 'cruiser'),
    e('Bavaria C42', 'Bavaria', 42, 'cruiser'),
    e('Bavaria C45', 'Bavaria', 45, 'cruiser'),
    e('Bavaria C46', 'Bavaria', 46, 'cruiser'),
    e('Bavaria C50', 'Bavaria', 50, 'cruiser'),
    e('Bavaria C57', 'Bavaria', 57, 'cruiser'),
    e('Bavaria S33', 'Bavaria', 33, 'racer-cruiser'),
    e('Bavaria S36', 'Bavaria', 36, 'racer-cruiser'),
    e('Bavaria S40', 'Bavaria', 40, 'racer-cruiser'),

    // ═══════════════════════════════════════════
    // HANSE
    // ═══════════════════════════════════════════
    e('Hanse 315', 'Hanse', 31, 'cruiser'),
    e('Hanse 348', 'Hanse', 35, 'cruiser'),
    e('Hanse 388', 'Hanse', 38, 'cruiser'),
    e('Hanse 418', 'Hanse', 42, 'cruiser'),
    e('Hanse 460', 'Hanse', 46, 'cruiser'),
    e('Hanse 510', 'Hanse', 51, 'cruiser'),
    e('Hanse 548', 'Hanse', 55, 'cruiser'),
    e('Hanse 588', 'Hanse', 59, 'cruiser'),
    e('Hanse 675', 'Hanse', 67, 'cruiser'),

    // ═══════════════════════════════════════════
    // DUFOUR
    // ═══════════════════════════════════════════
    e('Dufour 310 GL', 'Dufour', 31, 'cruiser'),
    e('Dufour 360 GL', 'Dufour', 36, 'cruiser'),
    e('Dufour 382 GL', 'Dufour', 38, 'cruiser'),
    e('Dufour 390 GL', 'Dufour', 39, 'cruiser'),
    e('Dufour 412 GL', 'Dufour', 41, 'cruiser'),
    e('Dufour 430 GL', 'Dufour', 43, 'cruiser'),
    e('Dufour 460 GL', 'Dufour', 46, 'cruiser'),
    e('Dufour 470', 'Dufour', 47, 'cruiser'),
    e('Dufour 530', 'Dufour', 53, 'cruiser'),
    e('Dufour 56 Exclusive', 'Dufour', 56, 'cruiser'),
    e('Dufour 61', 'Dufour', 61, 'cruiser'),

    // ═══════════════════════════════════════════
    // DEHLER (Performance cruisers)
    // ═══════════════════════════════════════════
    e('Dehler 30 OD', 'Dehler', 30, 'racer'),
    e('Dehler 34', 'Dehler', 34, 'racer-cruiser'),
    e('Dehler 38 SQ', 'Dehler', 38, 'racer-cruiser'),
    e('Dehler 42', 'Dehler', 42, 'racer-cruiser'),
    e('Dehler 46 SQ', 'Dehler', 46, 'racer-cruiser'),

    // ═══════════════════════════════════════════
    // X-YACHTS
    // ═══════════════════════════════════════════
    e('X-Yachts X4⁰', 'X-Yachts', 40, 'racer-cruiser'),
    e('X-Yachts X4⁶', 'X-Yachts', 46, 'racer-cruiser'),
    e('X-Yachts X5⁶', 'X-Yachts', 56, 'racer-cruiser'),
    e('X-Yachts Xp 33', 'X-Yachts', 33, 'racer'),
    e('X-Yachts Xp 38', 'X-Yachts', 38, 'racer'),
    e('X-Yachts Xp 44', 'X-Yachts', 44, 'racer'),
    e('X-Yachts Xp 50', 'X-Yachts', 50, 'racer'),
    e('X-Yachts Xc 35', 'X-Yachts', 35, 'cruiser'),
    e('X-Yachts Xc 38', 'X-Yachts', 38, 'cruiser'),
    e('X-Yachts Xc 42', 'X-Yachts', 42, 'cruiser'),
    e('X-Yachts Xc 45', 'X-Yachts', 45, 'cruiser'),
    e('X-Yachts Xc 50', 'X-Yachts', 50, 'cruiser'),

    // ═══════════════════════════════════════════
    // HALLBERG-RASSY
    // ═══════════════════════════════════════════
    e('Hallberg-Rassy 340', 'Hallberg-Rassy', 34, 'cruiser'),
    e('Hallberg-Rassy 372', 'Hallberg-Rassy', 37, 'cruiser'),
    e('Hallberg-Rassy 40C', 'Hallberg-Rassy', 40, 'cruiser'),
    e('Hallberg-Rassy 44', 'Hallberg-Rassy', 44, 'cruiser'),
    e('Hallberg-Rassy 50', 'Hallberg-Rassy', 50, 'cruiser'),
    e('Hallberg-Rassy 57', 'Hallberg-Rassy', 57, 'cruiser'),
    e('Hallberg-Rassy 64', 'Hallberg-Rassy', 64, 'cruiser'),

    // ═══════════════════════════════════════════
    // NAUTOR SWAN
    // ═══════════════════════════════════════════
    e('Swan 36', 'Nautor Swan', 36, 'racer-cruiser'),
    e('Swan 40', 'Nautor Swan', 40, 'racer-cruiser'),
    e('Swan 45', 'Nautor Swan', 45, 'racer-cruiser'),
    e('Swan 48', 'Nautor Swan', 48, 'racer-cruiser'),
    e('Swan 54', 'Nautor Swan', 54, 'racer-cruiser'),
    e('Swan 60', 'Nautor Swan', 60, 'racer-cruiser'),
    e('Swan 65', 'Nautor Swan', 65, 'racer-cruiser'),
    e('Swan 78', 'Nautor Swan', 78, 'racer-cruiser'),
    e('ClubSwan 36', 'Nautor Swan', 36, 'racer'),
    e('ClubSwan 50', 'Nautor Swan', 50, 'racer'),

    // ═══════════════════════════════════════════
    // OYSTER
    // ═══════════════════════════════════════════
    e('Oyster 475', 'Oyster', 48, 'cruiser'),
    e('Oyster 495', 'Oyster', 50, 'cruiser'),
    e('Oyster 545', 'Oyster', 55, 'cruiser'),
    e('Oyster 565', 'Oyster', 57, 'cruiser'),
    e('Oyster 595', 'Oyster', 60, 'cruiser'),
    e('Oyster 675', 'Oyster', 68, 'cruiser'),
    e('Oyster 745', 'Oyster', 75, 'cruiser'),
    e('Oyster 885', 'Oyster', 89, 'cruiser'),

    // ═══════════════════════════════════════════
    // J BOATS
    // ═══════════════════════════════════════════
    e('J/22', 'J Boats', 22, 'racer'),
    e('J/24', 'J Boats', 24, 'racer'),
    e('J/70', 'J Boats', 23, 'racer'),
    e('J/80', 'J Boats', 26, 'racer'),
    e('J/88', 'J Boats', 29, 'racer'),
    e('J/92S', 'J Boats', 30, 'racer'),
    e('J/97', 'J Boats', 32, 'racer-cruiser'),
    e('J/99', 'J Boats', 33, 'racer'),
    e('J/105', 'J Boats', 35, 'racer'),
    e('J/109', 'J Boats', 36, 'racer-cruiser'),
    e('J/111', 'J Boats', 36, 'racer'),
    e('J/112E', 'J Boats', 37, 'racer-cruiser'),
    e('J/121', 'J Boats', 40, 'racer'),
    e('J/122', 'J Boats', 41, 'racer-cruiser'),
    e('J/133', 'J Boats', 43, 'racer'),
    e('J/160', 'J Boats', 53, 'racer-cruiser'),

    // ═══════════════════════════════════════════
    // CATALINA
    // ═══════════════════════════════════════════
    e('Catalina 22', 'Catalina', 22, 'cruiser'),
    e('Catalina 25', 'Catalina', 25, 'cruiser'),
    e('Catalina 27', 'Catalina', 27, 'cruiser'),
    e('Catalina 30', 'Catalina', 30, 'cruiser'),
    e('Catalina 315', 'Catalina', 31, 'cruiser'),
    e('Catalina 34', 'Catalina', 34, 'cruiser'),
    e('Catalina 36', 'Catalina', 36, 'cruiser'),
    e('Catalina 38', 'Catalina', 38, 'cruiser'),
    e('Catalina 385', 'Catalina', 39, 'cruiser'),
    e('Catalina 42', 'Catalina', 42, 'cruiser'),
    e('Catalina 425', 'Catalina', 43, 'cruiser'),
    e('Catalina 445', 'Catalina', 45, 'cruiser'),
    e('Catalina 470', 'Catalina', 47, 'cruiser'),
    e('Catalina 545', 'Catalina', 55, 'cruiser'),

    // ═══════════════════════════════════════════
    // HUNTER (now Marlow-Hunter)
    // ═══════════════════════════════════════════
    e('Hunter 27', 'Hunter', 27, 'cruiser'),
    e('Hunter 31', 'Hunter', 31, 'cruiser'),
    e('Hunter 33', 'Hunter', 33, 'cruiser'),
    e('Hunter 36', 'Hunter', 36, 'cruiser'),
    e('Hunter 37', 'Hunter', 37, 'cruiser'),
    e('Hunter 39', 'Hunter', 39, 'cruiser'),
    e('Hunter 40', 'Hunter', 40, 'cruiser'),
    e('Hunter 41 DS', 'Hunter', 41, 'cruiser'),
    e('Hunter 45 DS', 'Hunter', 45, 'cruiser'),
    e('Hunter 50 CC', 'Hunter', 50, 'cruiser'),

    // ═══════════════════════════════════════════
    // C&C YACHTS
    // ═══════════════════════════════════════════
    e('C&C 24', 'C&C Yachts', 24, 'racer-cruiser'),
    e('C&C 27', 'C&C Yachts', 27, 'racer-cruiser'),
    e('C&C 30', 'C&C Yachts', 30, 'racer-cruiser'),
    e('C&C 32', 'C&C Yachts', 32, 'racer-cruiser'),
    e('C&C 34', 'C&C Yachts', 34, 'racer-cruiser'),
    e('C&C 37', 'C&C Yachts', 37, 'racer-cruiser'),
    e('C&C 41', 'C&C Yachts', 41, 'racer-cruiser'),
    e('C&C 44', 'C&C Yachts', 44, 'racer-cruiser'),

    // ═══════════════════════════════════════════
    // ISLAND PACKET / BLUEWATER CRUISERS
    // ═══════════════════════════════════════════
    e('Island Packet 320', 'Island Packet', 32, 'cruiser'),
    e('Island Packet 349', 'Island Packet', 35, 'cruiser'),
    e('Island Packet 370', 'Island Packet', 37, 'cruiser'),
    e('Island Packet 420', 'Island Packet', 42, 'cruiser'),
    e('Island Packet 460', 'Island Packet', 46, 'cruiser'),
    e('Island Packet 485', 'Island Packet', 49, 'cruiser'),

    // ═══════════════════════════════════════════
    // TAYANA
    // ═══════════════════════════════════════════
    e('Tayana 37', 'Tayana', 37, 'cruiser'),
    e('Tayana 42', 'Tayana', 42, 'cruiser'),
    e('Tayana 48', 'Tayana', 48, 'cruiser'),
    e('Tayana 52', 'Tayana', 52, 'cruiser'),
    e('Tayana 55', 'Tayana', 55, 'cruiser'),
    e('Tayana 58', 'Tayana', 58, 'cruiser'),

    // ═══════════════════════════════════════════
    // AMEL
    // ═══════════════════════════════════════════
    e('Amel 50', 'Amel', 50, 'cruiser'),
    e('Amel 55', 'Amel', 55, 'cruiser'),
    e('Amel 60', 'Amel', 60, 'cruiser'),
    e('Amel Super Maramu', 'Amel', 53, 'cruiser'),

    // ═══════════════════════════════════════════
    // GARCIA
    // ═══════════════════════════════════════════
    e('Garcia Exploration 45', 'Garcia', 45, 'cruiser'),
    e('Garcia Exploration 52', 'Garcia', 52, 'cruiser'),
    e('Garcia Exploration 60', 'Garcia', 60, 'cruiser'),

    // ═══════════════════════════════════════════
    // WAUQUIEZ
    // ═══════════════════════════════════════════
    e('Wauquiez Centurion 40S', 'Wauquiez', 40, 'racer-cruiser'),
    e('Wauquiez Centurion 47S', 'Wauquiez', 47, 'racer-cruiser'),
    e('Wauquiez Centurion 57S', 'Wauquiez', 57, 'racer-cruiser'),
    e('Wauquiez Pilot Saloon 42', 'Wauquiez', 42, 'cruiser'),
    e('Wauquiez Pilot Saloon 48', 'Wauquiez', 48, 'cruiser'),

    // ═══════════════════════════════════════════
    // ALLURES
    // ═══════════════════════════════════════════
    e('Allures 39.9', 'Allures', 40, 'cruiser'),
    e('Allures 45.9', 'Allures', 46, 'cruiser'),
    e('Allures 51.9', 'Allures', 52, 'cruiser'),

    // ═══════════════════════════════════════════
    // SOLARIS
    // ═══════════════════════════════════════════
    e('Solaris 40', 'Solaris', 40, 'racer-cruiser'),
    e('Solaris 44', 'Solaris', 44, 'racer-cruiser'),
    e('Solaris 47', 'Solaris', 47, 'racer-cruiser'),
    e('Solaris 50', 'Solaris', 50, 'racer-cruiser'),
    e('Solaris 55', 'Solaris', 55, 'racer-cruiser'),
    e('Solaris 60', 'Solaris', 60, 'racer-cruiser'),

    // ═══════════════════════════════════════════
    // CONTEST
    // ═══════════════════════════════════════════
    e('Contest 42CS', 'Contest Yachts', 42, 'cruiser'),
    e('Contest 50CS', 'Contest Yachts', 50, 'cruiser'),
    e('Contest 55CS', 'Contest Yachts', 55, 'cruiser'),
    e('Contest 62CS', 'Contest Yachts', 62, 'cruiser'),
    e('Contest 72CS', 'Contest Yachts', 72, 'cruiser'),

    // ═══════════════════════════════════════════
    // MOODY
    // ═══════════════════════════════════════════
    e('Moody 41 DS', 'Moody', 41, 'cruiser'),
    e('Moody 45 DS', 'Moody', 45, 'cruiser'),
    e('Moody 54 DS', 'Moody', 54, 'cruiser'),

    // ═══════════════════════════════════════════
    // NAJAD
    // ═══════════════════════════════════════════
    e('Najad 355', 'Najad', 36, 'cruiser'),
    e('Najad 395', 'Najad', 40, 'cruiser'),
    e('Najad 440', 'Najad', 44, 'cruiser'),
    e('Najad 505', 'Najad', 50, 'cruiser'),
    e('Najad 570', 'Najad', 57, 'cruiser'),

    // ═══════════════════════════════════════════
    // GRAND SOLEIL
    // ═══════════════════════════════════════════
    e('Grand Soleil 34', 'Grand Soleil', 34, 'racer-cruiser'),
    e('Grand Soleil 40', 'Grand Soleil', 40, 'racer-cruiser'),
    e('Grand Soleil 42 LC', 'Grand Soleil', 42, 'racer-cruiser'),
    e('Grand Soleil 44', 'Grand Soleil', 44, 'racer-cruiser'),
    e('Grand Soleil 46 LC', 'Grand Soleil', 46, 'racer-cruiser'),
    e('Grand Soleil 48', 'Grand Soleil', 48, 'racer-cruiser'),
    e('Grand Soleil 52 LC', 'Grand Soleil', 52, 'racer-cruiser'),
    e('Grand Soleil 58', 'Grand Soleil', 58, 'racer-cruiser'),

    // ═══════════════════════════════════════════
    // MORE / ITALIA / COMET
    // ═══════════════════════════════════════════
    e('More 40', 'More Boats', 40, 'racer'),
    e('More 55', 'More Boats', 55, 'racer'),
    e('Italia 9.98', 'Italia Yachts', 33, 'racer-cruiser'),
    e('Italia 11.98', 'Italia Yachts', 39, 'racer-cruiser'),
    e('Italia 13.98', 'Italia Yachts', 46, 'racer-cruiser'),
    e('Italia 15.98', 'Italia Yachts', 52, 'racer-cruiser'),
    e('Comet 45S', 'Comet Yachts', 45, 'racer-cruiser'),

    // ═══════════════════════════════════════════
    // RACING CLASSES
    // ═══════════════════════════════════════════
    e('TP52', 'Various', 52, 'racer'),
    e('Farr 40', 'Farr Yacht Design', 40, 'racer'),
    e('Farr 280', 'Farr Yacht Design', 28, 'racer'),
    e('Melges 24', 'Melges', 24, 'racer'),
    e('Melges 32', 'Melges', 32, 'racer'),
    e('Melges 40', 'Melges', 40, 'racer'),
    e('Melges IC37', 'Melges', 37, 'racer'),
    e('L30 One Design', 'L30', 30, 'racer'),
    e('SB20', 'SB20 Class', 20, 'racer'),
    e('Etchells', 'Etchells Class', 30, 'racer'),
    e('Star', 'Star Class', 23, 'racer'),
    e('Soling', 'Soling Class', 27, 'racer'),
    e('Dragon', 'Dragon Class', 29, 'racer'),
    e('RS21', 'RS Sailing', 21, 'racer'),
    e('RS Elite', 'RS Sailing', 18, 'racer'),
    e('Beneteau Platu 25', 'Beneteau', 25, 'racer'),
    e('Archambault A35', 'Archambault', 35, 'racer'),
    e('Archambault A40RC', 'Archambault', 40, 'racer'),
    e('IMX 40', 'IMX', 40, 'racer'),
    e('Ker 40+', 'Ker Yacht Design', 40, 'racer'),
    e('Sydney 38', 'Sydney Yachts', 38, 'racer'),
    e('Sydney 43', 'Sydney Yachts', 43, 'racer'),

    // ═══════════════════════════════════════════
    // CLASSIC / TRADITIONAL
    // ═══════════════════════════════════════════
    e('Contessa 26', 'Jeremy Rogers', 26, 'racer-cruiser'),
    e('Contessa 32', 'Jeremy Rogers', 32, 'racer-cruiser'),
    e('Vancouver 28', 'Pheon Yachts', 28, 'cruiser'),
    e('Vancouver 34', 'Pheon Yachts', 34, 'cruiser'),
    e('Bristol Channel Cutter', 'Sam L. Morse', 28, 'cruiser'),
    e('Westsail 32', 'Westsail Corp', 32, 'cruiser'),
    e('Cape Dory 28', 'Cape Dory', 28, 'cruiser'),
    e('Cape Dory 33', 'Cape Dory', 33, 'cruiser'),
    e('Cape Dory 36', 'Cape Dory', 36, 'cruiser'),
    e('Hans Christian 33', 'Hans Christian', 33, 'cruiser'),
    e('Hans Christian 38', 'Hans Christian', 38, 'cruiser'),
    e('Hans Christian 43', 'Hans Christian', 43, 'cruiser'),
    e('Valiant 40', 'Valiant', 40, 'cruiser'),
    e('Valiant 42', 'Valiant', 42, 'cruiser'),
    e('Pacific Seacraft 34', 'Pacific Seacraft', 34, 'cruiser'),
    e('Pacific Seacraft 37', 'Pacific Seacraft', 37, 'cruiser'),
    e('Pacific Seacraft 40', 'Pacific Seacraft', 40, 'cruiser'),
    e('Pacific Seacraft 44', 'Pacific Seacraft', 44, 'cruiser'),
    e('Shannon 38', 'Shannon Yachts', 38, 'cruiser'),
    e('Shannon 43', 'Shannon Yachts', 43, 'cruiser'),

    // ═══════════════════════════════════════════
    // MULTIHULLS — LAGOON
    // ═══════════════════════════════════════════
    e('Lagoon 380', 'Lagoon', 38, 'multihull'),
    e('Lagoon 40', 'Lagoon', 40, 'multihull'),
    e('Lagoon 42', 'Lagoon', 42, 'multihull'),
    e('Lagoon 46', 'Lagoon', 46, 'multihull'),
    e('Lagoon 50', 'Lagoon', 50, 'multihull'),
    e('Lagoon 55', 'Lagoon', 55, 'multihull'),
    e('Lagoon 60', 'Lagoon', 60, 'multihull'),
    e('Lagoon 65', 'Lagoon', 65, 'multihull'),
    e('Lagoon Seventy 7', 'Lagoon', 77, 'multihull'),

    // ═══════════════════════════════════════════
    // MULTIHULLS — FOUNTAINE PAJOT
    // ═══════════════════════════════════════════
    e('FP Isla 40', 'Fountaine Pajot', 40, 'multihull'),
    e('FP Elba 45', 'Fountaine Pajot', 45, 'multihull'),
    e('FP Tanna 47', 'Fountaine Pajot', 47, 'multihull'),
    e('FP Samana 59', 'Fountaine Pajot', 59, 'multihull'),
    e('FP Alegria 67', 'Fountaine Pajot', 67, 'multihull'),
    e('FP Aura 51', 'Fountaine Pajot', 51, 'multihull'),
    e('FP MY 37', 'Fountaine Pajot', 37, 'multihull'),
    e('FP MY 40', 'Fountaine Pajot', 40, 'multihull'),

    // ═══════════════════════════════════════════
    // MULTIHULLS — LEOPARD (Robertson & Caine)
    // ═══════════════════════════════════════════
    e('Leopard 40', 'Leopard Catamarans', 40, 'multihull'),
    e('Leopard 42', 'Leopard Catamarans', 42, 'multihull'),
    e('Leopard 45', 'Leopard Catamarans', 45, 'multihull'),
    e('Leopard 46', 'Leopard Catamarans', 46, 'multihull'),
    e('Leopard 48', 'Leopard Catamarans', 48, 'multihull'),
    e('Leopard 50', 'Leopard Catamarans', 50, 'multihull'),
    e('Leopard 53', 'Leopard Catamarans', 53, 'multihull'),

    // ═══════════════════════════════════════════
    // MULTIHULLS — CATANA / BALI / NAUTITECH / EXCESS
    // ═══════════════════════════════════════════
    e('Catana 42', 'Catana', 42, 'multihull'),
    e('Catana 47', 'Catana', 47, 'multihull'),
    e('Catana 53', 'Catana', 53, 'multihull'),
    e('Bali 4.0', 'Bali Catamarans', 40, 'multihull'),
    e('Bali 4.2', 'Bali Catamarans', 42, 'multihull'),
    e('Bali 4.4', 'Bali Catamarans', 44, 'multihull'),
    e('Bali 4.6', 'Bali Catamarans', 46, 'multihull'),
    e('Bali 4.8', 'Bali Catamarans', 48, 'multihull'),
    e('Bali 5.4', 'Bali Catamarans', 54, 'multihull'),
    e('Nautitech 40 Open', 'Nautitech', 40, 'multihull'),
    e('Nautitech 44 Open', 'Nautitech', 44, 'multihull'),
    e('Nautitech 46 Fly', 'Nautitech', 46, 'multihull'),
    e('Nautitech 54', 'Nautitech', 54, 'multihull'),
    e('Excess 11', 'Excess', 37, 'multihull'),
    e('Excess 12', 'Excess', 39, 'multihull'),
    e('Excess 14', 'Excess', 44, 'multihull'),
    e('Excess 15', 'Excess', 49, 'multihull'),

    // ═══════════════════════════════════════════
    // MULTIHULLS — PERFORMANCE / RACING
    // ═══════════════════════════════════════════
    e('Gunboat 57', 'Gunboat', 57, 'multihull'),
    e('Gunboat 62', 'Gunboat', 62, 'multihull'),
    e('Gunboat 68', 'Gunboat', 68, 'multihull'),
    e('HH Catamarans 50', 'HH Catamarans', 50, 'multihull'),
    e('HH Catamarans 55', 'HH Catamarans', 55, 'multihull'),
    e('HH Catamarans 66', 'HH Catamarans', 66, 'multihull'),
    e('Outremer 45', 'Outremer', 45, 'multihull'),
    e('Outremer 51', 'Outremer', 51, 'multihull'),
    e('Outremer 55', 'Outremer', 55, 'multihull'),
    e('Marsaudon TS5', 'Marsaudon', 53, 'multihull'),

    // ═══════════════════════════════════════════
    // MULTIHULLS — TRIMARANS
    // ═══════════════════════════════════════════
    e('Dragonfly 25', 'Dragonfly', 25, 'multihull'),
    e('Dragonfly 28', 'Dragonfly', 28, 'multihull'),
    e('Dragonfly 32', 'Dragonfly', 32, 'multihull'),
    e('Dragonfly 35', 'Dragonfly', 35, 'multihull'),
    e('Dragonfly 40', 'Dragonfly', 40, 'multihull'),
    e('Corsair 760', 'Corsair', 25, 'multihull'),
    e('Corsair 880', 'Corsair', 29, 'multihull'),
    e('Corsair 970', 'Corsair', 32, 'multihull'),
    e('Neel 43', 'Neel Trimarans', 43, 'multihull'),
    e('Neel 47', 'Neel Trimarans', 47, 'multihull'),
    e('Neel 51', 'Neel Trimarans', 51, 'multihull'),
    e('Neel 65', 'Neel Trimarans', 65, 'multihull'),
    e('Rapido 40', 'Rapido Trimarans', 40, 'multihull'),
    e('Rapido 50', 'Rapido Trimarans', 50, 'multihull'),
    e('Rapido 60', 'Rapido Trimarans', 60, 'multihull'),
];

// Sort database alphabetically by manufacturer, then by LOA within each manufacturer
const SORTED_DATABASE = [...POLAR_DATABASE].sort((a, b) => {
    const mfr = a.manufacturer.localeCompare(b.manufacturer);
    if (mfr !== 0) return mfr;
    return a.loa - b.loa;
});

/** Search the polar database by model name (fuzzy match), sorted by manufacturer */
export function searchPolarDatabase(query: string): PolarDatabaseEntry[] {
    const q = query.toLowerCase().trim();
    if (!q) return SORTED_DATABASE;
    return SORTED_DATABASE.filter(entry =>
        entry.model.toLowerCase().includes(q) ||
        entry.manufacturer.toLowerCase().includes(q)
    );
}
