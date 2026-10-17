/** Popup-only light illustrations. SIGPER is a complete cycle, not a flash
 * duration. Without SIGSEQ pulse widths are explicitly illustrative.
 * No clocks, map-layer hooks, source mutation or navigation state. */
import { LITCHR_LABELS, readS57 } from '../../services/enc/types';

type Interval = { on: boolean; seconds: number };
export type LightRhythm =
    | { state: 'unavailable' }
    | { state: 'fixed' | 'animated'; colour: string; period: number; exact: boolean; intervals: Interval[] };
const unavailable: LightRhythm = { state: 'unavailable' };
const colours: Record<string, string> = {
    white: '#ffffff',
    red: '#ef4444',
    green: '#22c55e',
    blue: '#3b82f6',
    yellow: '#fde047',
    amber: '#f59e0b',
    orange: '#fb923c',
    violet: '#a78bfa',
    magenta: '#e879f9',
};
const encColours: Record<string, string> = {
    '1': 'white',
    '3': 'red',
    '4': 'green',
    '5': 'blue',
    '6': 'yellow',
    '9': 'amber',
    '10': 'violet',
    '11': 'orange',
    '12': 'magenta',
};
const text = (value: unknown, limit = 64): string =>
    (typeof value === 'string' || typeof value === 'number') && String(value).length <= limit
        ? String(value).trim()
        : '';
const positive = (value: unknown): number => {
    const raw = text(value);
    return /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
};

function rhythm(
    character: string,
    colour: string,
    periodValue: unknown,
    groupValue: unknown,
    sequenceValue: unknown,
): LightRhythm {
    const hex = Object.hasOwn(colours, colour) ? colours[colour] : undefined;
    if (
        !hex ||
        !Object.values(LITCHR_LABELS).includes(character) ||
        character.startsWith('Al') ||
        ['FFl', 'FLFl'].includes(character)
    )
        return unavailable;
    const sequence = text(sequenceValue, 256);
    if (sequenceValue != null && sequenceValue !== '' && !sequence) return unavailable;
    if (character === 'F')
        return sequence ? unavailable : { state: 'fixed', colour: hex, period: 0, exact: true, intervals: [] };
    const period = positive(periodValue);
    if (!(period >= 0.25 && period <= 120)) return unavailable;
    const group = text(groupValue),
        simpleGroup = /^(?:\(\d{1,2}\)|\d{1,2})$/.test(group);
    const validGroup = simpleGroup || /^(?:\(\d{1,2}(?:\+\d{1,2})+\)|(?:\(\d{1,2}\)){2,3})$/.test(group);
    const count = !group
        ? 1
        : validGroup
          ? [...group.matchAll(/\d+/g)].reduce((sum, value) => sum + Number(value[0]), 0)
          : NaN;
    if (sequence) {
        // S-57/OSM sequence notation: light/eclipses, reversed for Oc. Accept
        // numeric pairs with optional parentheses and +/comma separators only.
        const raw = sequence.replace(/\s/g, '');
        const number = '\\d+(?:\\.\\d+)?';
        const pair = `(?:${number}\\+?\\(${number}\\)|\\(${number}\\)\\+?${number})`;
        if (!new RegExp(`^(?:${pair}(?:[+,]?${pair})*|${number}(?:[+,]${number})+)$`).test(raw)) return unavailable;
        const values = [...raw.matchAll(/\d+(?:\.\d+)?/g)].map((value) => Number(value[0]));
        if (
            values.length < 2 ||
            values.length > 32 ||
            values.length % 2 ||
            values.some((value) => value < 0.02 || value > 120)
        )
            return unavailable;
        if (Math.abs(values.reduce((sum, value) => sum + value, 0) - period) > 0.000001) return unavailable;
        const intervals = values.map((seconds, index) => ({ on: (index % 2 === 0) !== (character === 'Oc'), seconds }));
        if (
            character !== 'Mo' &&
            group &&
            (!(count >= 1 && count <= 12) ||
                intervals.filter((value) => value.on !== (character === 'Oc')).length !== count)
        )
            return unavailable;
        if (!validDuty(character, intervals)) return unavailable;
        return { state: 'animated', colour: hex, period, exact: true, intervals };
    }
    if (!(count >= 1 && count <= 12) || (group && !simpleGroup)) return unavailable;
    if (character === 'Iso') {
        if (group && count !== 1) return unavailable;
        return {
            state: 'animated',
            colour: hex,
            period,
            exact: true,
            intervals: [
                { on: true, seconds: period / 2 },
                { on: false, seconds: period / 2 },
            ],
        };
    }
    if (!['Fl', 'LFl', 'Oc', 'Q', 'VQ', 'UQ'].includes(character)) return unavailable;
    const quick = ({ Q: 1, VQ: 0.5, UQ: 0.25 } as Record<string, number>)[character];
    // An ungrouped quick light is continuous. Never turn its unknown rate into
    // one guessed flash every several seconds.
    if (quick && !group && Math.abs(period - quick) > 0.005) return unavailable;
    const spacing = quick ?? period / (count + 1);
    const pulse = character === 'LFl' ? 2 : Math.min(0.5, spacing / 4);
    if (pulse >= spacing || (quick && period < count * spacing)) return unavailable;
    const intervals: Interval[] = [];
    for (let index = 0; index < count; index++) {
        intervals.push({ on: character !== 'Oc', seconds: pulse });
        intervals.push({
            on: character === 'Oc',
            seconds: index === count - 1 ? period - index * spacing - pulse : spacing - pulse,
        });
    }
    if (!validDuty(character, intervals)) return unavailable;
    return { state: 'animated', colour: hex, period, exact: false, intervals };
}

