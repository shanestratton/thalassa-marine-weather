#!/usr/bin/env python3
"""Generate the one-page Thalassa Founding Skippers recruitment flyer.

The final PDF is written to ``output/pdf``. A temporary build PDF is kept
under ``tmp/pdfs`` until generation succeeds, then atomically moved into the
final location.
"""

from __future__ import annotations

import os
from pathlib import Path

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
MARKETING_ASSET_DIR = REPO_ROOT / "assets" / "marketing" / "founding-skippers"
WATER_CROWN_PATH = MARKETING_ASSET_DIR / "water-crown.png"
GLASS_SCREEN_PATH = MARKETING_ASSET_DIR / "glass.png"
OBS_SCREEN_PATH = MARKETING_ASSET_DIR / "obs-wind.png"

QR_TARGET = "https://www.thalassawx.app/beta?source=moreton-bay-club"
DISPLAY_URL = "www.thalassawx.app/beta"

SLATE_950 = HexColor("#020617")
NAVY = HexColor("#0F172A")
SLATE_800 = HexColor("#1E293B")
SLATE_700 = HexColor("#334155")
SLATE_400 = HexColor("#94A3B8")
SLATE_300 = HexColor("#CBD5E1")
TEAL = HexColor("#5EEAD4")
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

    pdf.setStrokeColor(SLATE_800)
    pdf.setLineWidth(0.8)
    pdf.roundRect(8 * mm, 8 * mm, PAGE_WIDTH - 16 * mm, PAGE_HEIGHT - 16 * mm, 5 * mm, fill=0, stroke=1)


def draw_brand(pdf: canvas.Canvas) -> None:
    if not LOGO_PATH.is_file():
        raise FileNotFoundError(f"Brand asset not found: {LOGO_PATH}")

    logo_size = 12.5 * mm
    logo_x = PAGE_MARGIN
    logo_y = PAGE_HEIGHT - 27 * mm
    pdf.drawImage(
        ImageReader(str(LOGO_PATH)),
        logo_x,
        logo_y,
        width=logo_size,
        height=logo_size,
        preserveAspectRatio=True,
        mask="auto",
    )

    text_x = logo_x + logo_size + 4 * mm
    draw_tracked_text(
        pdf,
        "THALASSA",
        text_x,
        logo_y + 7.2 * mm,
        font="Helvetica-Bold",
        size=12.5,
        tracking=1.9,
    )
    draw_tracked_text(
        pdf,
        "THE SAILOR'S ASSISTANT",
        text_x,
        logo_y + 2.4 * mm,
        font="Helvetica-Bold",
        size=5.8,
        tracking=1.15,
        color=SLATE_300,
    )


def draw_header(pdf: canvas.Canvas) -> None:
    draw_tracked_text(
        pdf,
        "MORETON BAY | PUBLIC BETA",
        PAGE_MARGIN,
        PAGE_HEIGHT - 43 * mm,
        font="Helvetica-Bold",
        size=8.5,
        tracking=1.25,
        color=TEAL,
    )

    title_x = PAGE_MARGIN
    title_y = PAGE_HEIGHT - 61 * mm
    for line in ("FOUNDING", "SKIPPERS", "WANTED"):
        pdf.setFont("Helvetica-Bold", 31.5)
        pdf.setFillColor(white if line != "WANTED" else ORANGE)
        pdf.drawString(title_x, title_y, line)
        title_y -= 11.7 * mm

    subhead = "Help shape an Australian-built marine companion on real boats, in real conditions."
    draw_wrapped_text(
        pdf,
        subhead,
        PAGE_MARGIN,
        PAGE_HEIGHT - 105 * mm,
        max_width=78 * mm,
        font="Helvetica-Bold",
        size=11.4,
        leading=13.8,
        color=SLATE_300,
        max_lines=4,
    )

    pdf.setStrokeColor(ORANGE)
    pdf.setLineWidth(2.2)
    pdf.line(PAGE_MARGIN, PAGE_HEIGHT - 128 * mm, PAGE_MARGIN + 22 * mm, PAGE_HEIGHT - 128 * mm)


def draw_features(pdf: canvas.Canvas) -> None:
    draw_tracked_text(
        pdf,
        "ONE APP. THREE JOBS THAT MATTER.",
        PAGE_MARGIN,
        157 * mm,
        font="Helvetica-Bold",
        size=7.5,
        tracking=0.8,
        color=SLATE_300,
    )

    chip_y = 140 * mm
    chip_width = 23 * mm
    chip_height = 10.5 * mm
    gap = 3 * mm
    for index, label in enumerate(("PLAN", "WATCH", "LOG")):
        x = PAGE_MARGIN + index * (chip_width + gap)
        pdf.saveState()
        _set_alpha(pdf, fill=0.86, stroke=0.9)
        pdf.setFillColor(NAVY)
        pdf.setStrokeColor(TEAL if index == 1 else SLATE_700)
        pdf.setLineWidth(0.75)
        pdf.roundRect(x, chip_y, chip_width, chip_height, 3.5 * mm, fill=1, stroke=1)
        pdf.restoreState()
        draw_tracked_text(
            pdf,
            label,
            x + chip_width / 2,
            chip_y + 3.5 * mm,
            font="Helvetica-Bold",
            size=7.3,
            tracking=0.75,
            color=TEAL if index == 1 else white,
            align="center",
        )

    draw_wrapped_text(
        pdf,
        "Weather. Passages. Anchor Watch. Voyage logging.",
        PAGE_MARGIN,
        133.5 * mm,
        max_width=77 * mm,
        font="Helvetica",
        size=7.7,
        leading=9.2,
        color=SLATE_300,
        max_lines=2,
    )


