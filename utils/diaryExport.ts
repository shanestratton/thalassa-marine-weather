/**
 * Captain's Diary PDF Export
 * Generates professional PDF matching the Deck Log export style
 * Navy header, gold accents, compass rose watermark, A4 portrait
 */

import type { jsPDF as JsPDFType } from 'jspdf';
import { DiaryEntry, MOOD_CONFIG, DiaryMood } from '../services/DiaryService';

const NAVY = [26, 42, 58] as const;
const GOLD = [201, 162, 39] as const;
const DARK_TEXT = [26, 42, 58] as const;
const GRAY_TEXT = [106, 122, 138] as const;
const LIGHT_BG = [248, 250, 252] as const;

/**
 * Draw an angled compass rose watermark on the page
 * Same style as the logbook export
 */
function drawCompassRoseWatermark(pdf: JsPDFType, pageWidth: number, pageHeight: number): void {
    const centerX = 35;
    const centerY = pageHeight - 40;
    const radius = 28;
    const angle = -15 * (Math.PI / 180);

    const gState = new (pdf as unknown as { GState: new (opts: { opacity: number }) => string }).GState({ opacity: 0.15 });
    pdf.setGState(gState);

    pdf.setDrawColor(180, 185, 190);
    pdf.setLineWidth(0.3);

    // Outer circles
    pdf.circle(centerX, centerY, radius, 'S');
    pdf.circle(centerX, centerY, radius * 0.82, 'S');
    pdf.circle(centerX, centerY, radius * 0.2, 'S');

    // 8-point star with rotation
    for (let i = 0; i < 8; i++) {
        const baseAngle = (i * Math.PI * 2) / 8 - Math.PI / 2 + angle;
        const innerR = radius * 0.25;
        const outerR = i % 2 === 0 ? radius * 0.9 : radius * 0.55;

        const x1 = centerX + Math.cos(baseAngle) * innerR;
        const y1 = centerY + Math.sin(baseAngle) * innerR;
        const x2 = centerX + Math.cos(baseAngle) * outerR;
        const y2 = centerY + Math.sin(baseAngle) * outerR;

        pdf.line(x1, y1, x2, y2);

        if (i % 2 === 0) {
            const tipX = centerX + Math.cos(baseAngle) * outerR;
            const tipY = centerY + Math.sin(baseAngle) * outerR;
            const leftAngle = baseAngle + 2.8;
            const rightAngle = baseAngle - 2.8;
            const arrowLen = radius * 0.12;

            pdf.line(tipX, tipY, tipX + Math.cos(leftAngle) * arrowLen, tipY + Math.sin(leftAngle) * arrowLen);
            pdf.line(tipX, tipY, tipX + Math.cos(rightAngle) * arrowLen, tipY + Math.sin(rightAngle) * arrowLen);
        }
    }

    // 16 tick marks
    for (let i = 0; i < 16; i++) {
        const tickAngle = (i * Math.PI * 2) / 16 - Math.PI / 2 + angle;
        const x1 = centerX + Math.cos(tickAngle) * radius * 0.82;
        const y1 = centerY + Math.sin(tickAngle) * radius * 0.82;
        const x2 = centerX + Math.cos(tickAngle) * radius * 0.74;
        const y2 = centerY + Math.sin(tickAngle) * radius * 0.74;
        pdf.line(x1, y1, x2, y2);
    }

    // Cardinal letters
    pdf.setFontSize(9);
    pdf.setTextColor(200, 205, 210);
    pdf.setFont('helvetica', 'bold');

    const rotate = (x: number, y: number) => {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const dx = x - centerX;
        const dy = y - centerY;
        return { x: centerX + dx * cos - dy * sin, y: centerY + dx * sin + dy * cos };
    };

    const labelDist = radius + 5;
    const nPos = rotate(centerX, centerY - labelDist);
    const sPos = rotate(centerX, centerY + labelDist);
    const ePos = rotate(centerX + labelDist, centerY);
    const wPos = rotate(centerX - labelDist, centerY);

    pdf.text('N', nPos.x, nPos.y + 2, { align: 'center' });
    pdf.text('S', sPos.x, sPos.y + 2, { align: 'center' });
    pdf.text('E', ePos.x, ePos.y + 2, { align: 'center' });
    pdf.text('W', wPos.x, wPos.y + 2, { align: 'center' });

    const resetState = new (pdf as unknown as { GState: new (opts: { opacity: number }) => string }).GState({ opacity: 1.0 });
    pdf.setGState(resetState);
}

/**
 * Format coordinates for display
 */
