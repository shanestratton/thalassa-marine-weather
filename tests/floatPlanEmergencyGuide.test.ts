import { describe, expect, it } from 'vitest';

import { createFloatPlanSharePayload } from '../services/floatPlan';
import type { FloatPlanInput } from '../services/floatPlan';

const NOW = 1788000000000;

function guideFor(vessel: Record<string, unknown>): string {
    const text = createFloatPlanSharePayload(
        {
            vessel: { name: 'Serene Summer', type: 'sail', ...vessel },
            route: { from: 'Newport, QLD', to: 'Mooloolaba', waypoints: [] },
            departureMs: NOW,
            overdueMs: NOW + 12 * 3600e3,
            personsOnBoard: 2,
            whoToCall: 'Marine Rescue Redcliffe — 07 3203 5522',
            contactAboard: 'Sat phone +881 6234 5678',
            timeZone: 'Australia/Brisbane',
        } as unknown as FloatPlanInput,
        'email',
    ).text;
    return text.slice(text.indexOf('IF WE ARE OVERDUE'));
}

describe('overdue guide', () => {
    it('gives explicit permission to do nothing before the overdue time', () => {
        // A holder who panics early burns the goodwill that gets a real search
        // started, and the paper form never says this out loud.
        expect(guideFor({})).toMatch(/Nothing needs doing before/i);
    });

    it('names the shore contacts when the vessel has them', () => {
        const guide = guideFor({
            shoreContact1: 'Jane Stratton — 0412 345 678',
            shoreContact2: 'Redcliffe Marina — 07 3269 1234',
        });
        expect(guide).toContain('Jane Stratton — 0412 345 678');
        expect(guide).toContain('Redcliffe Marina — 07 3269 1234');
        expect(guide).toMatch(/Ring the people ashore/i);
    });

    it('still gives a usable step when no shore contacts are set', () => {
        // The guide must never degrade into a blank rung: a plan filled in
        // hastily before leaving is the normal case, not the exception.
        const guide = guideFor({});
        expect(guide).toMatch(/Ask anyone else who might have heard/i);
        expect(guide).not.toContain('undefined');
    });

    it('always ends with the number to ring and how to speak to them', () => {
        const guide = guideFor({});
        expect(guide).toContain('Marine Rescue Redcliffe — 07 3203 5522');
        expect(guide).toMatch(/I am reporting an overdue vessel/i);
        expect(guide).toMatch(/say you do not know/i);
    });
});

describe('every channel tells the holder what to do', () => {
    // The guide shipped on the email brief only at first, which meant the most
    // likely way this is actually sent — WhatsApp to a mate — carried the facts
    // and no instruction. A holder with a plan and no idea what to do with it is
    // the failure this whole feature exists to prevent.
    const input = {
        vessel: { name: 'Serene Summer', type: 'sail', shoreContact1: 'Jane — 0412 345 678' },
        route: { from: 'Newport', to: 'Mooloolaba', waypoints: [] },
        departureMs: NOW,
        overdueMs: NOW + 12 * 3600e3,
        personsOnBoard: 2,
        whoToCall: 'Marine Rescue Redcliffe — 07 3203 5522',
        contactAboard: 'Sat phone',
        timeZone: 'Australia/Brisbane',
    } as unknown as FloatPlanInput;

    it.each(['email', 'whatsapp', 'generic'] as const)('%s carries the full ladder', (channel) => {
        const text = createFloatPlanSharePayload(input, channel).text;
        expect(text).toMatch(/IF WE ARE OVERDUE/i);
        expect(text).toMatch(/Try us first/i);
        expect(text).toContain('Marine Rescue Redcliffe — 07 3203 5522');
    });

    it('sms carries the escalation order without the full ladder', () => {
        // Every line here is another segment, and a truncated guide is worse
        // than a short one that is complete.
        const text = createFloatPlanSharePayload(input, 'sms').text;
        expect(text).toMatch(/IF OVERDUE/i);
        expect(text).toMatch(/do not guess/i);
        expect(text).toMatch(/OVERDUE:/);
        expect(text).toMatch(/CALL:/);
    });
});
