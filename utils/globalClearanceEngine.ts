/**
 * GlobalClearanceEngine — Universal Customs PDF Export.
 *
 * Generates port-specific clearance documents by combining:
 *  - Vessel Identity (rego, MMSI, IMO, HIN, flag state)
 *  - Crew Manifest (from vessel_crew)
 *  - Ship's Stores filtered by customs-relevant categories
 *  - Port-specific templates (alcohol limits, fuel declarations)
 *
 * Supports: Australia, New Zealand, New Caledonia, Fiji, EU, US.
 *
 * "When you pull into Noumea and hand this over,
 *  the officials will treat you like a Commodore!" — Gemsy
 */

import type { jsPDF as JsPDFType } from 'jspdf';
import type { StoresItem, StoresCategory } from '../types';

// ── Types ──────────────────────────────────────────────────────────────────

export type PortRegion = 'AU' | 'NZ' | 'NC' | 'FJ' | 'EU' | 'US' | 'GENERIC';

export interface VesselIdentity {
    vessel_name: string;
    reg_number: string;
    mmsi: string;
    call_sign: string;
    imo_number?: string;
    hin?: string;
    flag_state?: string;
    port_of_registry?: string;
    gross_tonnage?: number;
    hull_length_m?: number;
    year_built?: number;
    hull_material?: string;
    phonetic_name?: string;
}

export interface CrewManifestEntry {
    name: string;
    nationality: string;
    passport_number?: string;
    role: string;
    date_of_birth?: string;
}

export interface ClearanceOptions {
    vessel: VesselIdentity;
    crew: CrewManifestEntry[];
    stores: StoresItem[];
    portRegion: PortRegion;
    arrivalPort: string;
    departurePort: string;
    arrivalDate: string;
    voyagePurpose?: string;
}

// ── Port Templates ─────────────────────────────────────────────────────────

interface PortTemplate {
    label: string;
    flag: string;
    alcoholCategories: StoresCategory[];
    fuelCategories: StoresCategory[];
    foodCategories: StoresCategory[];
    declarableCategories: StoresCategory[]; // All categories that appear on the form
    alcoholLimitLitres?: number; // Per-person duty-free limit
    requiresCrewManifest: boolean;
    requiresFuelDeclaration: boolean;
    requiresFirearmsDeclaration: boolean;
    customNotes?: string[];
}

