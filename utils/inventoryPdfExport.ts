/**
 * inventoryPdfExport — Ship's Inventory PDF export.
 *
 * Generates a branded PDF listing all inventory items grouped by category,
 * with quantity, min-stock, location, and expiry.
 * Uses the same styling as equipmentPdfExport / logbook (navy header, gold accent, tables).
 *
 * Supports exporting specific categories (e.g. just Provisions + Medical for a store run).
 */
import type { jsPDF as JsPDFType } from 'jspdf';
import type { InventoryItem, InventoryCategory } from '../types';
import { INVENTORY_CATEGORIES, INVENTORY_CATEGORY_ICONS } from '../types';

const W = 210,
    H = 297,
    M = 15;
const CW = W - M * 2;

// ── Helpers (consistent with equipmentPdfExport / pdfExport) ────

function drawSectionHeader(pdf: JsPDFType, title: string, y: number): number {
    pdf.setFontSize(12);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(26, 42, 58);
    pdf.text(title.toUpperCase(), M, y);

    pdf.setDrawColor(3, 105, 161);
    pdf.setLineWidth(0.8);
    pdf.line(M, y + 2, M + CW, y + 2);

    return y + 8;
}

function checkPage(pdf: JsPDFType, y: number, needed: number): number {
    if (y + needed > H - M) {
        pdf.addPage();
        return M + 10;
    }
    return y;
}

// ── Table column layout ─────────────────────────────────────────

const COL_WIDTHS = [52, 16, 16, 48, 48]; // Name, Qty, Min, Location, Expiry
const COL_LABELS = ['ITEM', 'QTY', 'MIN', 'LOCATION', 'EXPIRY'];

function colX(i: number): number {
    let x = M;
    for (let j = 0; j < i; j++) x += COL_WIDTHS[j];
    return x;
}

function drawTableHeader(pdf: JsPDFType, y: number): number {
    pdf.setFillColor(26, 42, 58);
    pdf.rect(M, y, CW, 7, 'F');
    pdf.setFontSize(6.5);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(255, 255, 255);
    COL_LABELS.forEach((h, i) => pdf.text(h, colX(i) + 2, y + 5));
    return y + 7;
}

function drawTableRow(pdf: JsPDFType, item: InventoryItem, y: number, fill: boolean): number {
    const rowH = 6.5;
    if (fill) {
        pdf.setFillColor(245, 247, 250);
        pdf.rect(M, y, CW, rowH, 'F');
    }
    pdf.setFontSize(7.5);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(40, 40, 40);

    const name = item.item_name.substring(0, 32);
    const qty = String(item.quantity);
    const minQty = item.min_quantity > 0 ? String(item.min_quantity) : '—';
    const loc = item.location_zone
        ? `${item.location_zone}${item.location_specific ? ` — ${item.location_specific}` : ''}`.substring(0, 28)
        : '—';

    // Low stock warning
    const isLow = item.quantity <= item.min_quantity && item.min_quantity > 0;

    pdf.text(name, colX(0) + 2, y + 4.5);

    // Qty — red if low stock
    if (isLow) pdf.setTextColor(220, 38, 38);
    pdf.setFont('helvetica', 'bold');
    pdf.text(qty, colX(1) + 2, y + 4.5);
    pdf.setTextColor(40, 40, 40);
    pdf.setFont('helvetica', 'normal');

    // Min
    pdf.setTextColor(160, 160, 160);
    pdf.text(minQty, colX(2) + 2, y + 4.5);
    pdf.setTextColor(40, 40, 40);

    // Location
    pdf.text(loc, colX(3) + 2, y + 4.5);

    // Expiry — color-coded
    if (item.expiry_date) {
        const d = new Date(item.expiry_date);
        const daysLeft = Math.ceil((d.getTime() - Date.now()) / 86_400_000);
        const expStr = d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
        if (daysLeft <= 0) pdf.setTextColor(220, 38, 38);
        else if (daysLeft <= 90) pdf.setTextColor(217, 119, 6);
        else pdf.setTextColor(22, 163, 74);
        pdf.text(expStr, colX(4) + 2, y + 4.5);
    } else {
        pdf.setTextColor(160, 160, 160);
        pdf.text('—', colX(4) + 2, y + 4.5);
    }

    // Low stock annotation
    if (isLow) {
        pdf.setTextColor(220, 38, 38);
        pdf.setFontSize(5.5);
        pdf.setFont('helvetica', 'bold');
        pdf.text('LOW', colX(1) + 8, y + 4.5);
    }

    pdf.setTextColor(40, 40, 40);
    return y + rowH;
}

// ── Generate the PDF ────────────────────────────────────────────

interface InventoryPdfOptions {
    items: InventoryItem[];
    categories?: Set<InventoryCategory>;
    vesselName?: string;
}

