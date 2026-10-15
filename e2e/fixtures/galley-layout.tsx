/**
 * Galley layout fixture (132-B17, binder audit GAL-17): the real GalleyPage,
 * and from it the real Grocery list, Recipe editor and Cooking Mode, under a
 * copy of App.tsx's header and tab bar, so browser-tests/galley-layout.spec.ts
 * can measure them at real phone sizes in wide fonts.
 *
 * What is on it, every row through the services' own write paths:
 *  - meals: one on the stove since yesterday's lunch, two today, two
 *    tomorrow, one on Saturday-ish (four days on) and one from two days ago
 *    never cooked, saved out of order;
 *  - a grocery list with long names, the audit's aisle words (olive oil,
 *    breadcrumbs, eggplant, toilet roll), one row stored in Australian
 *    dollars before the currency was set to Pacific francs, and two bought
 *    at named shops, so the price sheet has quick picks;
 *  - a recipe library.
 *
 * No account, network or boat: the cook is signed in by hand and the local
 * database opens for that fictional account. Every meal, item, shop and
 * recipe is fictional.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV)
    throw new Error('The galley-layout fixture is available only through the development server.');

// Isolation BEFORE any application service loads: no network at all.
window.fetch = async () =>
    new Response(JSON.stringify({ error: 'Galley layout fixture: network disabled.' }), { status: 503 });
localStorage.clear();

const COOK = 'fixture-cook';

const [{ setAuthIdentityScope }, { useAuthStore }, { initLocalDatabase }, { awaitSettingsLoaded, useSettingsStore }] =
    await Promise.all([
        import('../../services/authIdentityScope'),
        import('../../stores/authStore'),
        import('../../services/vessel/LocalDatabase'),
        import('../../stores/settingsStore'),
    ]);
// The auth store signs the page out at import (no session here); let it finish
// before this fixture signs in.
await new Promise<void>((resolve) => {
    if (useAuthStore.getState().authChecked) return resolve();
    const stop = useAuthStore.subscribe((state) => {
        if (!state.authChecked) return;
        stop();
        resolve();
    });
});
setAuthIdentityScope(COOK);
useAuthStore.setState({ user: { id: COOK } as never, authChecked: true });
await initLocalDatabase(COOK);
// The cook's settings load before the currency is set below, so it is not loaded over.
await awaitSettingsLoaded();

const [{ scheduleMeal, startCooking }, { addManualItem, markPurchased }, { persistRecipe }, { GalleyPage }, dates] =
    await Promise.all([
        import('../../services/MealPlanService'),
        import('../../services/ShoppingListService'),
        import('../../services/GalleyRecipeService'),
        import('../../components/vessel/GalleyPage'),
        import('../../utils/localDate'),
    ]);

/** The phone's local day `offset` days from today, as the meal calendar plans it (131-B11). */
const day = (offset: number) => dates.toLocalDateString(dates.addLocalDays(new Date(), offset));

const ingredient = (name: string, amount: number, unit: string) => ({
    name,
    amount,
    unit,
    scalable: true,
    aisle: 'Pantry',
});
// Catalogue recipes with real-shaped provider ids: only those (or library
// rows) are saved into the library (126-B2a).
const meal = (id: number, title: string, names: string[]) => ({
    id,
    title,
    readyInMinutes: 40,
    servings: 4,
    image: '',
    sourceUrl: '',
    ingredients: names.map((name, i) => ingredient(name, i + 1, 'cup')),
    source: 'spoonacular' as const,
});

// Saved out of the order they are eaten: the page sorts them (GAL-11).
await scheduleMeal(
    meal(930001, 'Paella for the cockpit', ['Rice', 'Prawns', 'Saffron']),
    day(4),
    'dinner',
    null,
    4,
    COOK,
);
await scheduleMeal(meal(930002, 'Wraps', ['Tortillas', 'Chicken', 'Lettuce']), day(1), 'lunch', null, 4, COOK);
await scheduleMeal(
    meal(930003, 'Lentil dal with coconut, lime and far too many chillies for the crew', [
        'Red lentils',
        'Onion',
        'Garlic',
        'Ginger',
        'Turmeric',
        'Coconut milk',
    ]),
    day(0),
    'dinner',
    null,
    4,
    COOK,
);
await scheduleMeal(meal(930004, 'Porridge', ['Oats', 'Milk']), day(1), 'breakfast', null, 4, COOK);
await scheduleMeal(
    meal(930005, 'Kedgeree', ['Basmati rice', 'Smoked fish', 'Eggs']),
    day(0),
    'breakfast',
    null,
    4,
    COOK,
);
await scheduleMeal(
    meal(930006, 'Pasta puttanesca', ['Spaghetti', 'Olives', 'Capers']),
    day(-2),
    'dinner',
    null,
    4,
    COOK,
);
const chowder = await scheduleMeal(
    meal(930007, 'Chowder', ['Fish', 'Potato', 'Cream']),
    day(-1),
    'lunch',
    null,
    4,
    COOK,
);
await startCooking(chowder.id);

