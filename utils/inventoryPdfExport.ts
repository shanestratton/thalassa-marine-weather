/**
 * inventoryPdfExport — the Ship's Stores PDF.
 *
 * Every item of the chosen categories (all of them by default), grouped by
 * category, with quantity, minimum, location and expiry, and the totals on
 * top. Exporting a few categories makes a list for a store run.
 *
 * 130-B8: drawn on services/pdf/registerPdf.ts, so a name in any script
 * prints and a long one wraps instead of being cut; dates are the phone's own
 * (services/pdf/pdfDates.ts); no emoji in the headings (Helvetica printed them
 * as garbage); titled Ship's Stores, as the screen is. It goes out through
 * sharePdfBlob: the old 'Download' called jsPDF's save(), which does nothing
 * in the iPhone app, and then said the PDF was downloaded.
 */
import type { jsPDF } from 'jspdf';
import type { InventoryItem, InventoryCategory } from '../types';
import { INVENTORY_CATEGORIES } from '../types';
import { RegisterPdf, REGISTER_COLOURS, type JsPdfConstructor, type RegisterCell } from '../services/pdf/registerPdf';
import { pdfDaysUntil, pdfFileDay, pdfLongDate, pdfShortDate } from '../services/pdf/pdfDates';
import { sharePdfBlob, shareTitle, type ShareOutcome } from './sharePdf';

export const STORES_PDF_TITLE = "Ship's Stores";

const COLUMNS = [
    { label: 'ITEM', width: 52 },
    { label: 'QTY', width: 16 },
    { label: 'MIN', width: 16 },
    { label: 'LOCATION', width: 48 },
    { label: 'EXPIRY', width: 48 },
];

export interface InventoryPdfOptions {
    items: InventoryItem[];
    /** None or empty: every category. */
    categories?: Set<InventoryCategory>;
    vesselName?: string;
}

/** A count as the phone writes numbers: '2.5' or '2,5', never '2.5000000001'. */
function formatCount(value: number): string {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function plural(count: number, word: string): string {
    return `${formatCount(count)} ${word}${count === 1 ? '' : 's'}`;
}

const isLow = (item: InventoryItem) => item.quantity <= item.min_quantity && item.min_quantity > 0;

/** The categories the PDF lists, in the screen's order. */
function chosenCategories(categories?: Set<InventoryCategory>): InventoryCategory[] {
    return categories && categories.size > 0
        ? INVENTORY_CATEGORIES.filter((c) => categories.has(c))
        : INVENTORY_CATEGORIES;
}

/** Every item the PDF lists: those in the chosen categories. */
export function storesPdfItems({
    items,
    categories,
}: Pick<InventoryPdfOptions, 'items' | 'categories'>): InventoryItem[] {
    const cats = chosenCategories(categories);
    return items.filter((item) => cats.includes(item.category));
}

function itemRow(item: InventoryItem, now: Date): RegisterCell[] {
    const low = isLow(item);
    const location = [item.location_zone, item.location_specific].filter((part) => part?.trim()).join(' — ');
    const days = pdfDaysUntil(item.expiry_date, now);
    const expiryColour =
        days === null
            ? REGISTER_COLOURS.muted
            : days <= 0
              ? REGISTER_COLOURS.red
              : days <= 90
                ? REGISTER_COLOURS.amber
                : REGISTER_COLOURS.green;
    return [
        { text: item.item_name },
        {
            text: formatCount(item.quantity),
            bold: true,
            color: low ? REGISTER_COLOURS.red : undefined,
            tag: low ? { text: 'LOW', color: REGISTER_COLOURS.red } : undefined,
        },
        { text: item.min_quantity > 0 ? formatCount(item.min_quantity) : '—', color: REGISTER_COLOURS.muted },
        { text: location || '—' },
        { text: pdfShortDate(item.expiry_date), color: expiryColour },
    ];
}

function buildStoresPdf(options: InventoryPdfOptions, JsPdf: JsPdfConstructor, now = new Date()): jsPDF {
    const page = new RegisterPdf(JsPdf);
    const cats = chosenCategories(options.categories);
    const listed = storesPdfItems(options);
    const totalQty = Math.round(listed.reduce((sum, item) => sum + item.quantity, 0) * 100) / 100;
    const lowStock = listed.filter(isLow).length;
    const date = pdfLongDate(now);
    const vessel = options.vesselName?.trim();
    const catLabel = options.categories && options.categories.size > 0 ? cats.join(', ') : 'All Categories';
    const stats = [plural(listed.length, 'Item'), plural(totalQty, 'Unit')];
    if (lowStock > 0) stats.push(`${formatCount(lowStock)} Low Stock`);

    // No name set: no stand-in 'Vessel' on the paper, just the rest of the line.
    page.band(
        STORES_PDF_TITLE.toUpperCase(),
        [
            { text: [vessel, catLabel, date].filter(Boolean).join(' | '), size: 10, color: '#ffffff' },
            { text: stats.join(' · '), size: 9, color: REGISTER_COLOURS.gold },
        ],
        45,
    );
    page.boxes([
        { label: 'TOTAL ITEMS', value: formatCount(listed.length), color: REGISTER_COLOURS.navy },
        { label: 'TOTAL UNITS', value: formatCount(totalQty), color: REGISTER_COLOURS.navy },
        {
            label: 'LOW STOCK',
            value: lowStock > 0 ? formatCount(lowStock) : 'OK',
            color: lowStock > 0 ? REGISTER_COLOURS.red : REGISTER_COLOURS.green,
        },
    ]);

    for (const cat of cats) {
        const catItems = listed
            .filter((item) => item.category === cat)
            .sort((a, b) => a.item_name.localeCompare(b.item_name));
        if (catItems.length === 0) continue;
        page.section(
            `${cat} (${catItems.length})`,
            COLUMNS,
            catItems.map((item) => itemRow(item, now)),
        );
    }
    return page.finish(date);
}

/**
 * Share or save the Ship's Stores PDF: the share sheet in the app (Save to
 * Files, Mail, AirDrop, Print), a download on the web. 'empty' when the chosen
 * categories hold nothing: no blank PDF goes out.
 */
export async function shareInventoryPdf(options: InventoryPdfOptions): Promise<ShareOutcome | 'empty'> {
    if (storesPdfItems(options).length === 0) return 'empty';
    const now = new Date();
    const { jsPDF } = await import('jspdf');
    const doc = buildStoresPdf(options, jsPDF, now);
    return sharePdfBlob(
        doc.output('blob'),
        `Ships_Stores_${pdfFileDay(now)}.pdf`,
        shareTitle(STORES_PDF_TITLE, options.vesselName),
    );
}

export const __testing = { buildStoresPdf, COLUMNS };