const PORT_TEMPLATES: Record<PortRegion, PortTemplate> = {
    AU: {
        label: 'Australia',
        flag: '🇦🇺',
        alcoholCategories: ['Booze'],
        fuelCategories: ['Engine'],
        foodCategories: ['Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry'],
        declarableCategories: ['Booze', 'Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry', 'Engine', 'Medical'],
        alcoholLimitLitres: 2.25, // Per adult
        requiresCrewManifest: true,
        requiresFuelDeclaration: true,
        requiresFirearmsDeclaration: true,
        customNotes: ['Declare ALL food, plant material, and animal products', 'Biosecurity inspection may apply'],
    },
    NZ: {
        label: 'New Zealand',
        flag: '🇳🇿',
        alcoholCategories: ['Booze'],
        fuelCategories: ['Engine'],
        foodCategories: ['Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry'],
        declarableCategories: ['Booze', 'Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry', 'Engine'],
        alcoholLimitLitres: 3.0,
        requiresCrewManifest: true,
        requiresFuelDeclaration: true,
        requiresFirearmsDeclaration: true,
        customNotes: ['MPI biosecurity: declare all food and biologicals'],
    },
    NC: {
        label: 'Nouvelle-Calédonie',
        flag: '🇳🇨',
        alcoholCategories: ['Booze'],
        fuelCategories: ['Engine'],
        foodCategories: ['Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry'],
        declarableCategories: ['Booze', 'Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry', 'Engine', 'Medical'],
        alcoholLimitLitres: 2.0,
        requiresCrewManifest: true,
        requiresFuelDeclaration: true,
        requiresFirearmsDeclaration: true,
        customNotes: ['Présenter le manifeste au bureau des douanes', 'All firearms must be declared and sealed'],
    },
    FJ: {
        label: 'Fiji',
        flag: '🇫🇯',
        alcoholCategories: ['Booze'],
        fuelCategories: ['Engine'],
        foodCategories: ['Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry'],
        declarableCategories: ['Booze', 'Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry'],
        alcoholLimitLitres: 2.25,
        requiresCrewManifest: true,
        requiresFuelDeclaration: false,
        requiresFirearmsDeclaration: true,
        customNotes: ['Cruising permit required from Suva'],
    },
    EU: {
        label: 'European Union',
        flag: '🇪🇺',
        alcoholCategories: ['Booze'],
        fuelCategories: ['Engine'],
        foodCategories: ['Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry'],
        declarableCategories: ['Booze', 'Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry', 'Engine'],
        alcoholLimitLitres: 4.0,
        requiresCrewManifest: true,
        requiresFuelDeclaration: true,
        requiresFirearmsDeclaration: true,
        customNotes: ['Present to Capitainerie / Port Authority on arrival'],
    },
    US: {
        label: 'United States',
        flag: '🇺🇸',
        alcoholCategories: ['Booze'],
        fuelCategories: ['Engine'],
        foodCategories: ['Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry'],
        declarableCategories: ['Booze', 'Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry', 'Engine', 'Medical'],
        alcoholLimitLitres: 1.0,
        requiresCrewManifest: true,
        requiresFuelDeclaration: true,
        requiresFirearmsDeclaration: true,
        customNotes: ['CBP Form 1300 required', 'Call CBP prior to arrival: 1-800-973-2867'],
    },
    GENERIC: {
        label: 'International',
        flag: '🌐',
        alcoholCategories: ['Booze'],
        fuelCategories: ['Engine'],
        foodCategories: ['Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry'],
        declarableCategories: ['Booze', 'Provisions', 'Pantry', 'Freezer', 'Fridge', 'Dry', 'Engine', 'Medical'],
        requiresCrewManifest: true,
        requiresFuelDeclaration: true,
        requiresFirearmsDeclaration: false,
        customNotes: [],
    },
};

export function getPortTemplate(region: PortRegion): PortTemplate {
    return PORT_TEMPLATES[region];
}

export function getAvailablePorts(): { code: PortRegion; label: string; flag: string }[] {
    return Object.entries(PORT_TEMPLATES).map(([code, t]) => ({
        code: code as PortRegion,
        label: t.label,
        flag: t.flag,
    }));
}

// ── PDF Generation ─────────────────────────────────────────────────────────

const W = 210,
    H = 297,
    M = 15;
const CW = W - M * 2;

function checkPage(pdf: JsPDFType, y: number, needed: number): number {
    if (y + needed > H - M) {
        pdf.addPage();
        return M + 10;
    }
    return y;
}

