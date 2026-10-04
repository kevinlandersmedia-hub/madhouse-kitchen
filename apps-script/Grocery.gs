/**
 * Madhouse Kitchen — grocery list (build step 4).
 * Built from the week's saved menu: every planned night's main (or complete meal) plus its sides.
 * Same ingredient across dinners is merged into one line with the amounts added up, sorted into
 * store sections so you walk the store once. Pantry staples (salt, pepper, oil, spices) are always
 * included — cross them off if you have them. Also on the list: free-add items for this week and the
 * "Every week" items that land on every list.
 *
 * Storage (Kitchen sheet):
 *   Grocery      — one row per week: week_start | state JSON (checked / removed / added items) | by | at
 *   Weekly items — one item per row (column A), e.g. "2 gallons milk"
 *   Script property GROCERY_SECTIONS — items moved to a different section by hand { key: section }
 * The list itself is rebuilt from the menu every time it opens, so changing the week's dinners
 * updates the list; check-offs are kept by item.
 */

const GROCERY_COLS = ['week_start', 'state', 'updated_by', 'updated_at'];
const GROCERY_SECTIONS = ['Produce', 'Bakery & Bread', 'Meat & Seafood', 'Dairy & Eggs', 'Pantry', 'Sauces, Oils & Condiments',
  'Spices & Seasonings', 'Baking', 'Frozen', 'Other'];

/* ───────────────────────────── client API ───────────────────────────── */

function api_groceryState(key, weekStart) {
  auth_(key);
  return groceryState_(groceryWeek_(weekStart));
}

// No week given: this week Mon–Fri, next week on Sat/Sun (that's when the shopping happens).
function groceryWeek_(weekStart) {
  if (weekStart) return weekStartOf_(weekStart);
  const today = Utilities.formatDate(new Date(), KCFG.TZ, 'yyyy-MM-dd');
  const dow = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7;
  return weekStartOf_(dow >= 5 ? new Date(Date.parse(today + 'T12:00:00Z') + 2 * 86400000).toISOString().slice(0, 10) : today);
}

// patch: { checked:{key:bool}, removed:{key:bool}, add:'text', drop:'extraId', move:{key, section},
//          weeklyAdd:'text', weeklyDrop:'text', skip:{dinner:'date|recipeId', part:'name'|'*', on:bool}, clearChecked }
function api_groceryPatch(key, weekStart, patch) {
  const me = auth_(key);
  const start = weekStartOf_(weekStart);
  patch = patch || {};
  withLock_(() => {
    if (patch.weeklyAdd || patch.weeklyDrop) {
      const list = readWeekly_();
      if (patch.weeklyAdd) {
        const t = String(patch.weeklyAdd).trim().slice(0, 120);
        if (t && !list.some(x => x.toLowerCase() === t.toLowerCase())) list.push(t);
      }
      if (patch.weeklyDrop) { const i = list.indexOf(String(patch.weeklyDrop)); if (i >= 0) list.splice(i, 1); }
      writeWeekly_(list);
    }
    if (patch.move && patch.move.key && GROCERY_SECTIONS.indexOf(patch.move.section) >= 0) {
      const props = PropertiesService.getScriptProperties();
      const m = JSON.parse(props.getProperty('GROCERY_SECTIONS') || '{}');
      m[String(patch.move.key)] = patch.move.section;
      props.setProperty('GROCERY_SECTIONS', JSON.stringify(m));
    }
    const st = readGroceryWeek_(start);
    Object.keys(patch.checked || {}).forEach(k => { if (patch.checked[k]) st.checked[k] = 1; else delete st.checked[k]; });
    Object.keys(patch.removed || {}).forEach(k => { if (patch.removed[k]) st.removed[k] = 1; else delete st.removed[k]; });
    if (patch.add) {
      String(patch.add).split(/\r?\n|;/).map(s => s.trim().slice(0, 120)).filter(Boolean).forEach(t => {
        st.extras.push({ id: Utilities.getUuid().slice(0, 8), text: t });
        delete st.removed[groceryKeyFor_(t)];
      });
    }
    if (patch.skip && patch.skip.dinner) {
      const k = String(patch.skip.dinner), part = String(patch.skip.part == null ? '*' : patch.skip.part);
      const cur = (st.skip[k] || []).filter(x => x !== part);
      if (patch.skip.on) cur.push(part);
      if (cur.length) st.skip[k] = cur; else delete st.skip[k];
    }
    if (patch.drop) st.extras = st.extras.filter(x => x.id !== patch.drop);
    if (patch.clearChecked) st.checked = {};
    writeGroceryWeek_(start, st, me);
  });
  return groceryState_(start);
}