function validDuty(character: string, intervals: Interval[]): boolean {
    const light = intervals.filter((value) => value.on),
        dark = intervals.filter((value) => !value.on);
    const on = light.reduce((sum, value) => sum + value.seconds, 0),
        off = dark.reduce((sum, value) => sum + value.seconds, 0);
    return (
        intervals.every((value) => Number.isFinite(value.seconds) && value.seconds >= 0.02) &&
        (character !== 'Fl' || on < off) &&
        (character !== 'Oc' || on > off) &&
        (character !== 'LFl' || light.every((value) => value.seconds >= 2)) &&
        (character !== 'Iso' || intervals.every((value) => Math.abs(value.seconds - intervals[0].seconds) <= 0.005))
    );
}

export function encLightRhythm(props: Record<string, unknown>): LightRhythm {
    const character = LITCHR_LABELS[text(readS57(props, 'LITCHR'))] ?? '';
    const colourCode = text(readS57(props, 'COLOUR'));
    const colour = Object.hasOwn(encColours, colourCode) ? encColours[colourCode] : '';
    return rhythm(character, colour, readS57(props, 'SIGPER'), readS57(props, 'SIGGRP'), readS57(props, 'SIGSEQ'));
}

export function osmLightRhythm(tags: Record<string, string>, prefix = 'light:'): LightRhythm {
    return rhythm(
        text(tags[prefix + 'character']),
        text(tags[prefix + 'colour']).toLowerCase(),
        tags[prefix + 'period'],
        tags[prefix + 'group'],
        tags[prefix + 'sequence'],
    );
}

/** All interpolated markup is validated finite numbers or constant palettes.
 * CSS animations stop with popup DOM removal, need no timer/listener, and
 * become a static source-colour swatch when reduced motion changes live. */
export function lightRhythmHtml(model: LightRhythm): string {
    if (model.state === 'unavailable')
        return '<div class="light-rhythm" style="font-size:11px;margin-top:8px">Rhythm preview unavailable</div>';
    const fixed = model.state === 'fixed';
    const name =
        'light-rhythm-' +
        String(model.period).replace('.', '-') +
        '-' +
        model.intervals.map((value) => `${value.on ? 1 : 0}-${Math.round(value.seconds * 1e6)}`).join('-');
    let seconds = 0;
    const frames = model.intervals
        .map((value) => {
            const frame = `${Number(((seconds / model.period) * 100).toFixed(7))}%{opacity:${value.on ? 1 : 0}}`;
            seconds += value.seconds;
            return frame;
        })
        .join('');
    const note = fixed ? 'Fixed light' : `${model.exact ? 'Reported' : 'Illustrative'} rhythm · ${model.period} s`;
    const motionNote = fixed
        ? ''
        : '<br><span class="light-rhythm-playing">Not synchronised to the light</span><span class="light-rhythm-static">Static · reduced motion</span>';
    const style = fixed
        ? ''
        : `<style>@keyframes ${name}{${frames}100%{opacity:${model.intervals[0].on ? 1 : 0}}}.light-rhythm-static{display:none}@media(prefers-reduced-motion:reduce){.light-rhythm .light-rhythm-lamp{animation:none!important;opacity:1!important}.light-rhythm-playing{display:none}.light-rhythm-static{display:inline}}</style>`;
    return `<div class="light-rhythm" style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11px;line-height:1.4;overflow-wrap:anywhere"><svg aria-hidden="true" width="28" height="28" viewBox="0 0 28 28" style="flex-shrink:0;background:#0f172a;border-radius:50%"><circle class="light-rhythm-lamp" cx="14" cy="14" r="7" fill="${model.colour}"${fixed ? '' : ` style="animation:${name} ${model.period}s step-end infinite"`}/></svg><span>${note}${motionNote}</span>${style}</div>`;
}