async function generateClearancePDF(options: ClearanceOptions): Promise<JsPDFType> {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const template = PORT_TEMPLATES[options.portRegion];

    const currentDate = new Date().toLocaleDateString('en-AU', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

    // ═══ HEADER — Navy bar with gold accent ═══
    pdf.setFillColor(26, 42, 58);
    pdf.rect(0, 0, W, 52, 'F');

    pdf.setDrawColor(201, 162, 39);
    pdf.setLineWidth(1.5);
    pdf.line(M + 15, 50, W - M - 15, 50);

    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(18);
    pdf.setFont('helvetica', 'bold');
    pdf.text(`${template.flag}  PORT CLEARANCE — ${template.label.toUpperCase()}`, W / 2, 16, { align: 'center' });

    // Vessel identity line
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'normal');
    const vesselLine = [
        options.vessel.vessel_name,
        options.vessel.reg_number ? `Rego: ${options.vessel.reg_number}` : '',
        options.vessel.mmsi ? `MMSI: ${options.vessel.mmsi}` : '',
        options.vessel.imo_number ? `IMO: ${options.vessel.imo_number}` : '',
        options.vessel.hin ? `HIN: ${options.vessel.hin}` : '',
    ]
        .filter(Boolean)
        .join(' | ');
    pdf.text(vesselLine, W / 2, 26, { align: 'center' });

    // Second identity line
    pdf.setFontSize(8);
    const vesselLine2 = [
        options.vessel.call_sign ? `Call Sign: ${options.vessel.call_sign}` : '',
        options.vessel.flag_state ? `Flag: ${options.vessel.flag_state}` : '',
        options.vessel.port_of_registry ? `Port: ${options.vessel.port_of_registry}` : '',
        options.vessel.gross_tonnage ? `GT: ${options.vessel.gross_tonnage}` : '',
        options.vessel.hull_length_m ? `LOA: ${options.vessel.hull_length_m}m` : '',
    ]
        .filter(Boolean)
        .join(' | ');
    if (vesselLine2) {
        pdf.text(vesselLine2, W / 2, 33, { align: 'center' });
    }

    // Voyage line
    pdf.setFontSize(8);
    pdf.setTextColor(201, 162, 39);
    pdf.text(
        `${options.departurePort} → ${options.arrivalPort} | Arrived: ${options.arrivalDate} | Crew: ${options.crew.length} | ${currentDate}`,
        W / 2,
        42,
        { align: 'center' },
    );

    let y = 62;

    // ═══ CREW MANIFEST ═══
    if (template.requiresCrewManifest && options.crew.length > 0) {
        y = checkPage(pdf, y, 30);
        y = drawSection(pdf, '👥 CREW MANIFEST', y);

        // Crew table header
        pdf.setFillColor(26, 42, 58);
        pdf.rect(M, y, CW, 7, 'F');
        pdf.setFontSize(6.5);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(255, 255, 255);
        const crewHeaders = ['NAME', 'NATIONALITY', 'PASSPORT', 'ROLE'];
        const crewWidths = [55, 35, 45, 45];
        let cx = M;
        crewHeaders.forEach((h, i) => {
            pdf.text(h, cx + 2, y + 5);
            cx += crewWidths[i];
        });
        y += 7;

        for (let i = 0; i < options.crew.length; i++) {
            y = checkPage(pdf, y, 7);
            const c = options.crew[i];
            if (i % 2 === 0) {
                pdf.setFillColor(245, 247, 250);
                pdf.rect(M, y, CW, 6.5, 'F');
            }
            pdf.setFontSize(7.5);
            pdf.setFont('helvetica', 'normal');
            pdf.setTextColor(40, 40, 40);
            cx = M;
            pdf.text((c.name || '').substring(0, 30), cx + 2, y + 4.5);
            cx += crewWidths[0];
            pdf.text((c.nationality || '').substring(0, 18), cx + 2, y + 4.5);
            cx += crewWidths[1];
            pdf.text((c.passport_number || '—').substring(0, 24), cx + 2, y + 4.5);
            cx += crewWidths[2];
            pdf.text((c.role || '').substring(0, 24), cx + 2, y + 4.5);
            y += 6.5;
        }
        y += 6;
    }

    // ═══ STORES DECLARATION ═══
    const declarableItems = options.stores.filter((s) => template.declarableCategories.includes(s.category));

    // Alcohol section
    const alcoholItems = options.stores.filter((s) => template.alcoholCategories.includes(s.category));
    if (alcoholItems.length > 0) {
        y = checkPage(pdf, y, 25);
        y = drawSection(pdf, '🍺 ALCOHOL DECLARATION', y);

        if (template.alcoholLimitLitres) {
            pdf.setFontSize(7);
            pdf.setFont('helvetica', 'italic');
            pdf.setTextColor(220, 38, 38);
            pdf.text(
                `Duty-free limit: ${template.alcoholLimitLitres}L per adult (${options.crew.length} crew = ${(template.alcoholLimitLitres * options.crew.length).toFixed(1)}L total)`,
                M,
                y,
            );
            y += 5;
        }

        y = drawStoresTable(pdf, alcoholItems, y);
        y += 4;
    }

    // Food/Provisions section
    const foodItems = options.stores.filter((s) => template.foodCategories.includes(s.category));
    if (foodItems.length > 0) {
        y = checkPage(pdf, y, 25);
        y = drawSection(pdf, '🥫 PROVISIONS DECLARATION', y);
        y = drawStoresTable(pdf, foodItems, y);
        y += 4;
    }

    // Fuel section
    if (template.requiresFuelDeclaration) {
        const fuelItems = options.stores.filter((s) => template.fuelCategories.includes(s.category));
        if (fuelItems.length > 0) {
            y = checkPage(pdf, y, 25);
            y = drawSection(pdf, '⛽ FUEL & ENGINE STORES', y);
            y = drawStoresTable(pdf, fuelItems, y);
            y += 4;
        }
    }

    // Medical stores
    const medicalItems = options.stores.filter((s) => s.category === 'Medical');
    if (medicalItems.length > 0) {
        y = checkPage(pdf, y, 25);
        y = drawSection(pdf, '🏥 MEDICAL STORES', y);
        y = drawStoresTable(pdf, medicalItems, y);
        y += 4;
    }

    // ═══ CUSTOM NOTES ═══
    if (template.customNotes && template.customNotes.length > 0) {
        y = checkPage(pdf, y, 20);
        y = drawSection(pdf, '📋 PORT REQUIREMENTS', y);
        pdf.setFontSize(7.5);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(40, 40, 40);
        for (const note of template.customNotes) {
            y = checkPage(pdf, y, 6);
            pdf.text(`• ${note}`, M + 2, y);
            y += 5;
        }
        y += 4;
    }

    // ═══ SUMMARY BOX ═══
    y = checkPage(pdf, y, 30);
    pdf.setDrawColor(201, 162, 39);
    pdf.setLineWidth(0.5);
    pdf.roundedRect(M, y, CW, 22, 2, 2, 'S');

    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(26, 42, 58);
    pdf.text('DECLARATION SUMMARY', M + 4, y + 5);

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.text(`Total declarable items: ${declarableItems.length}`, M + 4, y + 10);
    pdf.text(`Alcohol items: ${alcoholItems.length}`, M + 4, y + 14);
    pdf.text(`Crew on board: ${options.crew.length}`, M + 4, y + 18);
    pdf.text(`Purpose: ${options.voyagePurpose || 'Pleasure / Cruising'}`, M + CW / 2, y + 10);
    pdf.text(`Vessel: ${options.vessel.vessel_name}`, M + CW / 2, y + 14);

    // ═══ SIGNATURE LINE ═══
    y += 30;
    y = checkPage(pdf, y, 25);
    pdf.setDrawColor(160, 160, 160);
    pdf.setLineWidth(0.3);
    pdf.line(M, y, M + 70, y);
    pdf.line(M + 90, y, M + CW, y);
    pdf.setFontSize(7);
    pdf.setTextColor(120, 120, 120);
    pdf.text('Skipper Signature', M, y + 4);
    pdf.text('Date', M + 90, y + 4);

    // ═══ FOOTER ═══
    const pageCount = pdf.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) {
        pdf.setPage(p);
        pdf.setFontSize(6.5);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(160, 160, 160);
        pdf.text(
            `Generated by Thalassa Marine | ${options.vessel.vessel_name} | ${currentDate} | Page ${p}/${pageCount}`,
            W / 2,
            H - 8,
            { align: 'center' },
        );
    }

    return pdf;
}