/* ───────────────────────────── build ───────────────────────────── */

function groceryState_(start) {
  const days = weekDates_(start);
  const nights = readMenus_().filter(r => days.indexOf(r.date) >= 0 && r.status !== 'out' && r.recipe_id);
  const recipes = listRecipes_();
  const st = readGroceryWeek_(start);
  const overrides = JSON.parse(PropertiesService.getScriptProperties().getProperty('GROCERY_SECTIONS') || '{}');
  const built = buildGroceryList_(recipes, nights, st.extras, readWeekly_(), overrides, st.skip);
  const list = built.items;
  const sections = GROCERY_SECTIONS.map(name => ({
    name: name,
    items: list.filter(it => it.section === name && !st.removed[it.key]).map(it => Object.assign(it, { checked: !!st.checked[it.key] }))
  })).filter(s => s.items.length);
  return {
    weekStart: start,
    today: Utilities.formatDate(new Date(), KCFG.TZ, 'yyyy-MM-dd'),
    nights: nights.length,
    sections: sections,
    removed: list.filter(it => st.removed[it.key]).map(it => ({ key: it.key, name: it.name })),
    extras: st.extras,
    dinners: built.dinners,
    weekly: readWeekly_(),
    sectionNames: GROCERY_SECTIONS
  };
}

// Pure JS (testable outside Apps Script).
// nights: [{date, recipe_id, sides:[ids]}]; extras: [{id,text}]; weekly: ['text']; overrides: {key: section}
// skip: { 'date|recipeId': ['*' = whole dish | part name] }  → returns { items, dinners }
function buildGroceryList_(recipes, nights, extras, weekly, overrides, skip) {
  skip = skip || {};
  const dinners = [];
  const byId = {};
  recipes.forEach(r => { byId[r.id] = r; });
  const groups = {}, order = [];
  const add = (line, who, src, extraId) => {
    groceryLinesFrom_(line).forEach(g => {
      let e = groups[g.key];
      if (!e) {
        e = groups[g.key] = { key: g.key, name: g.name, parts: [], lines: [], who: [], src: [], extraIds: [], classifyText: g.classify };
        order.push(g.key);
      }
      e.parts.push(g.part);
      e.lines.push({ who: who, raw: g.raw });
      if (e.who.indexOf(who) < 0) e.who.push(who);
      if (e.src.indexOf(src) < 0) e.src.push(src);
      if (extraId) e.extraIds.push(extraId);
    });
  };
  nights.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach(n => {
    const main = byId[n.recipe_id];
    if (!main) return;
    const day = DOW_SHORT_[(new Date(n.date + 'T12:00:00Z').getUTCDay() + 6) % 7];
    [main].concat((n.sides || []).map(id => byId[id]).filter(Boolean)).forEach(r => {
      const dk = n.date + '|' + r.id, sk = skip[dk] || [];
      const parts = recipeParts_(r.ingredients || []);
      dinners.push({ key: dk, date: n.date, day: day, name: r.name, side: r !== main, skipped: sk.indexOf('*') >= 0,
        parts: parts.length > 1 ? parts.map(pt => ({ name: pt.name, count: pt.lines.length, skipped: sk.indexOf(pt.name) >= 0 })) : [] });
      if (sk.indexOf('*') >= 0) return;
      parts.forEach(pt => { if (sk.indexOf(pt.name) < 0) pt.lines.forEach(l => add(l, day + ' · ' + r.name, 'recipe')); });
    });
  });
  (weekly || []).forEach(t => add(t, 'Every week', 'weekly'));
  (extras || []).forEach(x => add(x.text, 'Added', 'extra', x.id));
  const items = order.map(k => {
    const e = groups[k];
    return {
      key: e.key, name: e.name, amount: groceryAmount_(e.parts), lines: e.lines, who: e.who, src: e.src, extraIds: e.extraIds,
      section: (overrides && overrides[e.key]) || grocerySection_(e.key, e.classifyText)
    };
  });
  return { items: items, dinners: dinners };
}