async function generateInventoryPDF({ items, categories, vesselName }: InventoryPdfOptions): Promise<JsPDFType> {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const cats =
        categories && categories.size > 0
            ? INVENTORY_CATEGORIES.filter((c) => categories.has(c))
            : INVENTORY_CATEGORIES;

    const currentDate = new Date().toLocaleDateString('en-AU', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

    // Filter items to selected categories
    const filteredItems = items.filter((i) => cats.includes(i.category));
    const totalQty = filteredItems.reduce((s, i) => s + i.quantity, 0);
    const lowStock = filteredItems.filter((i) => i.quantity <= i.min_quantity && i.min_quantity > 0).length;

    // ═══ Header ═══
    pdf.setFillColor(26, 42, 58);
    pdf.rect(0, 0, W, 45, 'F');

    pdf.setDrawColor(201, 162, 39);
    pdf.setLineWidth(1.5);
    pdf.line(M + 20, 43, W - M - 20, 43);

    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(20);
    pdf.setFont('helvetica', 'bold');
    pdf.text("SHIP'S INVENTORY", W / 2, 18, { align: 'center' });

    // Subtitle
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    const catLabel = categories && categories.size > 0 ? Array.from(categories).join(', ') : 'All Categories';
    pdf.text(`${vesselName || 'Vessel'} | ${catLabel} | ${currentDate}`, W / 2, 30, { align: 'center' });

    // Stats line
    pdf.setFontSize(9);
    pdf.setTextColor(201, 162, 39);
    pdf.text(
        `${filteredItems.length} Items · ${totalQty} Units${lowStock > 0 ? ` · ${lowStock} Low Stock` : ''}`,
        W / 2,
        38,
        { align: 'center' },
    );

    let y = 55;

    // ═══ Summary boxes ═══
    const boxW = (CW - 6) / 3;
    const boxH = 16;

    // Total Items
    pdf.setDrawColor(200, 200, 200);
    pdf.setLineWidth(0.3);
    pdf.roundedRect(M, y, boxW, boxH, 2, 2, 'S');
    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(120, 120, 120);
    pdf.text('TOTAL ITEMS', M + 4, y + 5);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(26, 42, 58);
    pdf.text(String(filteredItems.length), M + 4, y + 13);

    // Total Units
    pdf.setDrawColor(200, 200, 200);
    pdf.roundedRect(M + boxW + 3, y, boxW, boxH, 2, 2, 'S');
    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(120, 120, 120);
    pdf.text('TOTAL UNITS', M + boxW + 7, y + 5);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(26, 42, 58);
    pdf.text(String(totalQty), M + boxW + 7, y + 13);

    // Low Stock
    pdf.roundedRect(M + (boxW + 3) * 2, y, boxW, boxH, 2, 2, 'S');
    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(120, 120, 120);
    pdf.text('LOW STOCK', M + (boxW + 3) * 2 + 4, y + 5);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    if (lowStock > 0) pdf.setTextColor(220, 38, 38);
    else pdf.setTextColor(22, 163, 74);
    pdf.text(lowStock > 0 ? String(lowStock) : 'OK', M + (boxW + 3) * 2 + 4, y + 13);

    y += boxH + 8;

    // ═══ Group by category ═══
    for (const cat of cats) {
        const catItems = filteredItems
            .filter((i) => i.category === cat)
            .sort((a, b) => a.item_name.localeCompare(b.item_name));
        if (catItems.length === 0) continue;

        const icon = INVENTORY_CATEGORY_ICONS[cat] || '';
        y = checkPage(pdf, y, 25);
        y = drawSectionHeader(pdf, `${icon} ${cat} (${catItems.length})`, y);
        y = drawTableHeader(pdf, y);

        catItems.forEach((item, i) => {
            y = checkPage(pdf, y, 7);
            // Re-draw table header if we're on a new page
            if (y < M + 12) {
                y = drawTableHeader(pdf, y);
            }
            y = drawTableRow(pdf, item, y, i % 2 === 0);
        });

        y += 6;
    }

    // ═══ Footer ═══
    const pageCount = pdf.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) {
        pdf.setPage(p);
        pdf.setFontSize(7);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(160, 160, 160);
        pdf.text(`Generated by Thalassa Marine Weather | ${currentDate} | Page ${p} of ${pageCount}`, W / 2, H - 8, {
            align: 'center',
        });
    }

    return pdf;
}

// ── Public API (same share-or-download pattern) ─────────────────

export async function downloadInventoryPdf(options: InventoryPdfOptions): Promise<void> {
    const pdf = await generateInventoryPDF(options);
    const date = new Date().toISOString().split('T')[0];
    const filename = `Ships_Inventory_${date}.pdf`;
    pdf.save(filename);
}

export async function shareInventoryPdf(options: InventoryPdfOptions): Promise<void> {
    const pdf = await generateInventoryPDF(options);
    const date = new Date().toISOString().split('T')[0];
    const filename = `Ships_Inventory_${date}.pdf`;

    const pdfBlob = pdf.output('blob');
    const pdfFile = new File([pdfBlob], filename, { type: 'application/pdf' });

    // Try Web Share API (iOS share sheet for email, AirDrop, print, etc.)
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
        try {
            await navigator.share({
                title: "Ship's Inventory",
                text: `Inventory for ${options.vesselName || 'vessel'}`,
                files: [pdfFile],
            });
            return;
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') return;
            // Fall through to download
        }
    }

    // Fallback — direct download
    pdf.save(filename);
}