// One row stored in Australian dollars, before the currency was picked.
useSettingsStore.setState((state) => ({ settings: { ...state.settings, currency: 'AUD' } }));
const wine = await addManualItem({ name: 'Red wine', qty: 2, unit: 'bottle', voyageId: null, ownerUserId: COOK });
await markPurchased(wine.id, 18.5, 'Countdown Westhaven', null, COOK);
// A moment apart, so the later shop is the later purchase.
await new Promise((resolve) => setTimeout(resolve, 20));
// Then Pacific francs, for everything after (132-B17, GAL-09).
useSettingsStore.setState((state) => ({ settings: { ...state.settings, currency: 'XPF' } }));
const milk = await addManualItem({ name: 'Milk', qty: 2, unit: 'L', voyageId: null, ownerUserId: COOK });
await markPurchased(milk.id, 450, 'Talamahu Market', null, COOK);
for (const name of [
    'Extra virgin olive oil, cold pressed, the big tin',
    'Breadcrumbs',
    'Eggplant',
    'Toilet roll',
    'Limes',
    'Raw-water impeller for the Yanmar 3YM30',
    'Spare torch batteries',
]) {
    await addManualItem({ name, qty: 2, unit: 'each', voyageId: null, ownerUserId: COOK });
}

for (const [i, title] of ['Fish tacos', 'Shakshuka', 'Mushroom risotto', 'Pancakes at anchor'].entries()) {
    await persistRecipe(meal(940000 + i, title, ['Olive oil', 'Salt', 'Pepper', 'Garlic', 'Lemon', 'Herbs']));
}

/** App.tsx's header on a portrait phone (showHeader), as e2e/fixtures/galley-scroll.tsx copies it. */
const AppHeader: React.FC = () => (
    <header
        data-testid="app-header"
        className="px-4 md:px-6 flex flex-col justify-between pointer-events-none shrink-0 py-2"
        style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))', gap: '8px' }}
    >
        <div className="flex items-start justify-between gap-2 pointer-events-auto shrink-0">
            <div className="flex min-w-0 items-center space-x-2">
                <img
                    src="/thalassa-icon-128.png"
                    alt=""
                    width={64}
                    height={64}
                    className="thalassa-header-logo w-[64px] h-[64px] max-[389px]:w-12 max-[389px]:h-12 rounded-lg"
                />
                <div className="min-w-0">
                    <p className="shrink-0 whitespace-nowrap text-xl font-bold tracking-wider uppercase">Thalassa</p>
                    <p className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] uppercase tracking-widest text-sky-200">
                        <span className="min-w-0 flex-1 truncate">Keeps watch with you</span>
                    </p>
                </div>
            </div>
            <span
                aria-hidden="true"
                className="relative w-12 h-12 rounded-2xl border border-white/10 bg-slate-900/90"
            />
        </div>
    </header>
);

/** The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row above the home-indicator inset, opaque. */
const TabBar: React.FC = () => (
    <nav
        aria-label="Main"
        className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
        style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
    >
        <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
            <span>THE GLASS</span>
            <span>OBS</span>
            <span>PLAN</span>
            <span>LOG</span>
            <span className="text-sky-300">VESSEL</span>
        </div>
    </nav>
);

function Fixture() {
    return (
        <div className="relative h-dvh w-full overflow-hidden font-sans flex flex-col bg-slate-950 text-white">
            <AppHeader />
            <main id="main-content" className="grow relative flex flex-col overflow-hidden bg-slate-950 pt-0">
                <div className="relative flex-1 overflow-hidden">
                    {/* App.tsx's page frame on a phone: the page pads its own bottom. */}
                    <div className="absolute inset-0">
                        <GalleyPage onBack={() => undefined} />
                    </div>
                </div>
            </main>
            <TabBar />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
requestAnimationFrame(() => {
    (window as unknown as { __galleyLayoutReady?: boolean }).__galleyLayoutReady = true;
});