function formatCoord(lat: number, lon: number): string {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
}

/**
 * Group entries by date
 */
function groupByDate(entries: DiaryEntry[]): Map<string, DiaryEntry[]> {
    const map = new Map<string, DiaryEntry[]>();
    const sorted = [...entries].sort((a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    sorted.forEach(entry => {
        const d = new Date(entry.created_at);
        const dateKey = d.toLocaleDateString('en-AU', {
            weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
        }).toUpperCase();
        if (!map.has(dateKey)) map.set(dateKey, []);
        map.get(dateKey)!.push(entry);
    });
    return map;
}

/**
 * Load an image from URL and return as base64 data URI
 */
async function loadImageAsBase64(url: string): Promise<string | null> {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const blob = await response.blob();
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        console.warn('[diaryExport]', e);
        return null;
    }
}

/**
 * Generate the Captain's Diary PDF using jsPDF
 * Matches the Official Deck Log style: navy header, gold accents, compass rose watermark
 */
export async function generateDiaryPDF(
    entries: DiaryEntry[],
    callbacks?: {
        onProgress?: (message: string) => void;
        onSuccess?: () => void;
        onError?: (error: string) => void;
    }
): Promise<void> {
    try {
        if (entries.length === 0) {
            callbacks?.onError?.('No entries to export');
            return;
        }

        callbacks?.onProgress?.('Generating PDF...');

        const { jsPDF } = await import('jspdf');
        const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        const pageWidth = 210;
        const pageHeight = 297;
        const margin = 15;
        const contentWidth = pageWidth - margin * 2;

        const sorted = [...entries].sort((a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
        const grouped = groupByDate(sorted);

        // Compute stats
        const startDate = new Date(sorted[0].created_at);
        const endDate = new Date(sorted[sorted.length - 1].created_at);
        const totalPhotos = sorted.reduce((sum, e) => sum + e.photos.length, 0);
        const moodCounts: Record<string, number> = {};
        sorted.forEach(e => { moodCounts[e.mood] = (moodCounts[e.mood] || 0) + 1; });
        const topMood = Object.entries(moodCounts).sort((a, b) => b[1] - a[1])[0]?.[0] as DiaryMood || 'neutral';
        const topMoodCfg = MOOD_CONFIG[topMood];

        const formatDateStr = (d: Date) => {
            const day = d.getDate().toString().padStart(2, '0');
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const month = months[d.getMonth()];
            const year = d.getFullYear();
            return `${day} ${month} ${year}`;
        };

        // ===== TITLE PAGE =====

        // Navy header bar
        pdf.setFillColor(...NAVY);
        pdf.rect(0, 0, pageWidth, 55, 'F');

        // Title
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(24);
        pdf.setFont('helvetica', 'bold');
        pdf.text("CAPTAIN'S DIARY", pageWidth / 2, 28, { align: 'center' });

        // Subtitle
        pdf.setFontSize(11);
        pdf.setFont('helvetica', 'normal');
        pdf.text('Personal Voyage Journal', pageWidth / 2, 40, { align: 'center' });

        // Date range
        pdf.setFontSize(10);
        pdf.text(`${formatDateStr(startDate)} - ${formatDateStr(endDate)}`, pageWidth / 2, 48, { align: 'center' });

        // Gold accent line
        pdf.setDrawColor(...GOLD);
        pdf.setLineWidth(1.5);
        pdf.line(margin + 20, 53, pageWidth - margin - 20, 53);

        let y = 70;

        // Summary box
        pdf.setDrawColor(200, 200, 200);
        pdf.setLineWidth(0.3);
        pdf.roundedRect(margin, y, contentWidth, 25, 3, 3, 'S');

        const boxY = y + 8;
        const colWidth = contentWidth / 4;

        pdf.setTextColor(...DARK_TEXT);
        pdf.setFontSize(18);
        pdf.setFont('helvetica', 'bold');

        // Entries
        pdf.text(`${sorted.length}`, margin + colWidth * 0.5, boxY, { align: 'center' });
        // Days
        const daySpan = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
        pdf.text(`${daySpan}`, margin + colWidth * 1.5, boxY, { align: 'center' });
        // Photos
        pdf.text(`${totalPhotos}`, margin + colWidth * 2.5, boxY, { align: 'center' });
        // Top Mood
        pdf.text(topMoodCfg.label, margin + colWidth * 3.5, boxY, { align: 'center' });

        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(...GRAY_TEXT);
        pdf.text('Entries', margin + colWidth * 0.5, boxY + 8, { align: 'center' });
        pdf.text('Days', margin + colWidth * 1.5, boxY + 8, { align: 'center' });
        pdf.text('Photos', margin + colWidth * 2.5, boxY + 8, { align: 'center' });
        pdf.text('Top Mood', margin + colWidth * 3.5, boxY + 8, { align: 'center' });

        y += 35;

        // ===== ENTRIES =====

        callbacks?.onProgress?.('Rendering entries...');

        // Preload all photos (limit per entry for performance)
        const photoCache = new Map<string, string>();
        let photoCount = 0;
        for (const entry of sorted) {
            for (const photoUrl of entry.photos.slice(0, 3)) {
                if (photoCount >= 30) break; // Cap total photo loads
                callbacks?.onProgress?.(`Loading photo ${photoCount + 1}...`);
                const base64 = await loadImageAsBase64(photoUrl);
                if (base64) {
                    photoCache.set(photoUrl, base64);
                    photoCount++;
                }
            }
        }

        // Render entries grouped by date
        let entryIdx = 0;
        for (const [dateKey, dayEntries] of grouped) {
            // Date header bar
            if (y > pageHeight - 50) {
                pdf.addPage();
                y = margin + 5;
            }

            pdf.setFillColor(...NAVY);
            pdf.rect(margin, y, contentWidth, 8, 'F');
            pdf.setTextColor(255, 255, 255);
            pdf.setFontSize(9);
            pdf.setFont('helvetica', 'bold');
            pdf.text(dateKey, margin + 4, y + 5.5);
            y += 12;

            for (const entry of dayEntries) {
                entryIdx++;

                // Estimate entry height
                const bodyLines = entry.body ? pdf.splitTextToSize(entry.body, contentWidth - 10) : [];
                const hasPhotos = entry.photos.length > 0 && entry.photos.some(p => photoCache.has(p));
                const photoRowHeight = hasPhotos ? 30 : 0;
                const bodyHeight = Math.min(bodyLines.length * 4.5, 80); // cap body height
                const metaHeight = (entry.location_name || entry.weather_summary) ? 8 : 0;
                const entryHeight = 14 + bodyHeight + photoRowHeight + metaHeight + 6;

                // Page break if needed
                if (y + entryHeight > pageHeight - 20) {
                    pdf.addPage();
                    y = margin + 5;

                    // Continuation header
                    pdf.setFillColor(...NAVY);
                    pdf.rect(margin, y, contentWidth, 8, 'F');
                    pdf.setTextColor(255, 255, 255);
                    pdf.setFontSize(9);
                    pdf.setFont('helvetica', 'bold');
                    pdf.text(`${dateKey} (cont.)`, margin + 4, y + 5.5);
                    y += 12;
                }

                // Entry card background (alternating subtle shading)
                if (entryIdx % 2 === 0) {
                    pdf.setFillColor(...LIGHT_BG);
                    pdf.roundedRect(margin, y, contentWidth, entryHeight, 2, 2, 'F');
                }

                // Border
                pdf.setDrawColor(220, 225, 230);
                pdf.setLineWidth(0.2);
                pdf.roundedRect(margin, y, contentWidth, entryHeight, 2, 2, 'S');

                // Entry header: mood emoji + title + time
                const moodCfg = MOOD_CONFIG[entry.mood] || MOOD_CONFIG.neutral;
                const time = new Date(entry.created_at);
                const timeStr = time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

                // Gold left accent bar
                pdf.setFillColor(...GOLD);
                pdf.rect(margin, y, 2, entryHeight, 'F');

                pdf.setTextColor(...DARK_TEXT);
                pdf.setFontSize(11);
                pdf.setFont('helvetica', 'bold');
                const titleText = `${moodCfg.emoji}  ${entry.title || 'Untitled Entry'}`;
                pdf.text(titleText, margin + 6, y + 7);

                pdf.setTextColor(...GRAY_TEXT);
                pdf.setFontSize(8);
                pdf.setFont('helvetica', 'normal');
                pdf.text(timeStr, pageWidth - margin - 4, y + 7, { align: 'right' });

                // Mood label badge
                pdf.setFontSize(7);
                pdf.text(`[${moodCfg.label.toUpperCase()}]`, pageWidth - margin - 18, y + 7, { align: 'right' });

                let entryY = y + 14;

                // Body text
                if (bodyLines.length > 0) {
                    pdf.setTextColor(60, 70, 80);
                    pdf.setFontSize(9);
                    pdf.setFont('helvetica', 'normal');
                    const displayLines = bodyLines.slice(0, 18); // Cap at ~18 lines
                    pdf.text(displayLines, margin + 6, entryY);
                    entryY += displayLines.length * 4.5;
                    if (bodyLines.length > 18) {
                        pdf.setTextColor(...GRAY_TEXT);
                        pdf.setFontSize(7);
                        pdf.text('[continued...]', margin + 6, entryY);
                        entryY += 4;
                    }
                }

                // Photos
                if (hasPhotos) {
                    entryY += 2;
                    let photoX = margin + 6;
                    const photoSize = 25;
                    for (const photoUrl of entry.photos.slice(0, 4)) {
                        const base64 = photoCache.get(photoUrl);
                        if (base64 && photoX + photoSize < pageWidth - margin) {
                            try {
                                pdf.addImage(base64, 'JPEG', photoX, entryY, photoSize, photoSize);
                                // Photo border
                                pdf.setDrawColor(200, 205, 210);
                                pdf.setLineWidth(0.2);
                                pdf.rect(photoX, entryY, photoSize, photoSize, 'S');
                            } catch (e) {
                                console.warn('[diaryExport]', e);
                                // Skip failed images
                            }
                            photoX += photoSize + 3;
                        }
                    }
                    entryY += photoSize + 3;
                }

                // Meta line: location + weather
                if (entry.location_name || entry.weather_summary || (entry.latitude && entry.longitude)) {
                    pdf.setFontSize(7);
                    pdf.setTextColor(...GRAY_TEXT);
                    pdf.setFont('helvetica', 'normal');

                    const metaParts: string[] = [];
                    if (entry.location_name) {
                        metaParts.push(`Location: ${entry.location_name}`);
                    } else if (entry.latitude && entry.longitude) {
                        metaParts.push(`Position: ${formatCoord(entry.latitude, entry.longitude)}`);
                    }
                    if (entry.weather_summary) {
                        metaParts.push(`Weather: ${entry.weather_summary}`);
                    }

                    pdf.text(metaParts.join('     '), margin + 6, entryY + 2);
                }

                y += entryHeight + 4;
            }
        }

        // ===== PAGE NUMBERS, HEADERS, FOOTERS, WATERMARK =====

        const totalPages = pdf.getNumberOfPages();
        const generatedDate = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'numeric', year: 'numeric' });

        for (let i = 1; i <= totalPages; i++) {
            pdf.setPage(i);

            // Compass rose watermark (bottom-left)
            drawCompassRoseWatermark(pdf, pageWidth, pageHeight);

            // Page header (skip first page - has its own header)
            if (i > 1) {
                pdf.setFillColor(...LIGHT_BG);
                pdf.rect(0, 0, pageWidth, 10, 'F');
                pdf.setFontSize(7);
                pdf.setTextColor(...GRAY_TEXT);
                pdf.setFont('helvetica', 'normal');
                pdf.text("CAPTAIN'S DIARY", pageWidth / 2, 6, { align: 'center' });
            }

            // Page footer
            pdf.setFontSize(7);
            pdf.setTextColor(140, 150, 160);
            pdf.setFont('helvetica', 'normal');
            pdf.text(`Generated by Thalassa Marine Forecasting | ${generatedDate}`, margin, pageHeight - 5);
            pdf.text(`Page ${i} of ${totalPages}`, pageWidth - margin, pageHeight - 5, { align: 'right' });
        }

        // ===== SAVE / SHARE =====

        callbacks?.onProgress?.('Opening PDF...');

        const pdfFilename = `Captains_Diary_${formatDateStr(startDate).replace(/ /g, '_')}_to_${formatDateStr(endDate).replace(/ /g, '_')}.pdf`;

        // Try Web Share API first (mobile)
        const pdfBlob = pdf.output('blob');
        const pdfFile = new File([pdfBlob], pdfFilename, { type: 'application/pdf' });

        if (navigator.share && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
            try {
                await navigator.share({
                    title: "Captain's Diary",
                    text: `${sorted.length} diary entries from ${formatDateStr(startDate)} to ${formatDateStr(endDate)}`,
                    files: [pdfFile]
                });
                callbacks?.onSuccess?.();
            } catch (shareError) {
                if (shareError instanceof Error && shareError.name === 'AbortError') {
                    callbacks?.onSuccess?.();
                } else {
                    pdf.save(pdfFilename);
                    callbacks?.onSuccess?.();
                }
            }
        } else {
            pdf.save(pdfFilename);
            callbacks?.onSuccess?.();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to export diary';
        callbacks?.onError?.(message);
    }
}
