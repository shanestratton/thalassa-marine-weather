/**
 * CrewFloatPlanCard — the skipper's float plan, as crew may see it (the
 * crewing view, 2026-10-03).
 *
 * The float plan stays the skipper's: one boat needs one holder and one
 * overdue time, and a crew-sent plan would carry the crew's OWN boat profile.
 * So this card is read-only, with nothing to send, copy or print. It shows
 * what a crew member needs to make a Mayday (name, type, hull colour,
 * registration, MMSI, call sign, hailing port), who is aboard, the selected
 * shared passage, and the safety basics (liferaft, flares). It renders only
 * the allow-listed fields it names below: never the EPIRB hex, shore
 * contacts, phones, ages or medical, which go "only in the float plan, to one
 * chosen person" (types/vessel.ts).
 */
import React from 'react';
import { crewRoleLabel, type CrewVesselView } from '../../services/crew/crewVesselView';

export interface CrewFloatPlanPassage {
    departure_port?: string | null;
    destination_port?: string | null;
    departure_time?: string | null;
    eta?: string | null;
}

interface CrewFloatPlanCardProps {
    boatName: string;
    view: CrewVesselView | null;
    passage: CrewFloatPlanPassage | null;
}

function when(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isFinite(date.getTime())
        ? date.toLocaleString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
          })
        : null;
}

function typeLine(type: string | undefined, model: string | undefined): string | null {
    const label = type === 'sail' ? 'Sail' : type === 'power' ? 'Power' : type === 'observer' ? 'Observer' : type;
    return [label, model].filter(Boolean).join(' · ') || null;
}

const Row: React.FC<{ label: string; value: string | null | undefined }> = ({ label, value }) =>
    value ? (
        <div className="flex items-baseline justify-between gap-3 py-1">
            <dt className="text-[11px] uppercase tracking-wide text-gray-500">{label}</dt>
            <dd className="text-[13px] font-semibold text-white text-right">{value}</dd>
        </div>
    ) : null;

export const CrewFloatPlanCard: React.FC<CrewFloatPlanCardProps> = ({ boatName, view, passage }) => {
    const vessel = view?.vessel ?? null;
    const skipperName = view?.manifest.find((entry) => entry.isSkipper)?.name || 'The skipper';
    // FloatPlanSheet's precedence: the skipper's vessel-profile roster, else the app crew.
    const people =
        view && view.roster.length > 0
            ? view.roster.map((person) => ({ name: person.name, role: person.rank }))
            : (view?.manifest ?? [])
                  .filter((entry) => entry.name)
                  .map((entry) => ({ name: entry.name, role: crewRoleLabel(entry.role) }));
    const route =
        passage && (passage.departure_port || passage.destination_port)
            ? `${passage.departure_port || '—'} → ${passage.destination_port || '—'}`
            : null;
    const raft =
        typeof vessel?.liferaftCapacity === 'number'
            ? `${vessel.liferaftCapacity} people${vessel.liferaftServiceDate ? ` · serviced ${vessel.liferaftServiceDate}` : ''}`
            : vessel?.liferaftServiceDate
              ? `Serviced ${vessel.liferaftServiceDate}`
              : null;
    const title = `Float plan — ${boatName}`;

    return (
        <section
            aria-label={title}
            data-testid="crew-float-plan-card"
            className="mb-5 rounded-2xl border border-sky-500/15 bg-sky-500/4 p-4"
        >
            <h3 className="text-sm font-black text-white">{title}</h3>

            {vessel && (
                <dl className="mt-3 divide-y divide-white/5">
                    <Row label="Vessel" value={vessel.name} />
                    <Row label="Type" value={typeLine(vessel.type, vessel.model)} />
                    <Row label="Hull colour" value={vessel.hullColor} />
                    <Row label="Registration" value={vessel.registration} />
                    <Row label="MMSI" value={vessel.mmsi} />
                    <Row label="Call sign" value={vessel.callSign} />
                    <Row label="Hailing port" value={vessel.hailingPort} />
                </dl>
            )}

            {people.length > 0 && (
                <div className="mt-4">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">People aboard</p>
                    <ul aria-label="People aboard" className="space-y-1">
                        {people.map((person, index) => (
                            <li key={`${person.name}-${index}`} className="flex items-baseline justify-between gap-3">
                                <span className="text-[13px] text-white">{person.name}</span>
                                <span className="text-[11px] text-gray-400">{person.role}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {route && (
                <dl className="mt-4 divide-y divide-white/5">
                    <Row label="Passage" value={route} />
                    <Row label="Departs" value={when(passage?.departure_time)} />
                    <Row label="ETA" value={when(passage?.eta)} />
                </dl>
            )}

            {(raft || vessel?.flaresExpiry) && (
                <dl className="mt-4 divide-y divide-white/5">
                    <Row label="Liferaft" value={raft} />
                    <Row label="Flares expire" value={vessel?.flaresExpiry} />
                </dl>
            )}

            <p className="mt-4 text-[12px] leading-relaxed text-sky-200/80">
                {skipperName} sends {boatName}'s float plan at Cast Off — ask them who holds it.
            </p>
        </section>
    );
};