def draw_phone(
    pdf: canvas.Canvas,
    screenshot_path: Path,
    *,
    x: float,
    y: float,
    screen_width: float,
    angle: float,
    accent,
) -> None:
    """Place an untouched app screenshot inside a print-ready phone shell."""

    if not screenshot_path.is_file():
        raise FileNotFoundError(f"App screenshot not found: {screenshot_path}")

    image = ImageReader(str(screenshot_path))
    image_width, image_height = image.getSize()
    screen_height = screen_width * image_height / image_width
    bezel = 1.55 * mm
    outer_width = screen_width + 2 * bezel
    outer_height = screen_height + 2 * bezel
    radius = 5.3 * mm

    pdf.saveState()
    pdf.translate(x, y)
    pdf.rotate(angle)

    pdf.saveState()
    _set_alpha(pdf, fill=0.5)
    pdf.setFillColor(SLATE_950)
    pdf.roundRect(2.4 * mm, -2.8 * mm, outer_width, outer_height, radius + bezel, fill=1, stroke=0)
    pdf.restoreState()

    pdf.setFillColor(HexColor("#05080D"))
    pdf.setStrokeColor(accent)
    pdf.setLineWidth(0.8)
    pdf.roundRect(0, 0, outer_width, outer_height, radius + bezel, fill=1, stroke=1)

    # Clip only the screenshot corners; the pixels themselves remain exactly
    # as supplied, including the real iOS chrome and Thalassa navigation.
    pdf.saveState()
    clip = pdf.beginPath()
    clip.roundRect(bezel, bezel, screen_width, screen_height, radius)
    pdf.clipPath(clip, stroke=0, fill=0)
    pdf.drawImage(
        image,
        bezel,
        bezel,
        width=screen_width,
        height=screen_height,
        preserveAspectRatio=False,
        mask="auto",
    )
    pdf.restoreState()

    pdf.setStrokeColor(HexColor("#334155"))
    pdf.setLineWidth(0.45)
    pdf.roundRect(bezel, bezel, screen_width, screen_height, radius, fill=0, stroke=1)

    # A restrained hardware cue turns the screenshot into a device without
    # covering the supplied interface or pretending to be a specific model.
    pdf.saveState()
    _set_alpha(pdf, fill=0.94)
    pdf.setFillColor(HexColor("#020407"))
    island_width = min(13 * mm, screen_width * 0.32)
    pdf.roundRect(
        bezel + (screen_width - island_width) / 2,
        bezel + screen_height - 5.3 * mm,
        island_width,
        2.9 * mm,
        1.45 * mm,
        fill=1,
        stroke=0,
    )
    pdf.restoreState()

    pdf.setStrokeColor(HexColor("#64748B"))
    pdf.setLineWidth(0.8)
    pdf.line(-0.45 * mm, outer_height - 36 * mm, -0.45 * mm, outer_height - 22 * mm)
    pdf.line(outer_width + 0.45 * mm, outer_height - 35 * mm, outer_width + 0.45 * mm, outer_height - 18 * mm)
    pdf.restoreState()


def draw_product_visual(pdf: canvas.Canvas) -> None:
    if not WATER_CROWN_PATH.is_file():
        raise FileNotFoundError(f"Water framing asset not found: {WATER_CROWN_PATH}")

    # The transparent crown is intentionally a little larger than the phone
    # cluster: its side curls and lower rim remain visible after the screens
    # are placed, creating the promised water-wrapped device treatment.
    crown_width = 111 * mm
    crown_reader = ImageReader(str(WATER_CROWN_PATH))
    crown_source_width, crown_source_height = crown_reader.getSize()
    crown_height = crown_width * crown_source_height / crown_source_width
    pdf.drawImage(
        crown_reader,
        99 * mm,
        124 * mm,
        width=crown_width,
        height=crown_height,
        preserveAspectRatio=False,
        mask="auto",
    )

    # OBS supplies the movement and colour; The Glass leads with the app's
    # clearest value proposition. Both remain large enough to read in print.
    draw_phone(
        pdf,
        OBS_SCREEN_PATH,
        x=102 * mm,
        y=136 * mm,
        screen_width=46 * mm,
        angle=-7.0,
        accent=HexColor("#38BDF8"),
    )
    draw_phone(
        pdf,
        GLASS_SCREEN_PATH,
        x=143 * mm,
        y=137 * mm,
        screen_width=52 * mm,
        angle=3.4,
        accent=TEAL,
    )

    # Small captions stay outside the screens, so the authentic UI remains
    # untouched while a quick glance still explains the two views.
    for label, x, width, color in (
        ("OBS · LIVE WEATHER", 99 * mm, 48 * mm, HexColor("#38BDF8")),
        ("THE GLASS", 151 * mm, 42 * mm, TEAL),
    ):
        pdf.saveState()
        _set_alpha(pdf, fill=0.9)
        pdf.setFillColor(SLATE_950)
        pdf.setStrokeColor(color)
        pdf.setLineWidth(0.55)
        pdf.roundRect(x, 126 * mm, width, 7.5 * mm, 3.5 * mm, fill=1, stroke=1)
        pdf.restoreState()
        draw_tracked_text(
            pdf,
            label,
            x + width / 2,
            128.3 * mm,
            font="Helvetica-Bold",
            size=5.8,
            tracking=0.55,
            color=color,
            align="center",
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
    draw_product_visual(pdf)
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