// ── PDF Helpers ────────────────────────────────────────────────────────────

function drawSection(pdf: JsPDFType, title: string, y: number): number {
    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(26, 42, 58);
    pdf.text(title, M, y);
    pdf.setDrawColor(3, 105, 161);
    pdf.setLineWidth(0.6);
    pdf.line(M, y + 2, M + CW, y + 2);
    return y + 7;
}

function drawStoresTable(pdf: JsPDFType, items: StoresItem[], y: number): number {
    const cols = [55, 18, 22, 45, 40];
    const headers = ['ITEM', 'QTY', 'UNIT', 'LOCATION', 'CATEGORY'];

    // Header row
    pdf.setFillColor(26, 42, 58);
    pdf.rect(M, y, CW, 7, 'F');
    pdf.setFontSize(6.5);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(255, 255, 255);
    let hx = M;
    headers.forEach((h, i) => {
        pdf.text(h, hx + 2, y + 5);
        hx += cols[i];
    });
    y += 7;

    // Data rows
    const sorted = [...items].sort(
        (a, b) => a.category.localeCompare(b.category) || a.item_name.localeCompare(b.item_name),
    );
    for (let i = 0; i < sorted.length; i++) {
        y = checkPage(pdf, y, 7);
        if (y < M + 12) {
            // Redraw header on new page
            pdf.setFillColor(26, 42, 58);
            pdf.rect(M, y, CW, 7, 'F');
            pdf.setFontSize(6.5);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(255, 255, 255);
            hx = M;
            headers.forEach((h, hi) => {
                pdf.text(h, hx + 2, y + 5);
                hx += cols[hi];
            });
            y += 7;
        }

        const item = sorted[i];
        if (i % 2 === 0) {
            pdf.setFillColor(245, 247, 250);
            pdf.rect(M, y, CW, 6.5, 'F');
        }

        pdf.setFontSize(7.5);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(40, 40, 40);

        hx = M;
        pdf.text(item.item_name.substring(0, 32), hx + 2, y + 4.5);
        hx += cols[0];

        pdf.setFont('helvetica', 'bold');
        pdf.text(String(item.quantity), hx + 2, y + 4.5);
        hx += cols[1];

        pdf.setFont('helvetica', 'normal');
        pdf.text((item.unit || 'whole').substring(0, 12), hx + 2, y + 4.5);
        hx += cols[2];

        const loc = item.location_zone
            ? `${item.location_zone}${item.location_specific ? ` — ${item.location_specific}` : ''}`.substring(0, 24)
            : '—';
        pdf.text(loc, hx + 2, y + 4.5);
        hx += cols[3];

        pdf.setTextColor(120, 120, 120);
        pdf.text(item.category.substring(0, 20), hx + 2, y + 4.5);

        y += 6.5;
    }

    return y;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function downloadClearancePdf(options: ClearanceOptions): Promise<void> {
    const pdf = await generateClearancePDF(options);
    const date = new Date().toISOString().split('T')[0];
    const port = options.arrivalPort.replace(/\s+/g, '_');
    const filename = `Clearance_${port}_${date}.pdf`;
    pdf.save(filename);
}

export async function shareClearancePdf(options: ClearanceOptions): Promise<void> {
    const pdf = await generateClearancePDF(options);
    const date = new Date().toISOString().split('T')[0];
    const port = options.arrivalPort.replace(/\s+/g, '_');
    const filename = `Clearance_${port}_${date}.pdf`;

    const pdfBlob = pdf.output('blob');
    const pdfFile = new File([pdfBlob], filename, { type: 'application/pdf' });

    if (navigator.share && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
        try {
            await navigator.share({
                title: `Port Clearance — ${options.arrivalPort}`,
                text: `Clearance for ${options.vessel.vessel_name} arriving ${options.arrivalPort}`,
                files: [pdfFile],
            });
            return;
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') return;
        }
    }

    pdf.save(filename);
}
