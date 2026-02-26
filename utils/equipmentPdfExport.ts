/**
 * equipmentPdfExport — Equipment Register PDF export.
 *
 * Generates a clean, branded PDF listing all equipment grouped by category,
 * then uses Web Share API (or falls back to direct download).
 */
import { jsPDF } from 'jspdf';
import type { EquipmentItem, EquipmentCategory } from '../types';

const W = 210, H = 297, M = 15;
const CW = W - M * 2;

const CATEGORY_ORDER: EquipmentCategory[] = [
    'Propulsion', 'Electronics', 'HVAC', 'Plumbing', 'Rigging', 'Galley',
];

// ── Helpers (consistent with pdfExport.ts) ──────────────────────

function drawSectionHeader(pdf: jsPDF, title: string, y: number): number {
    pdf.setFontSize(12);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(26, 42, 58);
    pdf.text(title.toUpperCase(), M, y);

    pdf.setDrawColor(3, 105, 161);
    pdf.setLineWidth(0.8);
    pdf.line(M, y + 2, M + CW, y + 2);

    return y + 8;
}

function checkPage(pdf: jsPDF, y: number, needed: number): number {
    if (y + needed > H - M) {
        pdf.addPage();
        return M + 10;
    }
    return y;
}

// ── Table row drawing ───────────────────────────────────────────

const COL_WIDTHS = [48, 32, 32, 34, 34]; // Name, Make, Model, Serial, Warranty
const COL_LABELS = ['EQUIPMENT', 'MAKE', 'MODEL', 'SERIAL NO.', 'WARRANTY'];

function colX(i: number): number {
    let x = M;
    for (let j = 0; j < i; j++) x += COL_WIDTHS[j];
    return x;
}

function drawTableHeader(pdf: jsPDF, y: number): number {
    pdf.setFillColor(26, 42, 58);
    pdf.rect(M, y, CW, 7, 'F');
    pdf.setFontSize(6.5);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(255, 255, 255);
    COL_LABELS.forEach((h, i) => pdf.text(h, colX(i) + 2, y + 5));
    return y + 7;
}

function drawTableRow(pdf: jsPDF, item: EquipmentItem, y: number, fill: boolean): number {
    const rowH = 6.5;
    if (fill) { pdf.setFillColor(245, 247, 250); pdf.rect(M, y, CW, rowH, 'F'); }
    pdf.setFontSize(7.5);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(40, 40, 40);

    const name = item.equipment_name.substring(0, 30);
    const make = (item.make || '—').substring(0, 18);
    const model = (item.model || '—').substring(0, 18);
    const serial = (item.serial_number || '—').substring(0, 20);

    let warranty = '—';
    if (item.warranty_expiry) {
        const d = new Date(item.warranty_expiry);
        warranty = d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
        if (d.getTime() < Date.now()) {
            pdf.setTextColor(220, 38, 38); // Red if expired
        }
    }

    pdf.text(name, colX(0) + 2, y + 4.5);
    pdf.setTextColor(40, 40, 40);
    pdf.text(make, colX(1) + 2, y + 4.5);
    pdf.text(model, colX(2) + 2, y + 4.5);
    pdf.setFont('courier', 'normal');
    pdf.setFontSize(7);
    pdf.text(serial, colX(3) + 2, y + 4.5);

    // Warranty (color-coded)
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);
    if (item.warranty_expiry) {
        const d = new Date(item.warranty_expiry);
        const daysLeft = Math.ceil((d.getTime() - Date.now()) / 86_400_000);
        if (daysLeft <= 0) pdf.setTextColor(220, 38, 38);
        else if (daysLeft <= 90) pdf.setTextColor(217, 119, 6);
        else pdf.setTextColor(22, 163, 74);
    } else {
        pdf.setTextColor(160, 160, 160);
    }
    pdf.text(warranty, colX(4) + 2, y + 4.5);

    pdf.setTextColor(40, 40, 40); // Reset
    return y + rowH;
}

// ── Generate the PDF ────────────────────────────────────────────

function generateEquipmentPDF(items: EquipmentItem[], vesselName?: string): jsPDF {
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const currentDate = new Date().toLocaleDateString('en-AU', {
        year: 'numeric', month: 'long', day: 'numeric',
    });

    // ═══ Header ═══
    pdf.setFillColor(26, 42, 58);
    pdf.rect(0, 0, W, 40, 'F');

    pdf.setDrawColor(201, 162, 39);
    pdf.setLineWidth(1.5);
    pdf.line(M + 20, 38, W - M - 20, 38);

    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(20);
    pdf.setFont('helvetica', 'bold');
    pdf.text('EQUIPMENT REGISTER', W / 2, 18, { align: 'center' });

    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`${vesselName || 'Vessel'} | ${items.length} Items | ${currentDate}`, W / 2, 30, { align: 'center' });

    let y = 50;

    // ═══ Group by category ═══
    for (const cat of CATEGORY_ORDER) {
        const catItems = items.filter(i => i.category === cat);
        if (catItems.length === 0) continue;

        // Need space for header + table header + at least one row
        y = checkPage(pdf, y, 25);
        y = drawSectionHeader(pdf, `${cat} (${catItems.length})`, y);
        y = drawTableHeader(pdf, y);

        catItems.forEach((item, i) => {
            y = checkPage(pdf, y, 7);
            // Re-draw table header if we're on a new page
            if (y < M + 12) {
                y = drawTableHeader(pdf, y);
            }
            y = drawTableRow(pdf, item, y, i % 2 === 0);
        });

        y += 6; // Gap between categories
    }

    // ═══ Footer ═══
    const pageCount = pdf.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) {
        pdf.setPage(p);
        pdf.setFontSize(7);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(160, 160, 160);
        pdf.text(`Generated by Thalassa Marine Weather | ${currentDate} | Page ${p} of ${pageCount}`, W / 2, H - 8, { align: 'center' });
    }

    return pdf;
}

// ── Public API (same share-or-download pattern as passage brief) ──

export async function exportEquipmentPdf(items: EquipmentItem[], vesselName?: string): Promise<void> {
    const pdf = generateEquipmentPDF(items, vesselName);
    const date = new Date().toISOString().split('T')[0];
    const filename = `Equipment_Register_${date}.pdf`;

    const pdfBlob = pdf.output('blob');
    const pdfFile = new File([pdfBlob], filename, { type: 'application/pdf' });

    // Try Web Share API (iOS share sheet for email, AirDrop, etc.)
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
        try {
            await navigator.share({
                title: 'Equipment Register',
                text: `Equipment register for ${vesselName || 'vessel'}`,
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