// Split a recipe's ingredients at its headings ("For the sauce:", "For the Bechamel") so parts can be left off.
const G_PART_RE = /^(?:for (?:the )?\S.*|.{1,40}:)$/i;
function recipeParts_(ingr) {
  const parts = [{ name: 'Main ingredients', lines: [] }];
  ingr.forEach(i => {
    const raw = String((i && (i.raw || i.item)) || '').trim();
    if (!raw) return;
    if (i.header || (G_PART_RE.test(raw) && !/\d/.test(raw) && raw.split(/\s+/).length <= 8)) {
      parts.push({ name: raw.replace(/:$/, '').replace(/^for (?:the )?/i, '').replace(/^./, c => c.toUpperCase()), lines: [] });
      return;
    }
    parts[parts.length - 1].lines.push(raw);
  });
  return parts.filter(p => p.lines.length);
}

const DOW_SHORT_ = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ── ingredient line → shopping item(s) ── */

// Words that don't change what you buy.
const G_DROP_WORDS = /\b(fresh|freshly|large|medium|small|extra[- ]large|jumbo|boneless|skinless|chopped|diced|minced|pre-minced|sliced|finely|roughly|coarsely|thinly|packed|lightly|ripe|raw|uncooked|peeled|divided|optional|about|organic|whole|good[- ]quality|high[- ]quality|softened|melted|room[- ]temperature|at room temperature|cold|warm|cubed|trimmed|halved|quartered|rinsed|drained|patted dry|to taste|for serving|for garnish|plus more|squeeze[- ]bottle|low[- ]sodium|reduced[- ]sodium|unsweetened|heaping|level|grated|shredded|freshly squeezed|squeezed|sprinkle|of|tightly|loosely|chilled|thickened)\b/gi;
// Things you don't buy.
const G_SKIP = /^(?:(?:cold|hot|warm|boiling|ice|tap|lukewarm|filtered)\s+)?water$|^ice(?: cubes?)?$/i;

function groceryLinesFrom_(line) {
  const raw = String(line || '').trim();
  if (!raw) return [];
  let txt = raw
    .replace(/\s+\/\s*[\d.]+(?:\s*-\s*[\d.]+)?\s*(?:kg|g|lbs?|oz|ml|l|cups?)\b/gi, '')   // "2 lb / 1 kg chicken" → "2 lb chicken"
    .replace(/^(\d+)\s+dozen\b/i, (a, n) => String(Number(n) * 12))
    .replace(/^(?:a\s+)?dozen\b/i, '12')
    .replace(/^(?:a\s+)?few\s+/i, '3 ')
    .replace(/^(\d[\d\/ .]*)\s+whole\s+/i, '$1 ');
  const p = parseIngredient(txt);
  if (p.header) return [];
  let item = String(p.item || raw);
  // "salt and pepper", "salt & black pepper" → two items
  if (/^(?:kosher |sea |table )?salt\s*(?:and|&|\+|,)\s*(?:freshly ground |ground |cracked )?(?:black )?pepper\b/i.test(item)) {
    return ['salt', 'black pepper'].map(k => ({ key: k, name: k === 'salt' ? 'Salt' : 'Black pepper', part: { qty: null, unit: '', size: '' }, raw: raw, classify: k }));
  }
  item = gCleanText_(item).replace(/\s+\/\s+.*$/, '');                // "cilantro / coriander leaves" → cilantro
  // "butter or margarine" → butter; "chicken or vegetable broth" → chicken broth; "spicy or Dijon mustard" → Dijon mustard
  const om = item.match(/^(.+?)\s+or\s+(.+)$/i);
  if (om) {
    const a = om[1].trim(), b = om[2].trim(), noun = /\b(broth|stock|oil|cheese|sauce|sugar|vinegar|mustard|flour)\b/i;
    if (noun.test(b) && !noun.test(a) && a.split(/\s+/).length === 1 && /^(chicken|beef|vegetable|olive|canola|vegetable|white|brown|red|cheddar|dijon|yellow)$/i.test(a)) item = a + ' ' + b.split(/\s+/).pop();
    else if (a.split(/\s+/).length === 1 && b.split(/\s+/).length >= 2 && noun.test(b)) item = b;
    else item = a;
  }
  // "2 heads of garlic"
  if (/^(?:whole\s+)?(?:heads?|bulbs?)\s+(?:of\s+)?garlic\b/i.test(item)) { item = 'garlic'; p.unit = 'head'; }
  const key = groceryKeyFor_(item);
  if (!key || G_SKIP.test(key)) return [];
  if (key === 'garlic' && !p.unit && /\bcloves?\b/i.test(item)) p.unit = 'clove';
  const size = /\d/.test(p.note || '') && /\b(oz|ounce|lb|pound|g|gram|ml|count|ct)\b/i.test(p.note || '') ? String(p.note).replace(/\bounces?\b/i, 'oz').trim() : '';
  return [{ key: key, name: groceryDisplayName_(item, key), part: { butter: /\bbutter\b/i.test(key) && !/peanut|almond|apple/i.test(key), qty: p.qty2 != null ? p.qty2 : p.qty, unit: p.unit || '', size: size }, raw: raw, classify: raw.toLowerCase() }];
}

