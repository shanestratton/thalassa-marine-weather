import { createFloatPlanSharePayload, prepareFloatPlan, type FloatPlanInput } from './floatPlan';
import { createLogger } from '../utils/createLogger';

const log = createLogger('floatPlanPdf');

/**
 * The float plan as a PDF, for a shore contact who wants a document.
 *
 * Not everyone is comfortable with a link, and a printed page on the fridge
 * still works when the holder's phone is flat and the boat is overdue. So the
 * PDF is a first-class delivery, not a fallback.
 *
 * It renders the EMAIL brief rather than composing its own layout. That text is
 * already the considered version, and a second formatter would drift from it —
 * the two would disagree eventually, and the safety document is the wrong place
 * to discover which one is stale.
 */

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(input: FloatPlanInput): { html: string; filename: string } {
    const payload = createFloatPlanSharePayload(input, 'email');
    const headline = prepareFloatPlan(input);

    const safeName = `Float plan - ${headline.vesselName}`.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'Float plan';

    // The overdue time is the whole reason the document exists, so it is the
    // one thing set large enough to read across a kitchen. Everything else is
    // reference; this is the instruction.
    const html = `<div style="font-family: Helvetica, Arial, sans-serif; color:#111; padding:24px 28px; width:740px;">
  <div style="border-bottom:2px solid #111; padding-bottom:10px; margin-bottom:16px;">
    <div style="font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#555;">Float plan</div>
    <div style="font-size:24px; font-weight:bold; margin-top:2px;">${escapeHtml(headline.vesselName)}</div>
  </div>

  <div style="border:2px solid #b00; padding:12px 14px; margin-bottom:18px;">
    <div style="font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#b00; font-weight:bold;">
      If there is no contact by
    </div>
    <div style="font-size:22px; font-weight:bold; margin:4px 0 6px;">${escapeHtml(headline.overdue)}</div>
    <div style="font-size:13px;">Call: <strong>${escapeHtml(headline.rescueContact)}</strong></div>
  </div>

  <pre style="font-family: Helvetica, Arial, sans-serif; font-size:12px; line-height:1.5; white-space:pre-wrap; margin:0;">${escapeHtml(payload.text)}</pre>

  <div style="margin-top:22px; padding-top:10px; border-top:1px solid #bbb; font-size:10px; color:#666;">
    Do not file this plan with a rescue authority — it is for the person holding it.
    Ask the boat to confirm arrival, and if the overdue time passes without contact, make the call above.
  </div>
</div>`;

    return { html, filename: safeName };
}

/** Render the plan to PDF and hand it to the share sheet (email, WhatsApp, Files). */
export async function shareFloatPlanPdf(input: FloatPlanInput): Promise<void> {
    const { html, filename } = buildHtml(input);
    const safeName = `${filename}.pdf`;

    const { default: jsPDF } = await import('jspdf');
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    await new Promise<void>((resolve) => {
        doc.html(html, { callback: () => resolve(), x: 0, y: 0, width: 210, windowWidth: 800, autoPaging: 'text' });
    });

    const blob = doc.output('blob');
    const file = new File([blob], safeName, { type: 'application/pdf' });
    log.info(`[FloatPlanPdf] ${safeName} (${blob.size} bytes)`);

    if (navigator.share && navigator.canShare?.({ files: [file] })) {
        try {
            await navigator.share({ title: filename, files: [file] });
            return;
        } catch (err) {
            // A dismissed share sheet is a decision, not a failure.
            if (err instanceof Error && err.name === 'AbortError') return;
        }
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
}

export const __testing = { buildHtml };
