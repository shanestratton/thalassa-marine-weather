/**
 * equipmentPdfExport — the Equipment Register PDF.
 *
 * Every item grouped by category, with make, model, serial number and
 * warranty, under the boat's name.
 *
 * 130-B8: drawn on services/pdf/registerPdf.ts, so a name in any script
 * prints and a long name, model or serial wraps instead of being cut; the
 * dates are the phone's own (services/pdf/pdfDates.ts). It goes out through
 * sharePdfBlob, which opens the share sheet in the iPhone app.
 */
import type { jsPDF } from 'jspdf';
import type { EquipmentItem, EquipmentCategory } from '../types';
import { RegisterPdf, REGISTER_COLOURS, type JsPdfConstructor, type RegisterCell } from '../services/pdf/registerPdf';
import { pdfDaysUntil, pdfFileDay, pdfLongDate, pdfShortDate } from '../services/pdf/pdfDates';
import { sharePdfBlob, shareTitle, type ShareOutcome } from './sharePdf';

export const EQUIPMENT_PDF_TITLE = 'Equipment Register';

const CATEGORY_ORDER: EquipmentCategory[] = ['Propulsion', 'Electronics', 'HVAC', 'Plumbing', 'Rigging', 'Galley'];

const COLUMNS = [
    { label: 'EQUIPMENT', width: 48 },
    { label: 'MAKE', width: 32 },
    { label: 'MODEL', width: 32 },
    { label: 'SERIAL NO.', width: 34 },
    { label: 'WARRANTY', width: 34 },
];

function itemRow(item: EquipmentItem, now: Date): RegisterCell[] {
    const days = pdfDaysUntil(item.warranty_expiry, now);
    const warrantyColour =
        days === null
            ? REGISTER_COLOURS.muted
            : days <= 0
              ? REGISTER_COLOURS.red
              : days <= 90
                ? REGISTER_COLOURS.amber
                : REGISTER_COLOURS.green;
    return [
        // The name in red once its warranty has run out, as before.
        { text: item.equipment_name, color: days !== null && days < 0 ? REGISTER_COLOURS.red : undefined },
        { text: item.make?.trim() || '—' },
        { text: item.model?.trim() || '—' },
        { text: item.serial_number?.trim() || '—' },
        { text: pdfShortDate(item.warranty_expiry), color: warrantyColour },
    ];
}

function buildEquipmentPdf(
    items: EquipmentItem[],
    vesselName: string | undefined,
    JsPdf: JsPdfConstructor,
    now = new Date(),
): jsPDF {
    const page = new RegisterPdf(JsPdf);
    const date = pdfLongDate(now);
    const count = `${items.length} ${items.length === 1 ? 'Item' : 'Items'}`;
    page.band(
        EQUIPMENT_PDF_TITLE.toUpperCase(),
        [{ text: [vesselName?.trim(), count, date].filter(Boolean).join(' | '), size: 10, color: '#ffffff' }],
        40,
    );

    // A category the register does not know still prints, under Other.
    const groups: { title: string; items: EquipmentItem[] }[] = CATEGORY_ORDER.map((cat) => ({
        title: cat,
        items: items.filter((item) => item.category === cat),
    }));
    groups.push({ title: 'Other', items: items.filter((item) => !CATEGORY_ORDER.includes(item.category)) });
    for (const group of groups) {
        if (group.items.length === 0) continue;
        const sorted = [...group.items].sort((a, b) => a.equipment_name.localeCompare(b.equipment_name));
        page.section(
            `${group.title} (${sorted.length})`,
            COLUMNS,
            sorted.map((item) => itemRow(item, now)),
        );
    }
    return page.finish(date);
}

/**
 * Share or save the Equipment Register PDF: the share sheet in the app (Save
 * to Files, Mail, AirDrop, Print), a download on the web. 'empty' with no
 * equipment: no blank PDF goes out.
 */
export async function exportEquipmentPdf(items: EquipmentItem[], vesselName?: string): Promise<ShareOutcome | 'empty'> {
    if (items.length === 0) return 'empty';
    const now = new Date();
    const { jsPDF } = await import('jspdf');
    const doc = buildEquipmentPdf(items, vesselName, jsPDF, now);
    return sharePdfBlob(
        doc.output('blob'),
        `Equipment_Register_${pdfFileDay(now)}.pdf`,
        shareTitle(EQUIPMENT_PDF_TITLE, vesselName),
    );
}

export const __testing = { buildEquipmentPdf, COLUMNS };
