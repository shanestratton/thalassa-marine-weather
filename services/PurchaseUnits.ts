/**
 * PurchaseUnits — Converts recipe quantities to real purchasable amounts.
 *
 * Nobody buys "1 tbsp of sugar" — you buy a 1kg bag.
 * This maps ~200 common ingredients to their typical retail packaging.
 *
 * Logic:
 *   1. Look up ingredient in PURCHASE_UNITS by keyword match
 *   2. Convert recipe amount to the purchase unit's base (e.g. tbsp → g)
 *   3. Divide by package size and round up to whole units
 *   4. Return "2 × Flour (1kg bag)" instead of "750g flour"
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface PurchaseUnit {
    /** Display name for the package (e.g. "1kg bag", "500ml bottle") */
    packageLabel: string;
    /** Size of one package in the base unit */
    packageSize: number;
    /** Base unit for this package (g, ml, whole, etc.) */
    baseUnit: string;
}

export interface PurchasableItem {
    /** Original ingredient name */
    name: string;
    /** Recipe quantity (raw) */
    recipeQty: number;
    /** Recipe unit (raw) */
    recipeUnit: string;
    /** Number of packages to buy (rounded up) */
    packageCount: number;
    /** Package label (e.g. "1kg bag") */
    packageLabel: string;
    /** Whether this was matched to a known purchase unit */
    matched: boolean;
}

// ── Conversion factors to grams/ml ─────────────────────────────────────────

const TO_GRAMS: Record<string, number> = {
    'g': 1, 'gram': 1, 'grams': 1,
    'kg': 1000, 'kilogram': 1000, 'kilograms': 1000,
    'oz': 28.35, 'ounce': 28.35, 'ounces': 28.35,
    'lb': 453.6, 'lbs': 453.6, 'pound': 453.6, 'pounds': 453.6,
    'mg': 0.001,
};

const TO_ML: Record<string, number> = {
    'ml': 1, 'milliliter': 1, 'milliliters': 1, 'millilitre': 1, 'millilitres': 1,
    'l': 1000, 'liter': 1000, 'liters': 1000, 'litre': 1000, 'litres': 1000,
    'cup': 240, 'cups': 240,
    'tbsp': 15, 'tablespoon': 15, 'tablespoons': 15,
    'tsp': 5, 'teaspoon': 5, 'teaspoons': 5,
    'fl oz': 29.57, 'fluid ounce': 29.57, 'fluid ounces': 29.57,
    'pint': 473, 'pints': 473,
    'quart': 946, 'quarts': 946,
    'gallon': 3785, 'gallons': 3785,
};

const TO_WHOLE: Record<string, number> = {
    'whole': 1, 'piece': 1, 'pieces': 1, 'each': 1,
    'large': 1, 'medium': 1, 'small': 1,
    'clove': 1, 'cloves': 1,
    'slice': 1, 'slices': 1,
    'sprig': 1, 'sprigs': 1,
    'bunch': 1, 'bunches': 1,
    'head': 1, 'heads': 1,
    'stalk': 1, 'stalks': 1,
    'leaf': 1, 'leaves': 1,
    'serving': 1, 'servings': 1,
    'can': 1, 'cans': 1, 'tin': 1, 'tins': 1,
    'packet': 1, 'packets': 1,
    'jar': 1, 'jars': 1,
    'bottle': 1, 'bottles': 1,
    'bag': 1, 'bags': 1,
    'box': 1, 'boxes': 1,
    'dozen': 12,
    'pinch': 0.5, 'dash': 1,
    'fillet': 1, 'fillets': 1,
    'breast': 1, 'breasts': 1,
    'thigh': 1, 'thighs': 1,
    'drumstick': 1, 'drumsticks': 1,
    'rasher': 1, 'rashers': 1,
    'strip': 1, 'strips': 1,
};

// ── 200-Item Purchase Unit Lookup ──────────────────────────────────────────
// Keywords are matched against ingredient names (case-insensitive, partial match)
// Order matters: more specific keywords should come first

