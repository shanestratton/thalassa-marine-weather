#!/usr/bin/env python3
"""Generate the one-page Thalassa Founding Skippers recruitment flyer.

The final PDF is written to ``output/pdf``. A temporary build PDF is kept
under ``tmp/pdfs`` until generation succeeds, then atomically moved into the
final location.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable

from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader


REPO_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = REPO_ROOT / "output" / "pdf"
TMP_DIR = REPO_ROOT / "tmp" / "pdfs"
OUTPUT_PDF = OUTPUT_DIR / "thalassa-founding-skippers-flyer.pdf"
BUILD_PDF = TMP_DIR / "thalassa-founding-skippers-flyer.build.pdf"
LOGO_PATH = REPO_ROOT / "assets" / "brand" / "app-icon-1024.png"

QR_TARGET = "https://www.thalassawx.app/beta?source=moreton-bay-club"
DISPLAY_URL = "www.thalassawx.app/beta"

SLATE_950 = HexColor("#020617")
NAVY = HexColor("#0F172A")
SLATE_800 = HexColor("#1E293B")
SLATE_700 = HexColor("#334155")
SLATE_400 = HexColor("#94A3B8")
SLATE_300 = HexColor("#CBD5E1")
TEAL = HexColor("#5EEAD4")
DEEP_TEAL = HexColor("#0F766E")
ORANGE = HexColor("#FB923C")

PAGE_WIDTH, PAGE_HEIGHT = A4
PAGE_MARGIN = 17 * mm
CONTENT_WIDTH = PAGE_WIDTH - (2 * PAGE_MARGIN)


def _set_alpha(pdf: canvas.Canvas, *, fill: float | None = None, stroke: float | None = None) -> None:
    """Set transparency when the installed ReportLab version supports it."""

    if fill is not None and hasattr(pdf, "setFillAlpha"):
        pdf.setFillAlpha(fill)
    if stroke is not None and hasattr(pdf, "setStrokeAlpha"):
        pdf.setStrokeAlpha(stroke)


def _tracked_width(text: str, font: str, size: float, tracking: float) -> float:
    base = pdfmetrics.stringWidth(text, font, size)
    return base + max(0, len(text) - 1) * tracking


def draw_tracked_text(
    pdf: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    *,
    font: str,
    size: float,
    tracking: float,
    color=white,
    align: str = "left",
) -> None:
    """Draw letter-spaced text with optional right or centre alignment."""

    width = _tracked_width(text, font, size, tracking)
    if align == "center":
        x -= width / 2
    elif align == "right":
        x -= width

    text_object = pdf.beginText(x, y)
    text_object.setFont(font, size)
    text_object.setFillColor(color)
    text_object.setCharSpace(tracking)
    text_object.textOut(text)
    pdf.drawText(text_object)


def wrap_lines(text: str, font: str, size: float, max_width: float) -> list[str]:
    """Wrap plain text by measured PDF width."""

    words = text.split()
    if not words:
        return []

    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if pdfmetrics.stringWidth(candidate, font, size) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def draw_wrapped_text(
    pdf: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    *,
    max_width: float,
    font: str,
    size: float,
    leading: float,
    color,
    max_lines: int | None = None,
) -> float:
    """Draw wrapped text and return the baseline below the last line."""

    lines = wrap_lines(text, font, size, max_width)
    if max_lines is not None and len(lines) > max_lines:
        lines = lines[:max_lines]
        final = lines[-1]
        while final and pdfmetrics.stringWidth(f"{final}...", font, size) > max_width:
            final = final[:-1].rstrip()
        lines[-1] = f"{final}..."

    pdf.setFont(font, size)
    pdf.setFillColor(color)
    for line in lines:
        pdf.drawString(x, y, line)
        y -= leading
    return y


def draw_background(pdf: canvas.Canvas) -> None:
    pdf.setFillColor(SLATE_950)
    pdf.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)

    # A restrained navigation arc gives the page motion without placing
    # decorative strokes through the recruitment copy.
    pdf.saveState()
    _set_alpha(pdf, stroke=0.22)
    pdf.setStrokeColor(ORANGE)
    pdf.setLineWidth(1.1)
    pdf.arc(PAGE_WIDTH - 73 * mm, PAGE_HEIGHT - 77 * mm, PAGE_WIDTH - 7 * mm, PAGE_HEIGHT - 11 * mm, 18, 95)
    pdf.restoreState()

    pdf.setStrokeColor(SLATE_800)
    pdf.setLineWidth(0.8)
    pdf.roundRect(8 * mm, 8 * mm, PAGE_WIDTH - 16 * mm, PAGE_HEIGHT - 16 * mm, 5 * mm, fill=0, stroke=1)


def draw_brand(pdf: canvas.Canvas) -> None:
    if not LOGO_PATH.is_file():
        raise FileNotFoundError(f"Brand asset not found: {LOGO_PATH}")

    logo_size = 47 * mm
    logo_x = PAGE_WIDTH - PAGE_MARGIN - logo_size
    logo_y = PAGE_HEIGHT - 81 * mm
    pdf.drawImage(
        ImageReader(str(LOGO_PATH)),
        logo_x,
        logo_y,
        width=logo_size,
        height=logo_size,
        preserveAspectRatio=True,
        mask="auto",
    )

    centre_x = logo_x + logo_size / 2
    draw_tracked_text(
        pdf,
        "THALASSA",
        centre_x,
        logo_y - 1.5 * mm,
        font="Helvetica-Bold",
        size=12,
        tracking=2.0,
        align="center",
    )
    draw_tracked_text(
        pdf,
        "MARINE DATA & NAVIGATION",
        centre_x,
        logo_y - 7 * mm,
        font="Helvetica-Bold",
        size=5.7,
        tracking=1.0,
        color=SLATE_400,
        align="center",
    )


def draw_header(pdf: canvas.Canvas) -> None:
    draw_tracked_text(
        pdf,
        "MORETON BAY | PUBLIC BETA",
        PAGE_MARGIN,
        PAGE_HEIGHT - 20 * mm,
        font="Helvetica-Bold",
        size=9.5,
        tracking=1.6,
        color=TEAL,
    )

    title_x = PAGE_MARGIN
    title_y = PAGE_HEIGHT - 39 * mm
    for line in ("FOUNDING", "SKIPPERS", "WANTED"):
        pdf.setFont("Helvetica-Bold", 40)
        pdf.setFillColor(white if line != "WANTED" else ORANGE)
        pdf.drawString(title_x, title_y, line)
        title_y -= 14.5 * mm

    subhead = "Help shape Thalassa - an Australian-built marine companion for real boats and real conditions."
    draw_wrapped_text(
        pdf,
        subhead,
        PAGE_MARGIN,
        PAGE_HEIGHT - 98 * mm,
        # Leave a deliberate right-side safety margin. Helvetica's visual
        # overhang made the former full-width line look clipped in print.
        max_width=150 * mm,
        font="Helvetica-Bold",
        size=14.3,
        leading=17.2,
        color=SLATE_300,
        max_lines=2,
    )

    pdf.setStrokeColor(ORANGE)
    pdf.setLineWidth(2.2)
    pdf.line(PAGE_MARGIN, PAGE_HEIGHT - 107 * mm, PAGE_MARGIN + 27 * mm, PAGE_HEIGHT - 107 * mm)


def draw_feature_card(
    pdf: canvas.Canvas,
    x: float,
    y: float,
    width: float,
    height: float,
    number: str,
    title: str,
    body: str,
) -> None:
    pdf.setFillColor(NAVY)
    pdf.setStrokeColor(SLATE_700)
    pdf.setLineWidth(0.7)
    pdf.roundRect(x, y, width, height, 4 * mm, fill=1, stroke=1)

    badge_size = 9 * mm
    badge_x = x + 5 * mm
    badge_y = y + height - 13 * mm
    pdf.setFillColor(DEEP_TEAL)
    pdf.circle(badge_x + badge_size / 2, badge_y + badge_size / 2, badge_size / 2, fill=1, stroke=0)
    draw_tracked_text(
        pdf,
        number,
        badge_x + badge_size / 2,
        badge_y + 2.7 * mm,
        font="Helvetica-Bold",
        size=8.4,
        tracking=0.4,
        align="center",
    )

    draw_tracked_text(
        pdf,
        title,
        x + 5 * mm,
        y + height - 20 * mm,
        font="Helvetica-Bold",
        size=9,
        tracking=0.5,
        color=TEAL,
    )
    draw_wrapped_text(
        pdf,
        body,
        x + 5 * mm,
        y + height - 27 * mm,
        max_width=width - 10 * mm,
        font="Helvetica",
        size=9.3,
        leading=11.8,
        color=SLATE_300,
        max_lines=3,
    )


def draw_features(pdf: canvas.Canvas) -> None:
    draw_tracked_text(
        pdf,
        "ONE APP. THREE JOBS THAT MATTER.",
        PAGE_MARGIN,
        PAGE_HEIGHT - 118 * mm,
        font="Helvetica-Bold",
        size=9,
        tracking=1.2,
        color=SLATE_400,
    )

    gap = 4 * mm
    card_width = (CONTENT_WIDTH - (2 * gap)) / 3
    card_height = 41 * mm
    card_y = PAGE_HEIGHT - 165 * mm
    cards: Iterable[tuple[str, str, str]] = (
        ("01", "PLAN", "Marine weather and practical passage planning."),
        ("02", "WATCH", "Anchor Watch and clear, shareable float plans."),
        ("03", "LOG", "Voyage logging and useful vessel tools."),
    )
    for index, (number, title, body) in enumerate(cards):
        draw_feature_card(
            pdf,
            PAGE_MARGIN + index * (card_width + gap),
            card_y,
            card_width,
            card_height,
            number,
            title,
            body,
        )


def draw_qr(pdf: canvas.Canvas, x: float, y: float, size: float) -> None:
    if size < 40 * mm:
        raise ValueError("The printed QR code must be at least 40 mm square.")

    tile_padding = 3 * mm
    pdf.setFillColor(white)
    pdf.roundRect(
        x - tile_padding,
        y - tile_padding,
        size + 2 * tile_padding,
        size + 2 * tile_padding,
        2.5 * mm,
        fill=1,
        stroke=0,
    )

    widget = QrCodeWidget(QR_TARGET)
    widget.barFillColor = SLATE_950
    left, bottom, right, top = widget.getBounds()
    widget_width = right - left
    widget_height = top - bottom
    scale_x = size / widget_width
    scale_y = size / widget_height
    drawing = Drawing(
        size,
        size,
        transform=[scale_x, 0, 0, scale_y, -left * scale_x, -bottom * scale_y],
    )
    drawing.add(widget)
    renderPDF.draw(drawing, pdf, x, y)


def draw_call_to_action(pdf: canvas.Canvas) -> None:
    panel_x = PAGE_MARGIN
    panel_y = 42 * mm
    panel_width = CONTENT_WIDTH
    panel_height = 73 * mm

    pdf.setFillColor(NAVY)
    pdf.setStrokeColor(SLATE_700)
    pdf.setLineWidth(0.8)
    pdf.roundRect(panel_x, panel_y, panel_width, panel_height, 5 * mm, fill=1, stroke=1)

    text_x = panel_x + 7 * mm
    # Stop every line well before the QR tile, even after printer scaling or
    # PDF viewer font substitution.
    text_width = 99 * mm
    pdf.setFillColor(white)
    pdf.setFont("Helvetica-Bold", 20)
    pdf.drawString(text_x, panel_y + panel_height - 15 * mm, "TAKE IT BOATING.")
    pdf.setFillColor(ORANGE)
    pdf.drawString(text_x, panel_y + panel_height - 25 * mm, "TELL US STRAIGHT.")

    body = (
        "We are inviting a small crew of active Moreton Bay skippers - sail or power - "
        "to test Thalassa on real days on the water. You will need an iPhone or iPad "
        "running iOS 17 or later and a willingness to give practical feedback."
    )
    draw_wrapped_text(
        pdf,
        body,
        text_x,
        panel_y + panel_height - 37 * mm,
        max_width=text_width,
        font="Helvetica",
        size=9.8,
        leading=12.4,
        color=SLATE_300,
        max_lines=6,
    )

    draw_tracked_text(
        pdf,
        "NO DEMO. NO SALES PITCH. APPLY IN UNDER 60 SECONDS.",
        text_x,
        panel_y + 8 * mm,
        font="Helvetica-Bold",
        size=7.6,
        tracking=0.55,
        color=TEAL,
    )

    qr_size = 44 * mm
    qr_x = panel_x + panel_width - qr_size - 7 * mm
    qr_y = panel_y + 10 * mm
    draw_tracked_text(
        pdf,
        "SCAN TO APPLY",
        qr_x + qr_size / 2,
        panel_y + panel_height - 9 * mm,
        font="Helvetica-Bold",
        size=9.2,
        tracking=1.1,
        color=ORANGE,
        align="center",
    )
    draw_qr(pdf, qr_x, qr_y, qr_size)
    draw_tracked_text(
        pdf,
        DISPLAY_URL,
        qr_x + qr_size / 2,
        panel_y + 4 * mm,
        font="Helvetica-Bold",
        size=7.3,
        tracking=0.25,
        color=SLATE_300,
        align="center",
    )


def draw_footer(pdf: canvas.Canvas) -> None:
    disclaimer = (
        "BETA SOFTWARE - Thalassa is a supplementary planning and awareness tool. "
        "It does not replace official charts, forecasts, independent safety equipment, "
        "a proper watch or normal seamanship."
    )
    draw_wrapped_text(
        pdf,
        disclaimer,
        PAGE_MARGIN,
        31 * mm,
        max_width=CONTENT_WIDTH,
        font="Helvetica",
        size=7.6,
        leading=9.4,
        color=SLATE_400,
        max_lines=2,
    )

    pdf.setStrokeColor(SLATE_800)
    pdf.setLineWidth(0.6)
    pdf.line(PAGE_MARGIN, 20 * mm, PAGE_WIDTH - PAGE_MARGIN, 20 * mm)
    draw_tracked_text(
        pdf,
        "BUILT IN AUSTRALIA FOR REAL BOATS, REAL CONDITIONS.",
        PAGE_MARGIN,
        14.5 * mm,
        font="Helvetica-Bold",
        size=7.2,
        tracking=0.85,
        color=TEAL,
    )
    pdf.setFont("Helvetica", 7.2)
    pdf.setFillColor(SLATE_400)
    pdf.drawRightString(PAGE_WIDTH - PAGE_MARGIN, 14.5 * mm, "THALASSA | 2026")


def generate_flyer() -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)

    pdf = canvas.Canvas(str(BUILD_PDF), pagesize=A4, pageCompression=1)
    pdf.setTitle("Thalassa Founding Skippers - Moreton Bay")
    pdf.setAuthor("Thalassa")
    pdf.setSubject("Public beta recruitment flyer")
    pdf.setCreator("Thalassa ReportLab flyer generator")

    draw_background(pdf)
    draw_brand(pdf)
    draw_header(pdf)
    draw_features(pdf)
    draw_call_to_action(pdf)
    draw_footer(pdf)
    pdf.showPage()
    pdf.save()

    os.replace(BUILD_PDF, OUTPUT_PDF)
    return OUTPUT_PDF


def main() -> None:
    output_path = generate_flyer()
    print(output_path)


if __name__ == "__main__":
    main()
