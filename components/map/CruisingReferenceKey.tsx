import type { MooringColourFilter } from '../../services/anchorages/cruisingReference';

export function CruisingReferenceKey({
    moorings,
    status,
    filter,
    onFilter,
    embedded = false,
}: {
    moorings: boolean;
    status: string;
    filter: MooringColourFilter;
    onFilter: (filter: MooringColourFilter) => void;
    embedded?: boolean;
}) {
    const Container = embedded ? 'section' : 'details';
    return (
        <Container
            aria-label={moorings ? 'Moorings and anchorages key' : 'Anchorage key'}
            className={embedded ? 'text-slate-100' : 'absolute left-3 z-30 text-slate-100'}
            style={embedded ? undefined : { bottom: 'calc(12rem + env(safe-area-inset-bottom))' }}
        >
            {!embedded && (
                <summary className="cursor-pointer rounded-full border border-sky-400/40 bg-slate-950/95 px-3 py-2 text-xs font-bold shadow-lg min-h-[44px] flex items-center gap-2">
                    <span aria-hidden="true" className="text-sky-300">
                        ⚓
                    </span>{' '}
                    {moorings ? 'Mooring key & colours' : 'Anchorage key'}
                    {status.startsWith('Zoom in') && <span className="text-sky-300">· zoom in</span>}
                    {status.includes('unavailable') || status.includes('Cached') ? (
                        <span className="text-amber-300" aria-label="Reference coverage incomplete">
                            !
                        </span>
                    ) : null}
                </summary>
            )}
            <div
                className={
                    embedded
                        ? 'text-xs leading-relaxed'
                        : 'absolute bottom-full mb-2 w-[min(18rem,calc(100vw-2rem))] max-h-[45dvh] overflow-y-auto rounded-2xl border border-sky-400/30 bg-slate-950/95 p-4 shadow-xl text-xs leading-relaxed'
                }
            >
                <h3 className="text-base font-bold text-sky-200 mb-2">A place to stop</h3>
                <div className="mb-3 rounded-xl border border-white/15 bg-white/5 p-3">
                    <h4 className="font-bold text-white">Weather lights · next 12 hours</h4>
                    <p className="text-green-300">● Green — favourable forecast</p>
                    <p className="text-amber-300">● Amber — caution</p>
                    <p className="text-red-300">● Red — adverse conditions / restrictions</p>
                    <p className="text-slate-300">● Grey — insufficient data</p>
                    <p className="mt-2">
                        Outer rings show conditions, not buoy colours. Worst hour wins; tap for reasons. Zoom in for
                        local weather checks, refreshed every five minutes while open.
                    </p>
                    <p className="mt-2 text-amber-200">
                        Green is not clearance: check warnings, depth/tide, holding, swing room, access and the buoy
                        tag. Missing worldwide shelter data stays grey.
                    </p>
                </div>
                {moorings && (
                    <>
                        <label className="block font-bold" htmlFor="mooring-colour-filter">
                            Buoy body colour
                        </label>
                        <select
                            id="mooring-colour-filter"
                            value={filter}
                            onChange={(e) => onFilter(e.target.value as MooringColourFilter)}
                            className="thalassa-select my-2 h-[44px] min-h-[44px] w-full appearance-none rounded-xl border border-white/20 bg-slate-800 pl-3 pr-10 text-sm"
                        >
                            <option value="all">All colours · including unknown</option>
                            <option value="blue-white">Blue or white</option>
                            <option value="blue">Blue</option>
                            <option value="white">White</option>
                        </select>
                        <p>
                            Double-cone symbols show recorded buoy colours. Grey means unknown. QPWS symbols have blue
                            bodies and their documented class-band colour.
                        </p>
                        {filter !== 'all' && (
                            <p className="text-amber-300 mt-2">Other colours and unknown-colour moorings are hidden.</p>
                        )}
                        <p className="text-amber-200 mt-2">
                            Colour does not establish public access or suitability. White reef-protection markers are
                            not moorings. Tap for source and conditions.
                        </p>
                    </>
                )}
                <p className="mt-2">
                    Anchorage dots are reference places, not approved anchor-drop positions. Red boundaries mark mapped
                    no-anchoring areas; absence of a boundary is not permission.
                </p>
                <p className="mt-2 text-sky-200" role="status">
                    {status}
                </p>
                <p className="mt-2 text-slate-400">
                    © OpenStreetMap contributors · ODbL. Queensland moorings: © State of Queensland; snapshot date on
                    tap. Regional anchorage/zoning reference: GBRMPA. No live availability.
                </p>
            </div>
        </Container>
    );
}
