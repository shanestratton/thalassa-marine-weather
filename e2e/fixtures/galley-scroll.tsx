/**
 * Galley scroll fixture (126-B1, binder audit GAL-01): the real GalleyPage
 * with two active meals, a grocery list and a recipe library long enough to
 * scroll, under a copy of App.tsx's header and tab bar, so "can the last row be
 * scrolled clear of the bar" is measured against the real chrome and the real
 * index.css.
 *
 * "Open shopping list" is the only way into the grocery list, and with two
 * meals on a phone it sat under the tab bar, untappable. No account, network
 * or boat: the cook is signed in by hand, the local database opens for that
 * fictional account, and every row goes in through the services' own write
 * paths. Every meal, item and recipe is fictional.
 *
 * ?tab=active|recipes  ?insetTop=20  ?insetBottom=0
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV)
    throw new Error('The galley-scroll fixture is available only through the development server.');

// Isolation BEFORE any application service loads: no network at all.
window.fetch = async () =>
    new Response(JSON.stringify({ error: 'Galley scroll fixture: network disabled.' }), { status: 503 });
localStorage.clear();

const params = new URLSearchParams(location.search);
const tab = params.get('tab') === 'recipes' ? 'recipes' : 'active';
const insetTop = Number(params.get('insetTop') ?? 20);
const insetBottom = Number(params.get('insetBottom') ?? 0);
const COOK = 'fixture-cook';

const [{ setAuthIdentityScope }, { useAuthStore }, { initLocalDatabase }] = await Promise.all([
    import('../../services/authIdentityScope'),
    import('../../stores/authStore'),
    import('../../services/vessel/LocalDatabase'),
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

const [{ scheduleMeal }, { addManualItem }, { persistRecipe }, { GalleyPage }] = await Promise.all([
    import('../../services/MealPlanService'),
    import('../../services/ShoppingListService'),
    import('../../services/GalleyRecipeService'),
    import('../../components/vessel/GalleyPage'),
]);

const ingredient = (name: string, amount: number, unit: string) => ({
    name,
    amount,
    unit,
    scalable: true,
    aisle: 'Pantry',
});
// Catalogue recipes with real-shaped provider ids: since 126-B2a only a
// Spoonacular recipe (or a library row) is saved into the library.
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

// Two active meals, six ingredients each: the cards that pushed the button down.
const today = new Date().toISOString().slice(0, 10);
await scheduleMeal(
    meal(910001, 'Kedgeree', ['Basmati rice', 'Smoked fish', 'Eggs', 'Onion', 'Curry powder', 'Parsley']),
    today,
    'breakfast',
    null,
    4,
    COOK,
);
await scheduleMeal(
    meal(910002, 'Lentil dal', ['Red lentils', 'Onion', 'Garlic', 'Ginger', 'Turmeric', 'Coconut milk']),
    today,
    'dinner',
    null,
    4,
    COOK,
);
// A grocery list with three things still to buy.
for (const name of ['Limes', 'Dish soap', 'Spare torch batteries']) {
    await addManualItem({ name, qty: 2, unit: 'each', voyageId: null, ownerUserId: COOK });
}
// A recipe library longer than one screen, so its last card is the one to reach.
const LIBRARY = [
    'Fish tacos',
    'Shakshuka',
    'Mushroom risotto',
    'Paella for the cockpit',
    'Thai green curry',
    'Bircher muesli',
    'Ratatouille',
    'Pancakes at anchor',
];
for (const [i, title] of LIBRARY.entries()) {
    await persistRecipe(meal(920000 + i, title, ['Olive oil', 'Salt', 'Pepper', 'Garlic', 'Lemon', 'Herbs']));
}

/** App.tsx's header on a portrait phone (showHeader), copied as
 *  e2e/fixtures/skipper-takeover.tsx copies it. */
const AppHeader: React.FC = () => (
    <header
        data-testid="app-header"
        className="px-4 md:px-6 flex flex-col justify-between pointer-events-none shrink-0 py-2"
        style={{ paddingTop: `max(1rem, ${insetTop}px)`, gap: '8px' }}
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

/** The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row plus its
 *  1 px top border above the home-indicator inset, opaque. */
const TabBar: React.FC = () => (
    <nav
        aria-label="Main"
        className="fixed bottom-0 left-0 right-0 z-900 border-t"
        style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)', paddingBottom: insetBottom }}
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
if (tab === 'recipes') {
    // The tab is chosen the way a skipper chooses it.
    const pick = () => {
        const button = document.getElementById('galley-recipes-tab');
        if (button) button.click();
        else requestAnimationFrame(pick);
    };
    requestAnimationFrame(pick);
}