// Drop parenthesised notes (even unclosed ones), stray *, prices.
function gCleanText_(s) {
  s = String(s || '');
  for (let i = 0; i < 3; i++) s = s.replace(/\([^()]*\)/g, ' ');
  return s.replace(/\(.*$/, ' ').replace(/[)*†]/g, ' ').replace(/\$[\d.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function groceryKeyFor_(item) {
  let s = ' ' + gCleanText_(item).toLowerCase()
    .replace(/,.*$/, ' ')
    .replace(/[’']/g, "'").replace(/[^a-z0-9'&\- ]+/g, ' ') + ' ';
  s = s.replace(G_DROP_WORDS, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:a |an |the |some )/, '').replace(/\b(?:leaves|leaf)$/, '').trim();
  if (!s) return '';
  // "ground cumin" = cumin; "ground beef" stays ground beef
  if (/^ground /.test(s) && !/\b(beef|chuck|turkey|pork|chicken|lamb|sausage|veal|bison|meat)\b/.test(s)) s = s.slice(7);
  // Aliases
  const A = [
    [/^(?:kosher |sea |table |fine |coarse |cooking )?salt$/, 'salt'],
    [/^lime wedges?$/, 'lime'], [/^lemon wedges?$/, 'lemon'],
    [/^(?:sprigs? )?rosemary(?: sprigs?)?$/, 'rosemary'], [/^(?:sprigs? )?thyme(?: sprigs?)?$/, 'thyme'],
    [/^(?:ground |cracked |crushed )?(?:black )?pepper(?:corns)?$/, 'black pepper'],
    [/^(?:extra[- ]virgin |light |pure )?olive oil$/, 'olive oil'],
    [/^(?:garlic cloves?|cloves? (?:of )?garlic|garlic)$/, 'garlic'],
    [/^(?:yellow |white |sweet )?onions?$/, 'onion'],
    [/^(?:scallions?|green onions?|spring onions?)$/, 'green onion'],
    [/^eggs?$/, 'egg'],
    [/^(?:all[- ]purpose |ap )?flour$/, 'all-purpose flour'],
    [/^(?:granulated |white )?sugar$/, 'sugar'],
    [/^(?:fresh )?cilantro$/, 'cilantro'],
    [/^(?:fresh )?(?:flat[- ]leaf |italian )?parsley$/, 'parsley'],
    [/^lemons?$/, 'lemon'], [/^limes?$/, 'lime']
  ];
  for (const [re, k] of A) if (re.test(s)) return k;
  s = s.replace(/\b(beef|chicken|vegetable|veggie|turkey|fish|seafood) stock$/, '$1 broth');
  return singularLast_(s);
}

function singularLast_(s) {
  const w = s.split(' '), last = w[w.length - 1];
  const keep = /^(?:molasses|hummus|asparagus|couscous|swiss|bass|grits|oats|greens|peas|brussels|lentils|noodles|pasta|chips|fries|tots|sprinkles|leftovers|breadcrumbs|crumbs|flakes|seeds|herbs|beans|chickpeas|oats|is|us|ss|series)$/;
  let out = last;
  if (keep.test(last) || last.length < 4) out = last;
  else if (/ies$/.test(last)) out = last.slice(0, -3) + 'y';
  else if (/(?:tomato|potato|mango|jalapeno|jalapeño)es$/.test(last)) out = last.slice(0, -2);
  else if (/(?:ch|sh|ss|x)es$/.test(last)) out = last.slice(0, -2);
  else if (/[^s]s$/.test(last)) out = last.slice(0, -1);
  w[w.length - 1] = out;
  return w.join(' ');
}

function groceryDisplayName_(item, key) {
  if (['salt', 'black pepper', 'olive oil', 'garlic', 'onion', 'green onion', 'egg', 'all-purpose flour', 'sugar', 'cilantro', 'parsley', 'lemon', 'lime'].indexOf(key) >= 0) {
    const nice = { egg: 'Eggs', onion: 'Onions', 'green onion': 'Green onions', lemon: 'Lemons', lime: 'Limes' }[key];
    return nice || key.charAt(0).toUpperCase() + key.slice(1);
  }
  let s = gCleanText_(item).replace(/,.*$/, '').replace(G_DROP_WORDS, ' ').replace(/\s+/g, ' ').trim();
  if (!s) s = key;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ── amounts ── */

const G_VOL = { tsp: 1, tbsp: 3, cup: 48, 'fl oz': 6, pt: 96, qt: 192, gal: 768, ml: 0.2029, l: 202.9 };
const G_WT = { oz: 1, lb: 16, g: 0.03527, kg: 35.27 };

function groceryAmount_(parts) {
  let vol = 0, wt = 0, any = false, none = 0;
  const counts = {}, countOrder = [];
  parts.forEach(p => {
    if (p.qty == null || !(p.qty > 0)) { none++; return; }
    any = true;
    if (G_VOL[p.unit]) vol += p.qty * G_VOL[p.unit];
    else if (G_WT[p.unit]) wt += p.qty * G_WT[p.unit];
    else if (p.unit === 'package' && /^\d+(?:\.\d+)?\s*-?\s*(?:oz|lb)\b/i.test(p.size || '')) {
      const m = String(p.size).match(/^(\d+(?:\.\d+)?)\s*-?\s*(oz|lb)/i);
      wt += p.qty * Number(m[1]) * (m[2].toLowerCase() === 'lb' ? 16 : 1);
    } else {
      const k = p.unit + '|' + (p.size || '');
      if (!(k in counts)) { counts[k] = 0; countOrder.push(k); }
      counts[k] += p.qty;
    }
  });
  if (!any) return '';
  const out = [];
  countOrder.forEach(k => {
    const [u, size] = k.split('|');
    const q = counts[k];
    out.push(gFmt_(q) + (u ? ' ' + gUnit_(u, q) : '') + (size ? ' (' + size + ')' : ''));
  });
  if (wt) out.push(wt >= 24 || (wt >= 16 && Math.abs(wt / 8 - Math.round(wt / 8)) < 0.05) ? gFmt_(Math.round(wt / 16 * 4) / 4) + ' lb' : gFmt_(Math.round(wt * 2) / 2) + ' oz');
  if (vol && parts.some(p => p.butter) && parts.every(p => p.butter) && vol >= 12) {
    out.push(gFmt_(Math.round(vol / 24 * 4) / 4) + ' stick' + (vol > 24.5 ? 's' : ''));
  } else if (vol) {
    if (vol >= 384) out.push(gFmt_(Math.round(vol / 768 * 4) / 4) + ' gal');
    else if (vol >= 12) out.push(gFmt_(Math.round(vol / 48 * 8) / 8) + ' cup' + (vol > 48.5 ? 's' : ''));
    else if (vol >= 3) out.push(gFmt_(Math.round(vol / 3 * 2) / 2) + ' tbsp');
    else out.push(gFmt_(Math.round(vol * 4) / 4) + ' tsp');
  }
  if (none) out.push('+ more to taste');
  return out.join(' + ').replace(/ \+ \+ /, ' + ');
}

function gFmt_(n) {
  const FR = [[1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞']];
  if (n >= 10) return String(Math.round(n * 2) / 2).replace('.5', '½');
  const w = Math.floor(n), f = n - w;
  if (f < 0.04) return String(w || 0);
  if (f > 0.96) return String(w + 1);
  let best = null, bd = 0.05;
  FR.forEach(([v, s]) => { const d = Math.abs(f - v); if (d < bd) { bd = d; best = s; } });
  if (!best) return String(Math.round(n * 100) / 100);
  return (w ? w : '') + best;
}

function gUnit_(u, q) {
  if (!(q > 1)) return u;
  if (u === 'pinch' || u === 'dash' || u === 'bunch') return u + 'es';
  if (u === 'loaf') return 'loaves';
  return u + 's';
}

/* ── store sections ── */

function grocerySection_(key, rawText) {
  const k = ' ' + key + ' ', t = String(rawText || '').toLowerCase();
  const k2 = k.replace(/s\b/g, ''), k3 = k.replace(/es\b/g, '');
  const has = re => re.test(k) || re.test(k2) || re.test(k3);
  if (has(/\bfrozen\b|ice cream|tater tot|steam-in-bag|popsicle|^ (?:crushed |cubed )?ice $/)) return 'Frozen';
  // Fresh herbs are produce; the same herb with no "fresh" (1 tsp basil) is a spice jar.
  const herb = /\b(basil|thyme|rosemary|dill|mint|oregano|sage|tarragon|chive)s?\b/;
  if (has(/\b(cilantro|parsley|green onion|scallion|lettuce|lemongrass|butternut)\b/) && !/\bdried\b/.test(t)) return 'Produce';
  if (has(herb) && !/\bdried\b|\bground\b/.test(t) && /\bfresh\b|\bleaves\b|\bsprigs?\b|\bbunch\b|\bchopped\b|\btorn\b/.test(t)) return 'Produce';
  if (has(/\b(salt|black pepper|white pepper|paprika|cumin|chili powder|chile powder|oregano|basil|thyme|rosemary|dill|sage|tarragon|italian seasoning|seasoning|garlic powder|onion powder|garlic salt|cinnamon|nutmeg|cayenne|red pepper flake|pepper flake|crushed red pepper|bay lea|curry powder|garam masala|turmeric|coriander|ground ginger|allspice|ground clove|old bay|five[- ]spice|cardamom|herbes de provence|za'atar|sumac|sesame seed|everything bagel|dried|rub|peppercorn|msg|bouillon|bay|star anise|cassia|cardamon|tumeric|saffron|fennel seed|mustard seed|caraway)\b/)) return 'Spices & Seasonings';
  if (has(/\b(baking powder|baking soda|cornstarch|corn starch|flour|sugar|brown sugar|powdered sugar|yeast|vanilla|cocoa|chocolate chip|honey|maple syrup|molasses|shortening|cornmeal|extract|gelatin|food colou?ring|cornflour|corn flour|sprinkles|cake mix)\b/)) return 'Baking';
  if (has(/\b(oil|vinegar|mayo|mayonnaise|mustard|ketchup|soy sauce|tamari|hoisin|sriracha|hot sauce|worcestershire|dressing|bbq sauce|barbecue sauce|salsa|pesto|marinara|pasta sauce|teriyaki|fish sauce|oyster sauce|sauce|gochujang|curry paste|tahini|peanut butter|jam|jelly|relish|lemon juice|lime juice|cooking spray|sizzle spray|spray|mirin|miso|kecap manis|bean paste|chili crisp|aioli|tzatziki|caper)\b/)) return 'Sauces, Oils & Condiments';
  if (has(/\b(broth|stock|soup|cream of|canned|tomato paste|tomato sauce|crushed tomato|diced tomato|whole tomato|fire-roasted|rotel|coconut milk|evaporated milk|condensed milk|beans|chickpea|lentil|rice|pasta|spaghetti|penne|macaroni|noodle|orzo|couscous|quinoa|oats|breadcrumb|bread crumb|panko|crouton|stuffing|instant|cracker|chips|nut|almond|pecan|walnut|cashew|peanut|raisin|olive|capers|artichoke|roasted red pepper|chipotle in adobo|green chile|jalapeño slices|pickled|taco shell|tostada|ramen|lasagna|ziti|rigatoni|fettuccine|linguine|shells|egg noodle|gnocchi|tortellini|ravioli|lasagne|noodles|fettuccini|bucatini|pappardelle|bulgur|farro|kelp|nori|water chestnut|bamboo shoot|pistachio|currant|cranberr|dried fruit|bonito|wheat gluten|ramen|tortilla chip)\b/)) return 'Pantry';
  if (has(/\b(bread|roll|bun|tortilla|pita|naan|baguette|bagel|croissant|english muffin|hoagie|brioche|sourdough|french stick|ciabatta|flatbread|pizza dough|wrap)s?\b/)) return 'Bakery & Bread';
  if (has(/\b(chicken|beef|steak|sirloin|chuck|brisket|pork|bacon|sausage|ham|turkey|lamb|veal|chorizo|kielbasa|andouille|pepperoni|salami|prosciutto|pancetta|shrimp|salmon|tilapia|cod|fish|tuna|crab|scallop|mahi|halibut|lobster|mussel|clam|catfish|grouper|snapper|trout|swordfish|corvina|flounder|haddock|venison|bison|duck|meatball|hot dog|bratwurst|ground|guanciale|ribeye|short rib|hen|rabbit|pig|oxtail|anchovy|anchovie|prawn|mince)\b/)) return 'Meat & Seafood';
  if (has(/\b(milk|butter|buttermilk|cheese|cheddar|mozzarella|parmesan|parmigiano|pecorino|ricotta|feta|gruyere|provolone|monterey jack|pepper jack|colby|swiss|cream cheese|sour cream|heavy cream|whipping cream|half and half|half-and-half|cream|yogurt|egg|kerrygold|queso|cotija|ghee|fontina|gouda|brie|havarti|mascarpone|asiago|manchego|american cheese|velveeta|yoghurt|thickened cream|creme fraiche|crème fraîche)\b/)) return 'Dairy & Eggs';
  if (has(/\b(onion|garlic|shallot|leek|potato|sweet potato|yam|tomato|lettuce|romaine|spinach|kale|arugula|cabbage|carrot|celery|zucchini|squash|broccoli|broccolini|cauliflower|asparagus|green bean|mushroom|bell pepper|pepper|jalapeno|jalapeño|poblano|serrano|avocado|lemon|lime|orange|apple|banana|berry|berries|strawberr|blueberr|grape|cucumber|corn|ginger|salad|slaw|bok choy|sprout|radish|beet|eggplant|pear|peach|mango|pineapple|herb|cilantro|parsley|basil|mint|dill|chive|okra|collard|greens|snap pea|snow pea|edamame|fennel|watermelon|cherry tomato|jicama|tomatillo|chili|chile|chilli|lemongrass|thai basil|shiitake|portobello|cremini|bean sprout|tofu|capsicum|pea|french stick|chilly|chillies|buk choy|pak choy|eschalot|cos|cherry|cherries|snow pea|herb)\b/)) return 'Produce';
  if (has(/\b(wine|beer|sherry|vermouth|bourbon|rum|brandy)\b/)) return 'Other';
  if (has(/\b(tortilla chip|chip|pretzel|soda|juice|coffee|tea|water bottle|sparkling)\b/)) return 'Other';
  return 'Other';
}

/* ── storage ── */

function grocerySheet_() {
  const ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  let sh = ss.getSheetByName('Grocery');
  if (!sh) {
    sh = ss.insertSheet('Grocery');
    sh.getRange(1, 1, 1, GROCERY_COLS.length).setValues([GROCERY_COLS]);
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
  }
  return sh;
}

function readGroceryWeek_(start) {
  const sh = grocerySheet_(), last = sh.getLastRow();
  const blank = { checked: {}, removed: {}, extras: [], skip: {} };
  if (last < 2) return blank;
  const rows = sh.getRange(2, 1, last - 1, 2).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (dateStr_(rows[i][0]) !== start) continue;
    try {
      const j = JSON.parse(rows[i][1] || '{}');
      return { checked: j.checked || {}, removed: j.removed || {}, extras: Array.isArray(j.extras) ? j.extras : [], skip: j.skip || {} };
    } catch (e) { return blank; }
  }
  return blank;
}

function writeGroceryWeek_(start, st, me) {
  const sh = grocerySheet_(), last = sh.getLastRow();
  const row = [start, JSON.stringify(st), me, new Date()];
  if (last >= 2) {
    const keys = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (dateStr_(keys[i][0]) === start) { sh.getRange(i + 2, 1, 1, GROCERY_COLS.length).setValues([row]); return; }
    }
  }
  sh.getRange(last + 1, 1, 1, GROCERY_COLS.length).setValues([row]);
}

function weeklySheet_() {
  const ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  let sh = ss.getSheetByName('Weekly items');
  if (!sh) { sh = ss.insertSheet('Weekly items'); sh.getRange(1, 1).setValue('item (lands on every grocery list)'); sh.setFrozenRows(1); }
  return sh;
}
function readWeekly_() {
  const sh = weeklySheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0] || '').trim()).filter(Boolean);
}
function writeWeekly_(list) {
  const sh = weeklySheet_(), last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 1).clearContent();
  if (list.length) sh.getRange(2, 1, list.length, 1).setValues(list.map(t => [t]));
}