const PURCHASE_UNITS: [string[], PurchaseUnit][] = [
    // ── Baking & Pantry ──
    [['caster sugar', 'castor sugar'],            { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['brown sugar', 'raw sugar'],                { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['icing sugar', 'powdered sugar', 'confectioner'], { packageLabel: '500g bag', packageSize: 500, baseUnit: 'g' }],
    [['sugar'],                                   { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['plain flour', 'all-purpose flour', 'all purpose flour'], { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['self-raising flour', 'self raising flour'], { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['bread flour', 'strong flour'],             { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['flour'],                                   { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['cornflour', 'cornstarch', 'corn starch'],  { packageLabel: '300g box', packageSize: 300, baseUnit: 'g' }],
    [['baking powder'],                           { packageLabel: '200g tin', packageSize: 200, baseUnit: 'g' }],
    [['baking soda', 'bicarbonate', 'bicarb'],    { packageLabel: '250g box', packageSize: 250, baseUnit: 'g' }],
    [['yeast', 'active dry yeast', 'instant yeast'], { packageLabel: '7g sachet', packageSize: 7, baseUnit: 'g' }],
    [['vanilla extract', 'vanilla essence'],      { packageLabel: '100ml bottle', packageSize: 100, baseUnit: 'ml' }],
    [['cocoa', 'cocoa powder'],                   { packageLabel: '250g tin', packageSize: 250, baseUnit: 'g' }],
    [['chocolate chips', 'choc chips'],           { packageLabel: '250g bag', packageSize: 250, baseUnit: 'g' }],
    [['dark chocolate', 'milk chocolate', 'cooking chocolate'], { packageLabel: '200g block', packageSize: 200, baseUnit: 'g' }],
    [['honey'],                                   { packageLabel: '500g jar', packageSize: 500, baseUnit: 'g' }],
    [['maple syrup'],                             { packageLabel: '250ml bottle', packageSize: 250, baseUnit: 'ml' }],
    [['golden syrup', 'treacle'],                 { packageLabel: '400g tin', packageSize: 400, baseUnit: 'g' }],

    // ── Oils, Vinegars & Condiments ──
    [['olive oil'],                               { packageLabel: '500ml bottle', packageSize: 500, baseUnit: 'ml' }],
    [['extra virgin olive oil'],                  { packageLabel: '500ml bottle', packageSize: 500, baseUnit: 'ml' }],
    [['vegetable oil', 'canola oil', 'sunflower oil'], { packageLabel: '1L bottle', packageSize: 1000, baseUnit: 'ml' }],
    [['sesame oil'],                              { packageLabel: '250ml bottle', packageSize: 250, baseUnit: 'ml' }],
    [['coconut oil'],                             { packageLabel: '500ml jar', packageSize: 500, baseUnit: 'ml' }],
    [['balsamic vinegar'],                        { packageLabel: '250ml bottle', packageSize: 250, baseUnit: 'ml' }],
    [['apple cider vinegar'],                     { packageLabel: '500ml bottle', packageSize: 500, baseUnit: 'ml' }],
    [['white wine vinegar', 'red wine vinegar'],  { packageLabel: '500ml bottle', packageSize: 500, baseUnit: 'ml' }],
    [['vinegar'],                                 { packageLabel: '750ml bottle', packageSize: 750, baseUnit: 'ml' }],
    [['soy sauce', 'soya sauce'],                 { packageLabel: '250ml bottle', packageSize: 250, baseUnit: 'ml' }],
    [['fish sauce'],                              { packageLabel: '250ml bottle', packageSize: 250, baseUnit: 'ml' }],
    [['oyster sauce'],                            { packageLabel: '275ml bottle', packageSize: 275, baseUnit: 'ml' }],
    [['worcestershire', 'worcester'],             { packageLabel: '150ml bottle', packageSize: 150, baseUnit: 'ml' }],
    [['tabasco', 'hot sauce', 'sriracha', 'chili sauce'], { packageLabel: '150ml bottle', packageSize: 150, baseUnit: 'ml' }],
    [['tomato sauce', 'ketchup', 'tomato ketchup'], { packageLabel: '500ml bottle', packageSize: 500, baseUnit: 'ml' }],
    [['bbq sauce', 'barbecue sauce'],             { packageLabel: '500ml bottle', packageSize: 500, baseUnit: 'ml' }],
    [['mayonnaise', 'mayo'],                      { packageLabel: '500ml jar', packageSize: 500, baseUnit: 'ml' }],
    [['mustard', 'dijon mustard', 'wholegrain mustard'], { packageLabel: '200g jar', packageSize: 200, baseUnit: 'g' }],
    [['tomato paste', 'tomato puree', 'tomato purée'], { packageLabel: '140g tube', packageSize: 140, baseUnit: 'g' }],
    [['peanut butter'],                           { packageLabel: '375g jar', packageSize: 375, baseUnit: 'g' }],
    [['vegemite', 'marmite'],                     { packageLabel: '220g jar', packageSize: 220, baseUnit: 'g' }],
    [['jam', 'marmalade', 'preserves'],           { packageLabel: '375g jar', packageSize: 375, baseUnit: 'g' }],

    // ── Salt, Pepper & Spices ──
    [['sea salt', 'rock salt', 'kosher salt'],    { packageLabel: '500g bag', packageSize: 500, baseUnit: 'g' }],
    [['salt'],                                    { packageLabel: '500g container', packageSize: 500, baseUnit: 'g' }],
    [['black pepper', 'ground pepper', 'cracked pepper'], { packageLabel: '50g grinder', packageSize: 50, baseUnit: 'g' }],
    [['white pepper'],                            { packageLabel: '50g jar', packageSize: 50, baseUnit: 'g' }],
    [['paprika', 'smoked paprika'],               { packageLabel: '35g jar', packageSize: 35, baseUnit: 'g' }],
    [['cumin', 'ground cumin', 'cumin seeds'],    { packageLabel: '35g jar', packageSize: 35, baseUnit: 'g' }],
    [['coriander', 'ground coriander'],           { packageLabel: '35g jar', packageSize: 35, baseUnit: 'g' }],
    [['turmeric', 'ground turmeric'],             { packageLabel: '35g jar', packageSize: 35, baseUnit: 'g' }],
    [['cinnamon', 'ground cinnamon'],             { packageLabel: '35g jar', packageSize: 35, baseUnit: 'g' }],
    [['cinnamon stick', 'cinnamon sticks'],       { packageLabel: '6 pack', packageSize: 6, baseUnit: 'whole' }],
    [['nutmeg', 'ground nutmeg'],                 { packageLabel: '35g jar', packageSize: 35, baseUnit: 'g' }],
    [['ginger powder', 'ground ginger'],          { packageLabel: '35g jar', packageSize: 35, baseUnit: 'g' }],
    [['chilli powder', 'chili powder', 'cayenne'], { packageLabel: '35g jar', packageSize: 35, baseUnit: 'g' }],
    [['chilli flakes', 'chili flakes', 'red pepper flakes'], { packageLabel: '35g jar', packageSize: 35, baseUnit: 'g' }],
    [['oregano', 'dried oregano'],                { packageLabel: '15g jar', packageSize: 15, baseUnit: 'g' }],
    [['thyme', 'dried thyme'],                    { packageLabel: '15g jar', packageSize: 15, baseUnit: 'g' }],
    [['rosemary', 'dried rosemary'],              { packageLabel: '15g jar', packageSize: 15, baseUnit: 'g' }],
    [['basil', 'dried basil'],                    { packageLabel: '15g jar', packageSize: 15, baseUnit: 'g' }],
    [['bay leaf', 'bay leaves'],                  { packageLabel: '10g jar', packageSize: 10, baseUnit: 'g' }],
    [['curry powder'],                            { packageLabel: '50g jar', packageSize: 50, baseUnit: 'g' }],
    [['garam masala'],                            { packageLabel: '35g jar', packageSize: 35, baseUnit: 'g' }],
    [['chinese five spice', 'five spice'],        { packageLabel: '35g jar', packageSize: 35, baseUnit: 'g' }],
    [['mixed herbs', 'italian seasoning'],        { packageLabel: '25g jar', packageSize: 25, baseUnit: 'g' }],
    [['onion powder'],                            { packageLabel: '50g jar', packageSize: 50, baseUnit: 'g' }],
    [['garlic powder'],                           { packageLabel: '50g jar', packageSize: 50, baseUnit: 'g' }],
    [['mustard powder', 'dry mustard'],           { packageLabel: '50g tin', packageSize: 50, baseUnit: 'g' }],
    [['saffron'],                                 { packageLabel: '1g sachet', packageSize: 1, baseUnit: 'g' }],
    [['vanilla bean', 'vanilla pod'],             { packageLabel: '2 pack', packageSize: 2, baseUnit: 'whole' }],
    [['star anise'],                              { packageLabel: '15g bag', packageSize: 15, baseUnit: 'g' }],
    [['cardamom', 'cardamom pods'],               { packageLabel: '25g bag', packageSize: 25, baseUnit: 'g' }],
    [['clove', 'whole cloves'],                   { packageLabel: '25g jar', packageSize: 25, baseUnit: 'g' }],
    [['allspice'],                                { packageLabel: '35g jar', packageSize: 35, baseUnit: 'g' }],
    [['fennel seeds'],                            { packageLabel: '35g jar', packageSize: 35, baseUnit: 'g' }],

    // ── Dairy ──
    [['unsalted butter'],                         { packageLabel: '250g block', packageSize: 250, baseUnit: 'g' }],
    [['butter'],                                  { packageLabel: '250g block', packageSize: 250, baseUnit: 'g' }],
    [['margarine'],                               { packageLabel: '500g tub', packageSize: 500, baseUnit: 'g' }],
    [['milk'],                                    { packageLabel: '1L carton', packageSize: 1000, baseUnit: 'ml' }],
    [['cream', 'heavy cream', 'thickened cream', 'pouring cream'], { packageLabel: '300ml carton', packageSize: 300, baseUnit: 'ml' }],
    [['sour cream'],                              { packageLabel: '300g tub', packageSize: 300, baseUnit: 'g' }],
    [['cream cheese'],                            { packageLabel: '250g block', packageSize: 250, baseUnit: 'g' }],
    [['cheddar', 'cheddar cheese'],               { packageLabel: '250g block', packageSize: 250, baseUnit: 'g' }],
    [['parmesan', 'parmigiano'],                  { packageLabel: '250g wedge', packageSize: 250, baseUnit: 'g' }],
    [['mozzarella'],                              { packageLabel: '250g bag', packageSize: 250, baseUnit: 'g' }],
    [['feta', 'feta cheese'],                     { packageLabel: '200g block', packageSize: 200, baseUnit: 'g' }],
    [['ricotta'],                                 { packageLabel: '250g tub', packageSize: 250, baseUnit: 'g' }],
    [['halloumi'],                                { packageLabel: '200g pack', packageSize: 200, baseUnit: 'g' }],
    [['cheese'],                                  { packageLabel: '250g block', packageSize: 250, baseUnit: 'g' }],
    [['yoghurt', 'yogurt', 'greek yoghurt', 'greek yogurt'], { packageLabel: '500g tub', packageSize: 500, baseUnit: 'g' }],
    [['coconut cream'],                           { packageLabel: '400ml can', packageSize: 400, baseUnit: 'ml' }],
    [['coconut milk'],                            { packageLabel: '400ml can', packageSize: 400, baseUnit: 'ml' }],
    [['condensed milk'],                          { packageLabel: '395g can', packageSize: 395, baseUnit: 'g' }],
    [['evaporated milk'],                         { packageLabel: '340ml can', packageSize: 340, baseUnit: 'ml' }],

    // ── Eggs ──
    [['egg'],                                     { packageLabel: 'dozen (12)', packageSize: 12, baseUnit: 'whole' }],

    // ── Meat & Poultry ──
    [['chicken breast'],                          { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['chicken thigh'],                           { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['chicken drumstick'],                       { packageLabel: '1kg pack', packageSize: 1000, baseUnit: 'g' }],
    [['whole chicken'],                           { packageLabel: '1.5kg bird', packageSize: 1500, baseUnit: 'g' }],
    [['chicken'],                                 { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['beef mince', 'ground beef', 'minced beef'], { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['steak', 'beef steak', 'rump steak', 'sirloin', 'scotch fillet', 'eye fillet'], { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['brisket', 'beef brisket'],                 { packageLabel: '1kg piece', packageSize: 1000, baseUnit: 'g' }],
    [['beef'],                                    { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['pork mince', 'ground pork'],               { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['pork chop', 'pork cutlet'],                { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['pork belly'],                              { packageLabel: '1kg piece', packageSize: 1000, baseUnit: 'g' }],
    [['pork'],                                    { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['lamb chop', 'lamb cutlet'],                { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['lamb mince', 'ground lamb'],               { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['lamb'],                                    { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['bacon', 'streaky bacon'],                  { packageLabel: '250g pack', packageSize: 250, baseUnit: 'g' }],
    [['ham'],                                     { packageLabel: '200g pack', packageSize: 200, baseUnit: 'g' }],
    [['prosciutto', 'pancetta'],                  { packageLabel: '100g pack', packageSize: 100, baseUnit: 'g' }],
    [['sausage', 'sausages'],                     { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['chorizo'],                                 { packageLabel: '250g pack', packageSize: 250, baseUnit: 'g' }],
    [['salami'],                                  { packageLabel: '150g pack', packageSize: 150, baseUnit: 'g' }],

    // ── Seafood ──
    [['salmon fillet', 'salmon'],                 { packageLabel: '400g pack', packageSize: 400, baseUnit: 'g' }],
    [['tuna steak'],                              { packageLabel: '400g pack', packageSize: 400, baseUnit: 'g' }],
    [['canned tuna', 'tuna can', 'tinned tuna'],  { packageLabel: '185g can', packageSize: 185, baseUnit: 'g' }],
    [['tuna'],                                    { packageLabel: '185g can', packageSize: 185, baseUnit: 'g' }],
    [['prawn', 'shrimp'],                         { packageLabel: '500g bag', packageSize: 500, baseUnit: 'g' }],
    [['snapper', 'barramundi', 'fish fillet', 'white fish'], { packageLabel: '400g pack', packageSize: 400, baseUnit: 'g' }],
    [['crab', 'crab meat'],                       { packageLabel: '200g pack', packageSize: 200, baseUnit: 'g' }],
    [['mussel', 'mussels'],                       { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['squid', 'calamari'],                       { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['anchov', 'anchovies'],                     { packageLabel: '45g tin', packageSize: 45, baseUnit: 'g' }],
    [['sardine', 'sardines'],                     { packageLabel: '110g tin', packageSize: 110, baseUnit: 'g' }],

    // ── Produce ──
    [['onion'],                                   { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['red onion'],                               { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['spring onion', 'green onion', 'scallion'], { packageLabel: '1 bunch', packageSize: 1, baseUnit: 'whole' }],
    [['garlic'],                                  { packageLabel: '3 bulb pack', packageSize: 3, baseUnit: 'whole' }],
    [['ginger', 'fresh ginger'],                  { packageLabel: '100g piece', packageSize: 100, baseUnit: 'g' }],
    [['tomato', 'tomatoes'],                      { packageLabel: '500g punnet', packageSize: 500, baseUnit: 'g' }],
    [['cherry tomato', 'grape tomato'],            { packageLabel: '250g punnet', packageSize: 250, baseUnit: 'g' }],
    [['canned tomato', 'tinned tomato', 'diced tomato', 'crushed tomato'], { packageLabel: '400g can', packageSize: 400, baseUnit: 'g' }],
    [['potato', 'potatoes'],                      { packageLabel: '2kg bag', packageSize: 2000, baseUnit: 'g' }],
    [['sweet potato'],                            { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['carrot', 'carrots'],                       { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['celery'],                                  { packageLabel: '1 bunch', packageSize: 1, baseUnit: 'whole' }],
    [['capsicum', 'bell pepper'],                 { packageLabel: '3 pack', packageSize: 3, baseUnit: 'whole' }],
    [['chilli', 'chili', 'jalapeño', 'jalapeno'], { packageLabel: '100g bag', packageSize: 100, baseUnit: 'g' }],
    [['broccoli'],                                { packageLabel: '1 head', packageSize: 1, baseUnit: 'whole' }],
    [['cauliflower'],                             { packageLabel: '1 head', packageSize: 1, baseUnit: 'whole' }],
    [['zucchini', 'courgette'],                   { packageLabel: '3 pack', packageSize: 3, baseUnit: 'whole' }],
    [['eggplant', 'aubergine'],                   { packageLabel: '1 piece', packageSize: 1, baseUnit: 'whole' }],
    [['mushroom', 'mushrooms'],                   { packageLabel: '200g punnet', packageSize: 200, baseUnit: 'g' }],
    [['spinach', 'baby spinach'],                 { packageLabel: '120g bag', packageSize: 120, baseUnit: 'g' }],
    [['kale'],                                    { packageLabel: '120g bag', packageSize: 120, baseUnit: 'g' }],
    [['lettuce', 'cos lettuce', 'iceberg'],       { packageLabel: '1 head', packageSize: 1, baseUnit: 'whole' }],
    [['rocket', 'arugula'],                       { packageLabel: '100g bag', packageSize: 100, baseUnit: 'g' }],
    [['corn', 'sweet corn'],                      { packageLabel: '4 cob pack', packageSize: 4, baseUnit: 'whole' }],
    [['peas', 'frozen peas', 'green peas'],       { packageLabel: '500g bag', packageSize: 500, baseUnit: 'g' }],
    [['green bean', 'beans'],                     { packageLabel: '250g bag', packageSize: 250, baseUnit: 'g' }],
    [['asparagus'],                               { packageLabel: '1 bunch', packageSize: 1, baseUnit: 'whole' }],
    [['cabbage'],                                 { packageLabel: '1 head', packageSize: 1, baseUnit: 'whole' }],
    [['cucumber'],                                { packageLabel: '1 piece', packageSize: 1, baseUnit: 'whole' }],
    [['avocado'],                                 { packageLabel: '4 pack', packageSize: 4, baseUnit: 'whole' }],
    [['lemon', 'lemons'],                         { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['lime', 'limes'],                           { packageLabel: '6 pack', packageSize: 6, baseUnit: 'whole' }],
    [['orange', 'oranges'],                       { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['apple', 'apples'],                         { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['banana', 'bananas'],                       { packageLabel: '1 bunch', packageSize: 6, baseUnit: 'whole' }],
    [['lemon juice', 'lime juice'],               { packageLabel: '250ml bottle', packageSize: 250, baseUnit: 'ml' }],

    // ── Fresh Herbs ──
    [['fresh basil', 'basil leaves'],             { packageLabel: '1 bunch', packageSize: 1, baseUnit: 'whole' }],
    [['fresh parsley', 'parsley', 'flat-leaf parsley'], { packageLabel: '1 bunch', packageSize: 1, baseUnit: 'whole' }],
    [['fresh coriander', 'cilantro'],             { packageLabel: '1 bunch', packageSize: 1, baseUnit: 'whole' }],
    [['fresh mint', 'mint leaves'],               { packageLabel: '1 bunch', packageSize: 1, baseUnit: 'whole' }],
    [['fresh dill', 'dill'],                      { packageLabel: '1 bunch', packageSize: 1, baseUnit: 'whole' }],
    [['fresh chives', 'chives'],                  { packageLabel: '1 bunch', packageSize: 1, baseUnit: 'whole' }],
    [['fresh rosemary'],                          { packageLabel: '1 bunch', packageSize: 1, baseUnit: 'whole' }],
    [['fresh thyme'],                             { packageLabel: '1 bunch', packageSize: 1, baseUnit: 'whole' }],

    // ── Grains, Pasta & Rice ──
    [['white rice', 'jasmine rice', 'basmati rice', 'long grain rice'], { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['brown rice'],                              { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['rice'],                                    { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['spaghetti'],                               { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['penne', 'rigatoni', 'fusilli', 'macaroni'],{ packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['fettuccine', 'linguine', 'tagliatelle'],   { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['pasta'],                                   { packageLabel: '500g pack', packageSize: 500, baseUnit: 'g' }],
    [['noodle', 'egg noodle', 'rice noodle', 'udon'], { packageLabel: '400g pack', packageSize: 400, baseUnit: 'g' }],
    [['couscous'],                                { packageLabel: '500g box', packageSize: 500, baseUnit: 'g' }],
    [['quinoa'],                                  { packageLabel: '500g bag', packageSize: 500, baseUnit: 'g' }],
    [['oats', 'rolled oats', 'porridge'],         { packageLabel: '500g bag', packageSize: 500, baseUnit: 'g' }],
    [['breadcrumb', 'panko'],                     { packageLabel: '200g bag', packageSize: 200, baseUnit: 'g' }],

    // ── Canned & Jarred ──
    [['chickpea', 'garbanzo'],                    { packageLabel: '400g can', packageSize: 400, baseUnit: 'g' }],
    [['kidney bean', 'red bean'],                 { packageLabel: '400g can', packageSize: 400, baseUnit: 'g' }],
    [['cannellini bean', 'white bean', 'butter bean'], { packageLabel: '400g can', packageSize: 400, baseUnit: 'g' }],
    [['baked beans'],                             { packageLabel: '420g can', packageSize: 420, baseUnit: 'g' }],
    [['lentil', 'lentils'],                       { packageLabel: '400g can', packageSize: 400, baseUnit: 'g' }],
    [['coconut cream'],                           { packageLabel: '400ml can', packageSize: 400, baseUnit: 'ml' }],
    [['pesto'],                                   { packageLabel: '190g jar', packageSize: 190, baseUnit: 'g' }],
    [['passata'],                                 { packageLabel: '700ml bottle', packageSize: 700, baseUnit: 'ml' }],
    [['olive', 'olives', 'kalamata'],             { packageLabel: '350g jar', packageSize: 350, baseUnit: 'g' }],
    [['caper', 'capers'],                         { packageLabel: '100g jar', packageSize: 100, baseUnit: 'g' }],
    [['sun-dried tomato', 'sundried tomato'],     { packageLabel: '200g jar', packageSize: 200, baseUnit: 'g' }],
    [['artichoke', 'artichoke hearts'],           { packageLabel: '280g jar', packageSize: 280, baseUnit: 'g' }],
    [['pickle', 'gherkin'],                       { packageLabel: '500g jar', packageSize: 500, baseUnit: 'g' }],

    // ── Nuts & Seeds ──
    [['almond', 'almonds'],                       { packageLabel: '250g bag', packageSize: 250, baseUnit: 'g' }],
    [['walnut', 'walnuts'],                       { packageLabel: '250g bag', packageSize: 250, baseUnit: 'g' }],
    [['cashew', 'cashews'],                       { packageLabel: '250g bag', packageSize: 250, baseUnit: 'g' }],
    [['peanut', 'peanuts'],                       { packageLabel: '500g bag', packageSize: 500, baseUnit: 'g' }],
    [['pine nut', 'pine nuts'],                   { packageLabel: '80g bag', packageSize: 80, baseUnit: 'g' }],
    [['pecan', 'pecans'],                         { packageLabel: '200g bag', packageSize: 200, baseUnit: 'g' }],
    [['macadamia'],                               { packageLabel: '200g bag', packageSize: 200, baseUnit: 'g' }],
    [['pistachio'],                               { packageLabel: '200g bag', packageSize: 200, baseUnit: 'g' }],
    [['sesame seed', 'sesame seeds'],             { packageLabel: '100g bag', packageSize: 100, baseUnit: 'g' }],
    [['sunflower seed', 'sunflower seeds'],       { packageLabel: '250g bag', packageSize: 250, baseUnit: 'g' }],
    [['pumpkin seed', 'pepita'],                  { packageLabel: '200g bag', packageSize: 200, baseUnit: 'g' }],
    [['chia seed', 'chia seeds'],                 { packageLabel: '250g bag', packageSize: 250, baseUnit: 'g' }],
    [['flaxseed', 'linseed'],                     { packageLabel: '250g bag', packageSize: 250, baseUnit: 'g' }],
    [['coconut', 'desiccated coconut', 'shredded coconut'], { packageLabel: '250g bag', packageSize: 250, baseUnit: 'g' }],

    // ── Dried Fruit & Misc ──
    [['raisin', 'raisins', 'sultana', 'sultanas', 'currant', 'currants'], { packageLabel: '250g bag', packageSize: 250, baseUnit: 'g' }],
    [['dried cranberr', 'craisins'],              { packageLabel: '200g bag', packageSize: 200, baseUnit: 'g' }],
    [['dates', 'medjool date'],                   { packageLabel: '250g pack', packageSize: 250, baseUnit: 'g' }],

    // ── Bread & Bakery ──
    [['bread', 'white bread', 'wholemeal bread', 'sourdough'], { packageLabel: '1 loaf', packageSize: 1, baseUnit: 'whole' }],
    [['wrap', 'tortilla', 'burrito wrap'],        { packageLabel: '8 pack', packageSize: 8, baseUnit: 'whole' }],
    [['english muffin'],                          { packageLabel: '6 pack', packageSize: 6, baseUnit: 'whole' }],
    [['pita', 'pita bread', 'naan', 'flat bread'], { packageLabel: '5 pack', packageSize: 5, baseUnit: 'whole' }],
    [['croissant'],                               { packageLabel: '4 pack', packageSize: 4, baseUnit: 'whole' }],
    [['bread roll', 'burger bun', 'hot dog bun'], { packageLabel: '6 pack', packageSize: 6, baseUnit: 'whole' }],
    [['pastry', 'puff pastry', 'shortcrust'],     { packageLabel: '1 sheet', packageSize: 1, baseUnit: 'whole' }],

    // ── Beverages ──
    [['coffee', 'ground coffee'],                 { packageLabel: '250g bag', packageSize: 250, baseUnit: 'g' }],
    [['instant coffee'],                          { packageLabel: '200g jar', packageSize: 200, baseUnit: 'g' }],
    [['tea', 'tea bag', 'tea bags'],              { packageLabel: '100 bag box', packageSize: 100, baseUnit: 'whole' }],
    [['orange juice'],                            { packageLabel: '1L carton', packageSize: 1000, baseUnit: 'ml' }],
    [['stock cube', 'bouillon cube'],             { packageLabel: '12 pack', packageSize: 12, baseUnit: 'whole' }],
    [['chicken stock', 'beef stock', 'vegetable stock'], { packageLabel: '1L carton', packageSize: 1000, baseUnit: 'ml' }],
    [['stock'],                                   { packageLabel: '1L carton', packageSize: 1000, baseUnit: 'ml' }],

    // ── Frozen ──
    [['frozen berries', 'mixed berries'],         { packageLabel: '500g bag', packageSize: 500, baseUnit: 'g' }],
    [['frozen spinach'],                          { packageLabel: '500g bag', packageSize: 500, baseUnit: 'g' }],
    [['frozen chips', 'french fries', 'frozen fries'], { packageLabel: '1kg bag', packageSize: 1000, baseUnit: 'g' }],
    [['ice cream'],                               { packageLabel: '1L tub', packageSize: 1000, baseUnit: 'ml' }],

    // ── Misc Pantry ──
    [['gelatine', 'gelatin'],                     { packageLabel: '10g sachet', packageSize: 10, baseUnit: 'g' }],
    [['cornflake', 'cereal'],                     { packageLabel: '500g box', packageSize: 500, baseUnit: 'g' }],
    [['muesli', 'granola'],                       { packageLabel: '500g bag', packageSize: 500, baseUnit: 'g' }],
    [['cracker', 'water cracker'],                { packageLabel: '200g box', packageSize: 200, baseUnit: 'g' }],
    [['tortilla chip', 'corn chip', 'nacho'],     { packageLabel: '230g bag', packageSize: 230, baseUnit: 'g' }],
    [['tofu'],                                    { packageLabel: '300g pack', packageSize: 300, baseUnit: 'g' }],
    [['wonton wrapper', 'spring roll wrapper'],   { packageLabel: '275g pack', packageSize: 275, baseUnit: 'g' }],
    [['curry paste', 'thai curry paste'],         { packageLabel: '200g jar', packageSize: 200, baseUnit: 'g' }],
    [['miso', 'miso paste'],                      { packageLabel: '300g pack', packageSize: 300, baseUnit: 'g' }],
    [['tahini'],                                  { packageLabel: '250g jar', packageSize: 250, baseUnit: 'g' }],
    [['hoisin sauce'],                            { packageLabel: '250ml bottle', packageSize: 250, baseUnit: 'ml' }],
    [['teriyaki sauce'],                          { packageLabel: '250ml bottle', packageSize: 250, baseUnit: 'ml' }],
];

// ── Conversion Logic ──────────────────────────────────────────────────────

function normalizeToBase(qty: number, unit: string, baseUnit: string): number | null {
    const u = unit.trim().toLowerCase();

    if (baseUnit === 'g') {
        const factor = TO_GRAMS[u];
        if (factor) return qty * factor;
        // Volume → weight approximation (rough: 1ml ≈ 1g for most ingredients)
        const mlFactor = TO_ML[u];
        if (mlFactor) return qty * mlFactor;
    }

    if (baseUnit === 'ml') {
        const factor = TO_ML[u];
        if (factor) return qty * factor;
        // Weight → volume approximation
        const gFactor = TO_GRAMS[u];
        if (gFactor) return qty * gFactor;
    }

    if (baseUnit === 'whole') {
        const factor = TO_WHOLE[u];
        if (factor) return qty * factor;
        // If the unit is a weight, we can't convert to "whole"
        return null;
    }

    return null;
}

function findPurchaseUnit(ingredientName: string): PurchaseUnit | null {
    const lower = ingredientName.toLowerCase();
    for (const [keywords, unit] of PURCHASE_UNITS) {
        for (const kw of keywords) {
            if (lower.includes(kw)) return unit;
        }
    }
    return null;
}

/**
 * Convert a recipe ingredient to a purchasable quantity.
 *
 * @example
 *   toPurchasable("sugar", 2, "tbsp")
 *   → { name: "sugar", packageCount: 1, packageLabel: "1kg bag", matched: true }
 *
 *   toPurchasable("truffle oil", 1, "tbsp")
 *   → { name: "truffle oil", packageCount: 1, packageLabel: "1 tbsp", matched: false }
 */
export function toPurchasable(
    ingredientName: string,
    recipeQty: number,
    recipeUnit: string,
): PurchasableItem {
    const pu = findPurchaseUnit(ingredientName);

    if (!pu) {
        // No match — return raw quantity
        return {
            name: ingredientName,
            recipeQty,
            recipeUnit,
            packageCount: Math.ceil(recipeQty),
            packageLabel: `${Math.round(recipeQty * 10) / 10} ${recipeUnit}`,
            matched: false,
        };
    }

    // Convert recipe amount to the purchase unit's base
    const baseAmount = normalizeToBase(recipeQty, recipeUnit, pu.baseUnit);

    if (baseAmount === null) {
        // Can't convert — likely a "pinch" or unknown unit
        // Just return 1 package as a reasonable minimum
        return {
            name: ingredientName,
            recipeQty,
            recipeUnit,
            packageCount: 1,
            packageLabel: pu.packageLabel,
            matched: true,
        };
    }

    // Round up to whole packages
    const packages = Math.max(1, Math.ceil(baseAmount / pu.packageSize));

    return {
        name: ingredientName,
        recipeQty,
        recipeUnit,
        packageCount: packages,
        packageLabel: pu.packageLabel,
        matched: true,
    };
}

/**
 * Batch-convert a list of aggregated ingredients to purchasable quantities.
 */
export function toPurchasableList(
    ingredients: { name: string; totalQty: number; unit: string }[],
): PurchasableItem[] {
    return ingredients.map((ing) => toPurchasable(ing.name, ing.totalQty, ing.unit));
}
