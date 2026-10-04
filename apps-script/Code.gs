/**
 * Madhouse Kitchen — dinner planning module (Google Apps Script web app)
 * Build step 1–2: recipe library (paste / link / write-your-own) + automatic tagging.
 *
 * STANDALONE app — deliberately separate from the Madhouse (MDHSE) family app.
 * It has its own Apps Script project, its own Sheet, its own personal keys and its
 * own GitHub repo (kevinlandersmedia-hub/madhouse-kitchen). It never calls MDHSE.
 * Runs as Kevin; each person opens a private link (?k=<key>). Admin-only for now
 * (Kevin + Hillary). Joining with Madhouse later: see README "Future connector".
 * Data lives in the Sheet "Madhouse Kitchen – Data" (tab Recipes).
 *
 * One-time: run setup() from the editor, then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone). Links = <exec URL>?k=<key> (setup prints them).
 */

const KCFG = {
  TZ: 'America/New_York',
  SHEET_NAME: 'Madhouse Kitchen – Data',
  PEOPLE: {
    kevin:   { name: 'Kevin',   role: 'parent' },
    hillary: { name: 'Hillary', role: 'parent' },
    reese:   { name: 'Reese',   role: 'kid' },
    avery:   { name: 'Avery',   role: 'kid' }
  },
  MAX_WEEKNIGHT_MIN: 60,
  TARGET_LIBRARY: [20, 50],
  RECIPE_COLS: ['id', 'name', 'source', 'url', 'image', 'servings', 'prep_min', 'cook_min', 'total_min', 'oven',
    'ingredients', 'steps', 'notes', 'cuisine', 'protein', 'category', 'auto_tags', 'locked', 'holiday',
    'created_by', 'created_at', 'updated_by', 'updated_at', 'deleted', 'role', 'side_type', 'easy', 'reviewed']
};

/* ───────────────────────────── entry point ───────────────────────────── */

function doGet(e) {
  const p = (e && e.parameter) || {};
  const person = personForKey_(p.k);
  if (person && KCFG.PEOPLE[person].role !== 'parent') {
    return HtmlService.createHtmlOutput(
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<div style="font:16px system-ui;padding:32px;max-width:420px;margin:auto">' +
      '<h2>Kitchen</h2><p>Hi ' + KCFG.PEOPLE[person].name + '! Dinner suggestions are coming soon — you\'ll be able to add them here soon.</p></div>')
      .setTitle('Kitchen').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  if (!person) {
    return HtmlService.createHtmlOutput(
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<div style="font:16px system-ui;padding:32px;max-width:420px;margin:auto">' +
      '<h2>Madhouse Kitchen</h2><p>This link is missing its personal key. Ask Kevin for your own link.</p></div>')
      .setTitle('Kitchen');
  }
  const t = HtmlService.createTemplateFromFile('Index');
  t.boot = JSON.stringify({
    key: p.k, person: person, name: KCFG.PEOPLE[person].name,
    options: TAG_OPTIONS, maxMin: KCFG.MAX_WEEKNIGHT_MIN, target: KCFG.TARGET_LIBRARY
  });
  return t.evaluate()
    .setTitle('Kitchen')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ───────────────────────────── client API ───────────────────────────── */

function api_list(key) {
  auth_(key);
  ensureV2_();
  return listRecipes_();
}

// Import from a recipe site → a draft (not saved) for review in the editor.
function api_importUrl(key, url) {
  auth_(key);
  url = String(url || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('That doesn\'t look like a web link.');
  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }
    });
  } catch (err) { throw new Error('Couldn\'t reach that site. Try pasting the recipe instead.'); }
  const code = res.getResponseCode();
  // Some big sites (Allrecipes, Simply Recipes, Serious Eats…) block apps outright (402/403).
  if (code === 401 || code === 402 || code === 403 || code === 429) throw new Error('That site blocks apps from reading its recipes. Open the recipe, copy the whole thing, and use Paste instead.');
  if (code === 404) throw new Error('That page wasn\'t found — check the link.');
  if (code >= 400) throw new Error('That site said no (error ' + code + '). Try pasting the recipe instead.');
  const html = res.getContentText();
  const draft = recipeFromHtml(html, url);
  if (draft && !draft.image) draft.image = ogImage_(html, url);   // fall back to the page's headline photo
  if (!draft) throw new Error('Couldn\'t find a recipe on that page. Copy the recipe text and use Paste instead.');
  return finishDraft(draft);
}

// Pasted text or a plain-language description → a draft (not saved).
function api_parseText(key, text) {
  auth_(key);
  text = String(text || '').slice(0, 30000);
  if (!text.trim()) throw new Error('Paste or type a recipe first.');
  return finishDraft(parseRecipeText(text));
}

// Re-run tagging on an unsaved draft (editor's "re-check tags").
function api_tagDraft(key, draft) {
  auth_(key);
  return finishDraft(normalizeDraft_(draft));
}

function api_save(key, draft) {
  const me = auth_(key);
  const r = finishDraft(normalizeDraft_(draft));
  if (!r.name) throw new Error('Give the recipe a name.');
  if (!r.ingredients.length) throw new Error('Add at least one ingredient.');
  const now = new Date();
  withLock_(() => {
    const sh = sheet_('Recipes');
    const cols = colIndex_(sh);
    if (r.id) {
      const rows = sh.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][cols.id] === r.id) {
          r.created_by = rows[i][cols.created_by]; r.created_at = rows[i][cols.created_at];
          r.updated_by = me; r.updated_at = now;
          sh.getRange(i + 1, 1, 1, KCFG.RECIPE_COLS.length).setValues([toRow_(r)]);
          return;
        }
      }
    }
    r.id = r.id || Utilities.getUuid();
    r.created_by = me; r.created_at = now; r.updated_by = me; r.updated_at = now;
    sh.appendRow(toRow_(r));
  });
  return { saved: r.id, recipes: listRecipes_() };
}

function api_delete(key, id) {
  const me = auth_(key);
  withLock_(() => {
    const sh = sheet_('Recipes');
    const cols = colIndex_(sh);
    const rows = sh.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][cols.id] === id) {
        sh.getRange(i + 1, cols.deleted + 1).setValue(true);
        sh.getRange(i + 1, cols.updated_by + 1, 1, 2).setValues([[me, new Date()]]);
        break;
      }
    }
  });
  return listRecipes_();
}

// Re-tag every recipe with the current rules. Tags a person set by hand are kept.
function api_retagAll(key) {
  auth_(key);
  withLock_(() => {
    const sh = sheet_('Recipes');
    const cols = colIndex_(sh);
    const rows = sh.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (!rows[i][cols.id]) continue;
      const r = fromRow_(rows[i], cols);
      const t = finishDraft(r);
      sh.getRange(i + 1, cols.cuisine + 1, 1, 3).setValues([[t.cuisine, t.protein, t.category]]);
      sh.getRange(i + 1, cols.auto_tags + 1).setValue(JSON.stringify(t.auto));
      sh.getRange(i + 1, cols.role + 1).setValue(t.role);
      sh.getRange(i + 1, cols.side_type + 1).setValue(t.side_type || '');
    }
  });
  return listRecipes_();
}

/* ───────────────────────────── storage ───────────────────────────── */

function listRecipes_() {
  const sh = sheet_('Recipes');
  const cols = colIndex_(sh);
  return sh.getDataRange().getValues().slice(1)
    .filter(r => r[cols.id] && r[cols.deleted] !== true)
    .map(r => fromRow_(r, cols))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function toRow_(r) {
  const v = {
    id: r.id, name: r.name, source: r.source || 'home', url: r.url || '', image: r.image || '',
    servings: r.servings || '', prep_min: numOrBlank_(r.prep_min), cook_min: numOrBlank_(r.cook_min),
    total_min: numOrBlank_(r.total_min), oven: r.oven || '',
    ingredients: JSON.stringify(r.ingredients || []), steps: JSON.stringify(r.steps || []), notes: r.notes || '',
    cuisine: r.cuisine, protein: r.protein, category: r.category,
    auto_tags: JSON.stringify(r.auto || {}), locked: JSON.stringify(r.locked || []), holiday: !!r.holiday,
    created_by: r.created_by || '', created_at: r.created_at || '', updated_by: r.updated_by || '', updated_at: r.updated_at || '',
    deleted: false,
    role: r.role || '', side_type: r.role === 'Side' ? (r.side_type || '') : '', easy: !!r.easy, reviewed: !!r.reviewed
  };
  return KCFG.RECIPE_COLS.map(c => v[c]);
}

function fromRow_(row, cols) {
  const j = (v, d) => { try { return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const iso = v => (v instanceof Date ? v.toISOString() : (v ? String(v) : ''));
  const num = v => (v === '' || v == null ? null : Number(v));
  return {
    id: row[cols.id], name: String(row[cols.name] || ''), source: row[cols.source], url: row[cols.url], image: row[cols.image],
    servings: num(row[cols.servings]), prep_min: num(row[cols.prep_min]), cook_min: num(row[cols.cook_min]),
    total_min: num(row[cols.total_min]), oven: String(row[cols.oven] || ''),
    ingredients: j(row[cols.ingredients], []), steps: j(row[cols.steps], []), notes: String(row[cols.notes] || ''),
    cuisine: row[cols.cuisine], protein: row[cols.protein], category: row[cols.category],
    auto: j(row[cols.auto_tags], {}), locked: j(row[cols.locked], []), holiday: row[cols.holiday] === true,
    created_by: row[cols.created_by], created_at: iso(row[cols.created_at]),
    updated_by: row[cols.updated_by], updated_at: iso(row[cols.updated_at]),
    role: String(row[cols.role] || ''), side_type: String(row[cols.side_type] || ''),
    easy: row[cols.easy] === true, reviewed: row[cols.reviewed] === true
  };
}

function colIndex_(sh) {
  let head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const missing = KCFG.RECIPE_COLS.filter(c => head.indexOf(c) < 0);
  if (missing.length) {
    sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]);
    head = head.concat(missing);
  }
  const out = {};
  KCFG.RECIPE_COLS.forEach(c => { out[c] = head.indexOf(c); if (out[c] < 0) throw new Error('Sheet is missing column ' + c + ' — run setup()'); });
  return out;
}

function numOrBlank_(v) { return v === null || v === undefined || v === '' || isNaN(Number(v)) ? '' : Number(v); }

/* ═════════════════════════════ recipe engine (pure JS — no Apps Script calls) ═════════════════════════════ */

/* ── drafts ── */

// Clean up whatever the editor sends back: ingredients/steps may arrive as text lines.
function normalizeDraft_(d) {
  d = d || {};
  const lines = v => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map(x => (typeof x === 'string' ? x : (x && x.raw) || '')).map(s => s.trim()).filter(Boolean);
  const n = v => (v === '' || v == null || isNaN(Number(v)) ? null : Math.round(Number(v)));
  return {
    id: d.id || '', name: String(d.name || '').trim().slice(0, 140), source: ['home', 'paste', 'url'].indexOf(d.source) >= 0 ? d.source : 'home',
    url: String(d.url || '').trim().slice(0, 500), image: /^https?:\/\//.test(d.image || '') ? String(d.image).slice(0, 500) : '',
    servings: n(d.servings), prep_min: n(d.prep_min), cook_min: n(d.cook_min), total_min: n(d.total_min),
    oven: String(d.oven || '').trim().slice(0, 40),
    ingredients: lines(d.ingredients).map(parseIngredient),
    steps: lines(d.steps).map(s => s.replace(/^(step\s*)?\d+\s*[.):\-]\s+/i, '')),
    notes: String(d.notes || '').slice(0, 4000), holiday: !!d.holiday,
    hints: d.hints || {},
    cuisine: d.cuisine, protein: d.protein, category: d.category,
    role: ROLE_OPTIONS.indexOf(d.role) >= 0 ? d.role : '', side_type: SIDE_TYPES.indexOf(d.side_type) >= 0 ? d.side_type : '',
    easy: !!d.easy, reviewed: !!d.reviewed,
    locked: Array.isArray(d.locked) ? d.locked.filter(x => ['cuisine', 'protein', 'category', 'role', 'side_type'].indexOf(x) >= 0) : []
  };
}

// Fill in total time, run auto-tagging, keep any tags a person locked by hand, add warnings.
function finishDraft(d) {
  if (d.total_min == null && (d.prep_min != null || d.cook_min != null)) d.total_min = (d.prep_min || 0) + (d.cook_min || 0);
  if (!d.oven) d.oven = findOvenTemp((d.steps || []).join(' '));
  const hints = d.hints || (d.auto && d.auto.hints) || {};
  d.hints = hints;
  const auto = autoTag(d);
  if (hints.cuisine || hints.category || hints.keywords) auto.hints = hints;
  const locked = d.locked || [];
  ['cuisine', 'protein', 'category'].forEach(f => {
    if (locked.indexOf(f) < 0 || !d[f]) d[f] = auto[f];
  });
  const ar = autoRole(d);
  auto.role = ar.role; auto.side_type = ar.side_type; auto.why.role = ar.why; auto.sure.role = ar.sure;
  if (locked.indexOf('role') < 0 || !d.role) d.role = ar.role;
  if (d.role === 'Side') { if (locked.indexOf('side_type') < 0 || !d.side_type) d.side_type = ar.side_type || 'Veggie'; }
  else d.side_type = '';
  d.auto = auto;
  d.warnings = [];
  if (!d.holiday) {
    if (d.total_min == null) d.warnings.push('No total time yet — add one so the planner knows it fits in an hour.');
    else if (d.total_min > KCFG.MAX_WEEKNIGHT_MIN) d.warnings.push('Takes ' + d.total_min + ' min — over the 1-hour weeknight limit, so the planner will skip it. Mark it as a holiday meal or trim the time.');
  }
  delete d.hints;
  return d;
}

/* ── web page → recipe (schema.org JSON-LD, then microdata) ── */

function recipeFromHtml(html, url) {
  const blocks = [];
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let txt = m[1].trim().replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').replace(/;\s*$/, '');
    try { blocks.push(JSON.parse(txt)); } catch (e) {
      try { blocks.push(JSON.parse(txt.replace(/[\u0000-\u001F]+/g, ' '))); } catch (e2) {}
    }
  }
  let node = null;
  const walk = x => {
    if (node || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const t = x['@type'];
    if (t === 'Recipe' || (Array.isArray(t) && t.indexOf('Recipe') >= 0)) { node = x; return; }
    if (x['@graph']) walk(x['@graph']);
    if (x.mainEntity) walk(x.mainEntity);
    if (x.itemListElement && !node) walk(x.itemListElement);
  };
  blocks.forEach(walk);
  if (node) return recipeFromJsonLd_(node, url);
  return recipeFromMicrodata_(html, url);
}

function recipeFromJsonLd_(n, url) {
  const txt = v => cleanText_(Array.isArray(v) ? v[0] : (v && typeof v === 'object' ? (v.text || v.name || '') : v));
  const steps = [];
  const addSteps = v => {
    if (!v) return;
    if (typeof v === 'string') { splitInstructionText_(v).forEach(s => steps.push(s)); return; }
    if (Array.isArray(v)) { v.forEach(addSteps); return; }
    if (v['@type'] === 'HowToSection' || v.itemListElement) {
      if (v.name) steps.push('— ' + cleanText_(v.name) + ' —');
      addSteps(v.itemListElement);
      return;
    }
    const s = cleanText_(v.text || v.name || '');
    if (s) splitInstructionText_(s).forEach(x => steps.push(x));
  };
  addSteps(n.recipeInstructions);
  let image = n.image;
  if (Array.isArray(image)) image = image[0];
  if (image && typeof image === 'object') image = image.url || image.contentUrl || '';
  const ingr = (Array.isArray(n.recipeIngredient) ? n.recipeIngredient : (n.recipeIngredient ? [n.recipeIngredient] : (n.ingredients || [])))
    .map(cleanText_).filter(Boolean);
  const kw = Array.isArray(n.keywords) ? n.keywords.join(', ') : (n.keywords || '');
  const list = v => (Array.isArray(v) ? v.join(', ') : (v || ''));
  const prep = isoMinutes(n.prepTime), cook = isoMinutes(n.cookTime);
  let total = isoMinutes(n.totalTime);
  if (total == null && (prep != null || cook != null)) total = (prep || 0) + (cook || 0);
  return {
    name: txt(n.name), source: 'url', url: url || '', image: typeof image === 'string' ? image : '',
    servings: firstInt_(n.recipeYield), prep_min: prep, cook_min: cook, total_min: total,
    oven: findOvenTemp(steps.join(' ')),
    ingredients: ingr.map(parseIngredient), steps: steps, notes: '',
    hints: { cuisine: cleanText_(list(n.recipeCuisine)), category: cleanText_(list(n.recipeCategory)), keywords: cleanText_(kw) },
    locked: []
  };
}

// The page's headline photo (og:image / twitter:image), used when the recipe data has no image.
function ogImage_(html, url) {
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)["']/i) ||
            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (!m) return '';
  let src = m[1].replace(/&amp;/g, '&').trim();
  if (/^\/\//.test(src)) src = 'https:' + src;
  else if (/^\//.test(src)) { const o = String(url || '').match(/^https?:\/\/[^\/]+/i); src = o ? o[0] + src : ''; }
  return /^https?:\/\//i.test(src) ? src : '';
}

function recipeFromMicrodata_(html, url) {
  const grab = prop => {
    const out = [], re = new RegExp('<([a-z0-9]+)[^>]*itemprop=["\']' + prop + '["\'][^>]*>([\\s\\S]*?)</\\1>', 'gi');
    let m; while ((m = re.exec(html))) out.push(cleanText_(m[2]));
    return out.filter(Boolean);
  };
  const ingr = grab('recipeIngredient').concat(grab('ingredients'));
  if (!ingr.length) return null;
  const name = (grab('name')[0]) || cleanText_((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const steps = [];
  grab('recipeInstructions').forEach(s => splitInstructionText_(s).forEach(x => steps.push(x)));
  return { name: name, source: 'url', url: url || '', image: '', servings: null, prep_min: null, cook_min: null, total_min: null,
    oven: findOvenTemp(steps.join(' ')), ingredients: ingr.map(parseIngredient), steps: steps, notes: '', hints: {}, locked: [] };
}

function splitInstructionText_(s) {
  s = String(s || '').trim();
  if (!s) return [];
  const parts = s.split(/\n+|(?:^|\s)(?=\d+[.)]\s+[A-Z])/).map(x => x.replace(/^\d+[.)]\s+/, '').trim()).filter(Boolean);
  return parts.length ? parts : [s];
}

function isoMinutes(v) {
  if (!v) return null;
  if (typeof v === 'number') return Math.round(v);
  const m = String(v).match(/^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+)S)?)?$/i);
  if (!m) return minutesFromText(String(v));
  const mins = (Number(m[1] || 0) * 1440) + (Number(m[2] || 0) * 60) + Number(m[3] || 0) + Math.round(Number(m[4] || 0) / 60);
  return mins > 0 ? Math.round(mins) : null;
}

function firstInt_(v) {
  if (Array.isArray(v)) { for (const x of v) { const n = firstInt_(x); if (n) return n; } return null; }
  const m = String(v == null ? '' : v).match(/\d+/);
  return m ? Number(m[0]) : null;
}

function cleanText_(s) {
  if (s == null) return '';
  return decodeEntities_(String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

function decodeEntities_(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', deg: '°', frac12: '½', frac14: '¼', frac34: '¾',
    ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', eacute: 'é', egrave: 'è', ntilde: 'ñ', reg: '®', trade: '™', frasl: '/' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (all, c) => {
    if (c[0] === '#') { const n = c[1] === 'x' || c[1] === 'X' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10); return isNaN(n) ? all : String.fromCharCode(n); }
    return named[c.toLowerCase()] != null ? named[c.toLowerCase()] : all;
  }).replace(/&amp;/g, '&');
}

/* ── free text → recipe ── */

const H_INGR = /^(?:ingredients?|what you(?:'|’)?ll need|you(?:'|’)?ll need|you will need|shopping list)\b\s*:?\s*$/i;
const H_STEPS = /^(?:directions?|instructions?|method|steps|preparation|how to make(?: it)?|to make|procedure)\b\s*:?\s*$/i;
const H_NOTES = /^(?:notes?|tips?|cook(?:'|’)?s notes?|variations?)\b\s*:?\s*$/i;
const META_LINE = /^(?:serves|servings|yield|makes|prep(?:aration)?(?: time)?|cook(?:ing)? time|total(?: time)?|active time|ready in|oven|temp(?:erature)?)\b/i;

function parseRecipeText(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const lines = raw.split('\n').map(s => s.replace(/\t/g, ' ').trim());
  const meta = extractMeta_(raw);
  let name = '', mode = null, sawHeaders = false, url = '', image = '';
  const ingr = [], steps = [], notes = [], loose = [];

  lines.forEach(line => {
    if (!line) return;
    const clean = line.replace(/^[-•*▢☐□·◦▪●]\s*/, '');
    // "Source: https://…" or a bare link line → the recipe's source link, not a step
    // "Photo: https://…" → the card photo
    const im = clean.match(/^(?:photo|image|picture|pic)\s*:?\s*(https?:\/\/\S+)\s*$/i);
    if (im) { if (!image) image = im[1]; return; }
    const um = clean.match(/^(?:source|original(?:\s+recipe)?|from|link|url|video)\s*:?\s*(https?:\/\/\S+)\s*$/i) || clean.match(/^(https?:\/\/\S+)$/i);
    if (um) { if (!url) url = um[1]; return; }
    if (H_INGR.test(clean)) { mode = 'i'; sawHeaders = true; return; }
    if (H_STEPS.test(clean)) { mode = 's'; sawHeaders = true; return; }
    if (H_NOTES.test(clean)) { mode = 'n'; sawHeaders = true; return; }
    if (!name && !mode && !looksLikeIngredient_(clean) && !META_LINE.test(clean) && clean.split(' ').length <= 12 && !/[.!?]$/.test(clean)) {
      name = clean.replace(/^recipe\s*:\s*/i, ''); return;
    }
    if (META_LINE.test(clean) && clean.length < 80 && mode !== 's') return;
    if (mode === 'i') ingr.push(clean);
    else if (mode === 's') steps.push(clean);
    else if (mode === 'n') notes.push(clean);
    else loose.push(clean);
  });

  // No headers: sort each loose line into ingredient or step.
  loose.forEach(l => {
    if (looksLikeIngredient_(l)) ingr.push(l); else steps.push(l);
  });

  // Plain-language description ("Brown a pound of ground beef with an onion…"): pull ingredients out of the sentences.
  let described = false;
  if (!ingr.length && steps.length) {
    described = true;
    const found = ingredientsFromSentences_(steps.join(' '));
    found.forEach(x => ingr.push(x));
    let sentences = splitSentences_(steps.join(' '));
    const lead = !name && sentences[0] && sentences[0].match(/^([^:]{3,40}):\s+(.+)$/);
    if (lead) { name = lead[1].trim(); sentences[0] = lead[2].charAt(0).toUpperCase() + lead[2].slice(1); }
    sentences = sentences.filter(x => !/^(?:it\s+)?(?:takes|serves|feeds|makes|total)\b/i.test(x));
    steps.length = 0; sentences.forEach(s => steps.push(s));
  }

  const cleanSteps = [];
  steps.forEach(s => {
    s = s.replace(/^(?:step\s*)?\d+\s*[.):\-]\s*/i, '').replace(/^[-•*▢☐□·]\s*/, '').trim();
    if (!s) return;
    // A numbered list pasted as one long line
    if (!described && s.length > 400) splitSentences_(s).forEach(x => cleanSteps.push(x)); else cleanSteps.push(s);
  });

  return {
    name: name, source: 'paste', url: url, image: image,
    servings: meta.servings, prep_min: meta.prep, cook_min: meta.cook, total_min: meta.total, oven: meta.oven,
    ingredients: ingr.map(parseIngredient), steps: cleanSteps, notes: notes.join('\n'),
    hints: {}, locked: [], described: described, sawHeaders: sawHeaders
  };
}

function extractMeta_(t) {
  const grabTime = re => { const m = t.match(re); return m ? minutesFromText(m[1]) : null; };
  const sm = t.match(/\b(?:serves|servings|yield|makes|feeds)\s*:?\s*(?:about\s*)?(\d+)/i) || t.match(/\b(\d+)\s*(?:servings|people|portions)\b/i);
  return {
    servings: sm ? Number(sm[1]) : null,
    prep: grabTime(/\bprep(?:aration)?(?:\s*time)?\s*:?\s*((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b\s*(?:and\s*)?)+)/i),
    cook: grabTime(/\b(?:cook(?:ing)?|bake|baking)(?:\s*time)?\s*:?\s*((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b\s*(?:and\s*)?)+)/i),
    total: grabTime(/\b(?:total|ready in|takes(?: about| around)?|done in(?: about)?)(?:\s*time)?\s*:?\s*((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b\s*(?:and\s*)?)+)/i) ??
      grabTime(/\b(?:feeds|serves|makes)\s*\d+\s*(?:people)?\s*[,;-]?\s*(?:and\s*)?(?:takes\s*)?(?:about|around|in|under)?\s*((?:\d+\s*(?:hours?|hrs?|minutes?|mins?)\b\s*(?:and\s*)?)+)/i) ??
      grabTime(/\b(?:about|around|under)\s+((?:\d+\s*(?:hours?|hrs?|minutes?|mins?)\b\s*(?:and\s*)?)+)\s*(?:total|start to finish|all in|from start)/i),
    oven: findOvenTemp(t)
  };
}

function minutesFromText(s) {
  let mins = 0, hit = false;
  String(s || '').replace(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/gi, (a, n, u) => {
    hit = true; mins += /^h/i.test(u) ? Number(n) * 60 : Number(n); return a;
  });
  return hit ? Math.round(mins) : null;
}

function findOvenTemp(t) {
  const m = String(t || '').match(/(\d{3})\s*(?:°|º|degrees?|deg\.?)\s*([FC])?\b/i) ||
            String(t || '').match(/(?:oven|preheat)[^.]{0,40}?\b(\d{3})\b\s*([FC])?\b/i);
  if (!m) return '';
  const n = Number(m[1]);
  if (n < 200 || n > 550) return '';
  return n + '°' + ((m[2] || 'F').toUpperCase());
}

function splitSentences_(t) {
  return String(t).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map(s => s.trim()).filter(Boolean);
}

/* ── ingredient lines ── */

const UNIT_ALIASES = {
  cup: ['cup', 'cups', 'c', 'c.'], tbsp: ['tablespoon', 'tablespoons', 'tbsp', 'tbsp.', 'tbs', 'tbs.', 'tbl', 'tbl.', 'tbsps', 'T'],
  tsp: ['teaspoon', 'teaspoons', 'tsp', 'tsp.', 'tsps', 't'], oz: ['ounce', 'ounces', 'oz', 'oz.'],
  'fl oz': ['fl oz', 'fl. oz.', 'fluid ounce', 'fluid ounces'], lb: ['pound', 'pounds', 'lb', 'lbs', 'lb.', 'lbs.'],
  g: ['g', 'gram', 'grams', 'gr'], kg: ['kg', 'kilogram', 'kilograms'], ml: ['ml', 'milliliter', 'milliliters', 'millilitre'],
  l: ['l', 'liter', 'liters', 'litre', 'litres'], qt: ['quart', 'quarts', 'qt'], pt: ['pint', 'pints', 'pt'], gal: ['gallon', 'gallons'],
  pinch: ['pinch', 'pinches'], dash: ['dash', 'dashes'], clove: ['clove', 'cloves'], can: ['can', 'cans'], jar: ['jar', 'jars'],
  package: ['package', 'packages', 'pkg', 'pkgs', 'packet', 'packets', 'envelope', 'envelopes', 'box', 'boxes', 'bag', 'bags'],
  bunch: ['bunch', 'bunches'], slice: ['slice', 'slices'], stick: ['stick', 'sticks'], head: ['head', 'heads'], sprig: ['sprig', 'sprigs'],
  stalk: ['stalk', 'stalks', 'rib', 'ribs'], piece: ['piece', 'pieces'], handful: ['handful', 'handfuls'], bottle: ['bottle', 'bottles'],
  container: ['container', 'containers', 'tub', 'tubs'], block: ['block', 'blocks'], loaf: ['loaf', 'loaves'], fillet: ['fillet', 'fillets']
};
const UNIT_LOOKUP = (() => {
  const m = {};
  Object.keys(UNIT_ALIASES).forEach(u => UNIT_ALIASES[u].forEach(a => { m[a] = u; }));
  return m;
})();
const FRAC = { '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5', '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' };
const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, half: 0.5, dozen: 12, couple: 2, few: 3 };
const NUM_RE = '(?:\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d*\\.\\d+|\\d+)';

function numVal_(s) {
  s = String(s).trim();
  let m;
  if ((m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/))) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  if ((m = s.match(/^(\d+)\/(\d+)$/))) return Number(m[1]) / Number(m[2]);
  return Number(s);
}

function normFractions_(s) {
  return String(s).replace(/(\d+)\s*(?:&|and|\+)\s*(\d+\/\d+|[½⅓⅔¼¾⅛])/g, '$1 $2').replace(/(\d)\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/g, (a, d, f) => d + ' ' + FRAC[f])
    .replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, f => FRAC[f]).replace(/⁄/g, '/');
}

const PREP_WORDS = /^(?:(?:very |finely |roughly |thinly |coarsely |freshly |lightly |well |fully |cut )+)?(?:diced|chopped|minced|sliced|cut|drained|rinsed|peeled|divided|softened|melted|grated|shredded|crushed|beaten|cubed|julienned|halved|quartered|seeded|trimmed|cooked|thawed|at room|room temp|to taste|optional|for |plus |or |about |packed|juiced|zested|torn|deveined|patted|separated|warmed|cold|chilled|stemmed|cored|removed|uncooked|raw|ripe|large|small|medium|room-temperature|at room temperature|pounded|sifted|toasted|smashed|mashed|broken|in |into |if |such as|preferably|lightly|squeezed|rinsed|washed|dried|fresh|frozen|and |divided)/i;

function parseIngredient(line) {
  const raw = String(line || '').replace(/\s*\(\$[\d.]+\)/g, '').replace(/\s+/g, ' ').trim();
  const out = { raw: raw, qty: null, qty2: null, unit: '', item: '', note: '', header: false };
  if (!raw) return out;
  let s = normFractions_(raw.replace(/^[-•*▢☐□·◦▪●]\s*/, ''));
  if (/:$/.test(s) && s.split(' ').length <= 6 && !new RegExp('^' + NUM_RE).test(s)) { out.header = true; out.item = s.replace(/:$/, ''); return out; }

  let m = s.match(new RegExp('^(' + NUM_RE + ')(?:\\s*(?:-|–|to)\\s*(' + NUM_RE + '))?\\s*'));
  if (m) {
    out.qty = numVal_(m[1]);
    if (m[2]) out.qty2 = numVal_(m[2]);
    s = s.slice(m[0].length);
  } else if ((m = s.match(/^(a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|half(?:\s+a)?|a\s+couple(?:\s+of)?|a\s+few|a\s+dozen)\s+/i))) {
    const w = m[1].toLowerCase().replace(/\s+(a|of)$/, '').replace(/^a\s+/, '');
    out.qty = WORD_NUM[w] != null ? WORD_NUM[w] : 1;
    s = s.slice(m[0].length);
  }
  // "(15 oz)" package size right after the number
  const pk = s.match(/^\(([^)]*)\)\s*/);
  if (pk) { out.note = pk[1]; s = s.slice(pk[0].length); }
  // unit
  const um = s.match(/^(fl\.?\s*oz\.?|fluid ounces?|[A-Za-z]+\.?)(?=\s|$|,)/);
  if (um && (out.qty != null || /^(pinch|dash|handful)/i.test(um[1]))) {
    const token = um[1];
    const unit = UNIT_LOOKUP[token] || UNIT_LOOKUP[token.toLowerCase()] || UNIT_LOOKUP[token.toLowerCase().replace(/\s+/g, ' ')];
    if (unit) {
      out.unit = unit;
      s = s.slice(um[0].length).trim();
      if (out.qty == null) out.qty = 1;
    }
  }
  s = s.replace(/^of\s+/i, '').trim();
  // notes after a comma or in parentheses
  const paren = s.match(/\s*\(([^)]*)\)\s*/);
  if (paren) { out.note = (out.note ? out.note + '; ' : '') + paren[1]; s = s.replace(paren[0], ' ').trim(); }
  // Split "onion, diced" but not "boneless, skinless chicken breast"
  let ci = -1, from = 0;
  while ((from = s.indexOf(',', from)) > 0) {
    if (PREP_WORDS.test(s.slice(from + 1).trim())) { ci = from; break; }
    from++;
  }
  if (ci > 0) { out.note = (out.note ? out.note + '; ' : '') + s.slice(ci + 1).trim(); s = s.slice(0, ci).trim(); }
  out.item = s || raw;
  return out;
}

function looksLikeIngredient_(l) {
  const s = normFractions_(l.replace(/^[-•*▢☐□·◦▪●]\s*/, ''));
  const words = s.split(/\s+/).length;
  if (/^(?:step\s*)?\d+\s*[.):]\s+/i.test(s)) return false;           // numbered step
  if (new RegExp('^' + NUM_RE + '(?:\\s*(?:-|–|to)\\s*' + NUM_RE + ')?\\s*(?:\\([^)]*\\)\\s*)?[A-Za-z]').test(s)) {
    return words <= 14 && !/[.!?]\s+\S/.test(s);                     // "2 cups flour" — not "3 minutes later, stir…"
  }
  if (/^(?:a|an|one|two|three|four|half|a pinch|pinch|dash|salt|pepper|kosher salt|salt and pepper)\b/i.test(s) && words <= 8 && !/[.!?]$/.test(s)) return true;
  if (/\b(?:to taste|for garnish|for serving|optional)\b/i.test(s) && words <= 10) return true;
  return false;
}

// Pull "a pound of ground beef", "2 cans black beans", "an onion" out of plain sentences.
function ingredientsFromSentences_(t) {
  const units = Object.keys(UNIT_LOOKUP).filter(u => u.length > 1 && !/\./.test(u)).sort((a, b) => b.length - a.length).join('|');
  const re = new RegExp('\\b(' + NUM_RE + '|a|an|one|two|three|four|five|six|half an?|a couple(?: of)?|a few)\\s+(?:(' + units + ')\\s+(?:of\\s+)?)?' +
    '((?:[a-z][a-z\'-]*\\s?){1,4}?)(?=\\s*(?:,|\\.|;|\\band\\b|\\bwith\\b|\\bthen\\b|\\buntil\\b|\\bfor\\b|\\bin\\b|\\binto\\b|\\bover\\b|\\bon\\b|$))', 'gi');
  const skip = /^(?:minutes?|mins?|hours?|hrs?|seconds?|time|while|bit|little|boil|simmer|large|medium|small|bowl|pan|pot|skillet|oven|dish|sheet|side|layer|few minutes|couple minutes|degrees?)$/i;
  const out = [], seen = {};
  let m;
  const text = normFractions_(t);
  while ((m = re.exec(text))) {
    const item = m[3].trim().replace(/\s+(?:and|with|then)$/i, '');
    if (!item || skip.test(item) || skip.test(item.split(' ')[0])) continue;
    if (/^(?:the|it|them|some|until|about|more)\b/i.test(item)) continue;
    const line = (m[1] + ' ' + (m[2] ? m[2] + ' ' : '') + item).replace(/\s+/g, ' ').trim();
    const k = item.toLowerCase();
    if (!seen[k]) { seen[k] = 1; out.push(line); }
  }
  return out;
}

/* ── automatic tagging ── */

const TAG_OPTIONS = {
  cuisine: ['American', 'Italian', 'Mexican', 'Asian', 'Chinese', 'Japanese', 'Thai', 'Korean', 'Indian', 'Mediterranean', 'Southern & Cajun', 'BBQ', 'French', 'Other'],
  protein: ['Chicken', 'Beef', 'Pork', 'Turkey', 'Lamb', 'Seafood', 'Game', 'Vegetarian'],
  role: ['Complete meal', 'Main', 'Side'],
  side_type: ['Veggie', 'Starch', 'Salad / bread'],
  category: ['Pasta', 'Tacos & Wraps', 'Soup, Stew & Chili', 'Casserole & Bake', 'Stir-fry & Noodles', 'Rice & Bowls', 'Sandwiches & Burgers',
    'Salad', 'Pizza & Flatbread', 'Sheet Pan & Roast', 'Grill', 'Skillet & Sides']
};

// Keywords: [word or phrase, weight]. Weight 3 = strong signal, 1 = weak.
const CUISINE_KW = {
  Italian: [['pasta', 3], ['spaghetti', 3], ['penne', 3], ['lasagna', 3], ['parmesan', 2], ['parmigiano', 3], ['mozzarella', 2], ['marinara', 3], ['basil', 1],
    ['italian', 4], ['pesto', 3], ['risotto', 3], ['gnocchi', 3], ['ricotta', 2], ['alfredo', 3], ['carbonara', 3], ['bolognese', 3], ['meatball', 2],
    ['prosciutto', 3], ['piccata', 3], ['marsala', 3], ['ziti', 3], ['fettuccine', 3], ['linguine', 3], ['rigatoni', 3], ['tortellini', 3], ['ravioli', 3],
    ['bruschetta', 3], ['caprese', 3], ['parm', 2], ['oregano', 1], ['pancetta', 2], ['orzo', 1], ['cacciatore', 3], ['scampi', 3], ['tuscan', 3], ['focaccia', 2]],
  Mexican: [['taco', 4], ['tortilla', 3], ['salsa', 2], ['enchilada', 4], ['burrito', 4], ['quesadilla', 4], ['fajita', 4], ['cumin', 1], ['chili powder', 1],
    ['jalapeño', 1], ['jalapeno', 1], ['cilantro', 1], ['black beans', 1], ['pinto', 2], ['refried', 3], ['queso', 3], ['chipotle', 2], ['cotija', 3],
    ['guacamole', 3], ['mexican', 4], ['carnitas', 4], ['pico de gallo', 3], ['nacho', 3], ['tamale', 4], ['poblano', 2], ['ancho', 2], ['tostada', 4],
    ['elote', 3], ['barbacoa', 4], ['al pastor', 4], ['taco seasoning', 3], ['monterey jack', 1], ['pepper jack', 1], ['tex-mex', 4], ['southwest', 3]],
  Chinese: [['hoisin', 3], ['lo mein', 4], ['fried rice', 3], ['five-spice', 3], ['five spice', 3], ['orange chicken', 4], ['kung pao', 4], ['general tso', 4],
    ['chow mein', 4], ['szechuan', 4], ['sichuan', 4], ['bok choy', 2], ['oyster sauce', 2], ['wonton', 3], ['dumpling', 2], ['egg roll', 3],
    ['chinese', 4], ['sweet and sour', 3], ['mongolian', 3], ['cashew chicken', 3], ['sesame chicken', 3], ['shaoxing', 3], ['broccoli beef', 3], ['beef and broccoli', 3]],
  Japanese: [['teriyaki', 4], ['miso', 3], ['sushi', 4], ['ramen', 3], ['udon', 4], ['katsu', 4], ['mirin', 2], ['tempura', 4], ['yakitori', 4],
    ['furikake', 3], ['japanese', 4], ['sake', 1], ['panko', 1], ['hibachi', 4], ['yum yum', 3]],
  Thai: [['thai', 4], ['curry paste', 3], ['coconut milk', 1], ['fish sauce', 2], ['lemongrass', 3], ['pad thai', 4], ['peanut sauce', 2],
    ['galangal', 3], ['sweet chili', 2], ['red curry', 3], ['green curry', 3], ['panang', 4], ['satay', 3]],
  Korean: [['gochujang', 4], ['kimchi', 4], ['bulgogi', 4], ['korean', 4], ['bibimbap', 4], ['gochugaru', 4], ['japchae', 4]],
  Indian: [['garam masala', 4], ['curry powder', 2], ['turmeric', 1], ['tikka', 4], ['masala', 3], ['naan', 3], ['ghee', 2], ['paneer', 4], ['cardamom', 1],
    ['dal', 2], ['korma', 4], ['tandoori', 4], ['basmati', 1], ['chutney', 2], ['biryani', 4], ['vindaloo', 4], ['butter chicken', 4], ['indian', 4], ['coriander', 1]],
  Asian: [['soy sauce', 1], ['sesame oil', 1], ['ginger', 1], ['rice vinegar', 1], ['sriracha', 1], ['asian', 3], ['stir fry', 1], ['stir-fry', 1], ['sesame seeds', 1], ['scallion', 1]],
  Mediterranean: [['feta', 2], ['tzatziki', 4], ['gyro', 4], ['greek', 4], ['kalamata', 3], ['hummus', 3], ['pita', 2], ['couscous', 2], ['shawarma', 4],
    ['falafel', 4], ['tahini', 3], ["za'atar", 4], ['zaatar', 4], ['souvlaki', 4], ['mediterranean', 4], ['lemon', 1], ['olive', 1], ['kebab', 2], ['kofta', 4], ['sumac', 3]],
  'Southern & Cajun': [['cajun', 4], ['creole', 4], ['andouille', 3], ['jambalaya', 4], ['gumbo', 4], ['blackened', 3], ['grits', 3], ['biscuit', 2],
    ['collard', 3], ['okra', 3], ['cornbread', 2], ['fried chicken', 3], ['buttermilk', 1], ['old bay', 2], ['etouffee', 4], ['étouffée', 4], ['po boy', 4],
    ['southern', 3], ['hush pupp', 3], ['low country', 4], ['chicken and dumplings', 4]],
  BBQ: [['bbq', 4], ['barbecue', 4], ['pulled pork', 3], ['brisket', 2], ['smoked', 2], ['dry rub', 3], ['ribs', 2], ['bbq sauce', 3], ['barbecue sauce', 3], ['liquid smoke', 2]],
  French: [['french', 3], ['gruyère', 2], ['gruyere', 2], ['bourguignon', 4], ['coq au vin', 4], ['provençal', 3], ['provencal', 3], ['béchamel', 2],
    ['crepe', 3], ['quiche', 4], ['ratatouille', 4], ['herbes de provence', 3], ['dijon', 1], ['shallot', 1], ['au jus', 2], ['croque', 4]],
  American: [['burger', 3], ['meatloaf', 4], ['mac and cheese', 4], ['macaroni and cheese', 4], ['pot roast', 4], ['sloppy joe', 4], ['pot pie', 4],
    ['grilled cheese', 4], ['hot dog', 4], ['ranch', 2], ['cheddar', 1], ['ketchup', 1], ['mashed potato', 2], ['buffalo', 3], ['chili', 1],
    ['casserole', 2], ['tater tot', 3], ['cream of', 2], ['american', 3], ['philly', 4], ['cheesesteak', 4], ['salisbury', 4], ['shepherd', 3], ['cobb', 3],
    ['country fried', 3], ['chicken fried', 3], ['stroganoff', 2], ['worcestershire', 1]]
};

const PROTEIN_KW = {
  Chicken: ['chicken', 'rotisserie', 'drumstick', 'cornish hen'],
  Beef: ['beef', 'steak', 'sirloin', 'brisket', 'chuck', 'hamburger', 'flank', 'ribeye', 'rib eye', 'short rib', 'ground chuck', 'tri-tip', 'tri tip', 'skirt', 'filet mignon', 'veal', 'meatball'],
  Pork: ['pork', 'bacon', 'ham', 'sausage', 'chorizo', 'prosciutto', 'pancetta', 'carnitas', 'andouille', 'kielbasa', 'bratwurst', 'brats', 'pepperoni', 'salami', 'hot dog', 'baby back', 'spare ribs'],
  Turkey: ['turkey'],
  Lamb: ['lamb', 'mutton'],
  Game: ['venison', 'rabbit', 'bear meat', 'bison', 'elk', 'wild boar', 'duck', 'quail', 'pheasant'],
  Seafood: ['shrimp', 'salmon', 'tilapia', 'cod', 'fish', 'tuna', 'crab', 'scallop', 'mahi', 'halibut', 'lobster', 'mussel', 'clam', 'catfish', 'prawn', 'grouper', 'snapper', 'trout', 'swordfish', 'crawfish', 'haddock', 'flounder'],
  Vegetarian: ['tofu', 'tempeh', 'chickpea', 'lentil', 'paneer', 'black bean', 'seitan', 'veggie', 'vegetarian', 'meatless', 'impossible', 'beyond meat']
};
// Lines that mention a protein word but aren't the protein.
const NOT_PROTEIN = /\b(broth|stock|bouillon|base|better than|fish sauce|oyster sauce|anchov|bacon grease|ham hock seasoning|seasoning)\b/i;

const CATEGORY_KW = {
  'Pasta': [['pasta', 4], ['spaghetti', 4], ['penne', 4], ['lasagna', 4], ['macaroni', 4], ['mac and cheese', 4], ['ziti', 4], ['fettuccine', 4], ['linguine', 4],
    ['rigatoni', 4], ['orzo', 3], ['tortellini', 4], ['ravioli', 4], ['gnocchi', 4], ['alfredo', 3], ['carbonara', 4], ['bolognese', 3], ['shells', 2], ['rotini', 4], ['farfalle', 4], ['bow tie', 3], ['angel hair', 4], ['noodle', 1]],
  'Tacos & Wraps': [['taco', 5], ['burrito', 5], ['wrap', 4], ['quesadilla', 5], ['fajita', 5], ['enchilada', 4], ['tostada', 5], ['gyro', 5], ['lettuce wrap', 5], ['tortilla', 1], ['nacho', 4], ['chimichanga', 5], ['flauta', 5]],
  'Soup, Stew & Chili': [['soup', 5], ['stew', 5], ['chili', 4], ['chowder', 5], ['gumbo', 5], ['bisque', 5], ['pho', 4], ['ramen', 4], ['pozole', 5], ['minestrone', 5], ['broth', 1], ['dumplings', 2]],
  'Casserole & Bake': [['casserole', 5], ['bake', 3], ['baked', 1], ['pot pie', 5], ['gratin', 4], ['shepherd', 4], ['hotdish', 5], ['meatloaf', 4], ['strata', 4], ['au gratin', 4], ['9x13', 3], ['baking dish', 2], ['enchilada', 1]],
  'Stir-fry & Noodles': [['stir fry', 5], ['stir-fry', 5], ['stir-fried', 5], ['wok', 3], ['lo mein', 5], ['chow mein', 5], ['pad thai', 5], ['fried rice', 3], ['udon', 4], ['noodles', 2], ['lo-mein', 5], ['japchae', 5]],
  'Rice & Bowls': [['bowl', 5], ['rice', 1], ['risotto', 5], ['jambalaya', 5], ['biryani', 5], ['curry', 3], ['tikka', 3], ['butter chicken', 3], ['korma', 3], ['fried rice', 3], ['bibimbap', 5], ['poke', 4], ['pilaf', 4], ['paella', 5]],
  'Sandwiches & Burgers': [['sandwich', 5], ['burger', 5], ['slider', 5], ['sub', 2], ['panini', 5], ['sloppy joe', 5], ['melt', 4], ['hoagie', 5], ['po boy', 5], ['grilled cheese', 5],
    ['cheesesteak', 5], ['hot dog', 5], ['french dip', 5], ['bun', 1], ['roll', 1], ['pita', 2], ['croque', 5]],
  'Salad': [['salad', 5], ['cobb', 3]],
  'Pizza & Flatbread': [['pizza', 5], ['flatbread', 5], ['calzone', 5], ['stromboli', 5], ['naan pizza', 5]],
  'Sheet Pan & Roast': [['sheet pan', 5], ['sheet-pan', 5], ['roast', 3], ['roasted', 2], ['baking sheet', 2], ['rimmed baking sheet', 2], ['pot roast', 3], ['tray bake', 5], ['traybake', 5]],
  'Grill': [['grilled', 3], ['grill', 3], ['kebab', 4], ['kabob', 4], ['skewer', 4], ['barbecue', 1], ['bbq', 1], ['hibachi', 3]],
  'Skillet & Sides': [['skillet', 3], ['pan-seared', 3], ['pan seared', 3], ['seared', 1], ['chops', 2], ['cutlet', 3], ['piccata', 3], ['marsala', 3], ['one pan', 2], ['one-pan', 2], ['smothered', 3], ['stroganoff', 3], ['teriyaki', 1]]
};

function autoTag(r) {
  const name = ' ' + String(r.name || '').toLowerCase() + ' ';
  const ingr = (r.ingredients || []).filter(i => !i.header);
  const ingrText = ' ' + ingr.map(i => (i.item || i.raw || '')).join(' | ').toLowerCase() + ' ';
  const stepText = ' ' + (r.steps || []).join(' ').toLowerCase() + ' ';
  const hints = r.hints || {};
  const hintText = (' ' + (hints.cuisine || '') + ' ' + (hints.keywords || '') + ' ').toLowerCase();

  const has = (text, w) => new RegExp('(^|[^a-z])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(e?s)?([^a-z]|$)').test(text);

  // Cuisine
  const cScore = {}, cWhy = {};
  Object.keys(CUISINE_KW).forEach(c => {
    let s = 0; const why = [];
    CUISINE_KW[c].forEach(([w, wt]) => {
      let add = 0;
      if (has(name, w)) add += wt * (wt >= 2 ? 3 : 1.5);
      if (has(ingrText, w)) add += wt;
      else if (has(stepText, w)) add += wt * 0.5;
      if (has(hintText, w)) add += wt * 2;
      if (add) { s += add; why.push(w); }
    });
    cScore[c] = s; cWhy[c] = why;
  });
  // Direct cuisine hint from the recipe site ("Mexican", "Italian"…)
  const hintC = (hints.cuisine || '').toLowerCase();
  TAG_OPTIONS.cuisine.forEach(c => { if (hintC && hintC.indexOf(c.toLowerCase().split(' ')[0]) >= 0) { cScore[c] = (cScore[c] || 0) + 12; (cWhy[c] = cWhy[c] || []).unshift('site says ' + hints.cuisine); } });
  if (/tex-?mex|latin/.test(hintC)) cScore.Mexican += 12;
  if (/greek|middle eastern|lebanese|turkish/.test(hintC)) cScore.Mediterranean += 12;
  if (/cajun|creole|southern|soul/.test(hintC)) cScore['Southern & Cajun'] += 12;
  // Generic "Asian" only wins if no specific Asian cuisine is clear
  const asianSpecific = ['Chinese', 'Japanese', 'Thai', 'Korean', 'Indian'];
  const bestAsian = asianSpecific.reduce((b, c) => (cScore[c] > cScore[b] ? c : b), 'Chinese');
  if (cScore[bestAsian] >= 3) { cScore[bestAsian] += cScore.Asian; cWhy[bestAsian] = cWhy[bestAsian].concat(cWhy.Asian); cScore.Asian = 0; }
  let cuisine = 'American', cBest = 0;
  Object.keys(cScore).forEach(c => { if (cScore[c] > cBest) { cBest = cScore[c]; cuisine = c; } });
  const cuisineWhy = cBest < 3 ? 'No strong clues — defaulted to American' + (cWhy[cuisine] && cWhy[cuisine].length ? ' (weak hints: ' + cWhy[cuisine].slice(0, 4).join(', ') + ')' : '') : 'Matched ' + cWhy[cuisine].slice(0, 6).join(', ');
  if (cBest < 3) cuisine = 'American';

  // Protein: main protein is usually named in the title or is a big-quantity ingredient near the top.
  const pScore = {}, pWhy = {};
  Object.keys(PROTEIN_KW).forEach(p => { pScore[p] = 0; pWhy[p] = []; });
  Object.keys(PROTEIN_KW).forEach(p => PROTEIN_KW[p].forEach(w => {
    if (has(name, w)) { pScore[p] += 8; pWhy[p].push('"' + w + '" in the name'); }
  }));
  ingr.forEach((i, idx) => {
    const t = ' ' + (i.item || i.raw || '').toLowerCase() + ' ';
    if (NOT_PROTEIN.test(t)) return;
    Object.keys(PROTEIN_KW).forEach(p => PROTEIN_KW[p].some(w => {
      if (!has(t, w)) return false;
      let add = 2;
      if (/^(lb|kg)$/.test(i.unit) || (i.unit === 'oz' && (i.qty || 0) >= 8) || /\b(breast|thigh|fillet|tenderloin|loin|chop|roast|ground)\b/.test(t)) add += 3;
      if (idx < 3) add += 1;
      if (p === 'Vegetarian' && /black bean/.test(w)) add -= 1;
      pScore[p] += add; pWhy[p].push(i.item || i.raw);
      return true;
    }));
  });
  let protein = 'Vegetarian', pBest = 0;
  ['Chicken', 'Beef', 'Pork', 'Turkey', 'Lamb', 'Seafood', 'Game'].forEach(p => { if (pScore[p] > pBest) { pBest = pScore[p]; protein = p; } });
  let proteinWhy;
  if (pBest < 2) { protein = 'Vegetarian'; proteinWhy = 'No meat or seafood found in the ingredients'; }
  else proteinWhy = 'Found ' + pWhy[protein].slice(0, 3).join(', ');
  // "Meatball" alone is ambiguous with turkey
  if (protein === 'Beef' && pScore.Turkey >= pBest) { protein = 'Turkey'; proteinWhy = 'Found ' + pWhy.Turkey.slice(0, 3).join(', '); }

  // Dish type — mostly from the name
  const kScore = {}, kWhy = {};
  Object.keys(CATEGORY_KW).forEach(k => {
    let s = 0; const why = [];
    CATEGORY_KW[k].forEach(([w, wt]) => {
      let add = 0;
      if (has(name, w)) add += wt * 3;
      if (has(ingrText, w)) add += wt * (k === 'Pasta' ? 1 : 0.6);
      if (has(stepText, w)) add += wt * 0.4;
      if (add) { s += add; why.push(w); }
    });
    kScore[k] = s; kWhy[k] = why;
  });
  const hintK = (hints.category || '').toLowerCase();
  if (/soup|stew|chili/.test(hintK)) kScore['Soup, Stew & Chili'] += 8;
  if (/salad/.test(hintK) && !/side/.test(hintK)) kScore.Salad += 6;
  if (/sandwich|burger/.test(hintK)) kScore['Sandwiches & Burgers'] += 8;
  if (/pasta/.test(hintK)) kScore.Pasta += 8;
  if (/casserole/.test(hintK)) kScore['Casserole & Bake'] += 8;
  // "Pasta bake" / "baked ziti" is pasta first
  if (kScore.Pasta >= 9) kScore['Casserole & Bake'] *= 0.5;
  let category = 'Skillet & Sides', kBest = 0;
  Object.keys(kScore).forEach(k => { if (kScore[k] > kBest) { kBest = kScore[k]; category = k; } });
  let categoryWhy = 'Matched ' + (kWhy[category] || []).slice(0, 5).join(', ');
  if (kBest < 3) { category = 'Skillet & Sides'; categoryWhy = 'No dish-type clues — filed as a main with sides'; }

  return {
    cuisine: cuisine, protein: protein, category: category,
    why: { cuisine: cuisineWhy, protein: proteinWhy, category: categoryWhy },
    sure: { cuisine: cBest >= 6, protein: pBest >= 6 || protein === 'Vegetarian', category: kBest >= 9 }
  };
}

/* ── meal role: complete meal / main that needs sides / side ── */

const ROLE_OPTIONS = ['Complete meal', 'Main', 'Side'];
const SIDE_TYPES = ['Veggie', 'Starch', 'Salad / bread'];
const SIDE_NAME_RE = /\b(sides?|pilaf|mashed|smashed|roasted (?:potato|veg|vegetable|broccoli|carrot|asparagus|brussels|cauliflower|squash)|green beans?|asparagus|broccoli|broccolini|zucchini|squash|corn|elote|coleslaw|slaw|salad|couscous|quinoa|potato(?:es)?|fries|tots|rolls?|biscuits?|cornbread|garlic bread|bread|carrots?|brussels sprouts|spinach|cauliflower|mac (?:and|&|n) cheese|macaroni and cheese|baked beans|rice|ratatouille|byaldi|vegetables|veggies|polenta|grits|risotto)\b/i;
const STARCH_RE = /\b(rice|pilaf|potato(?:es)?|fries|tots|couscous|quinoa|pasta|macaroni|mac (?:and|&|n) cheese|orzo|noodles?|polenta|grits|risotto|beans|stuffing)\b/i;
const BREAD_SALAD_RE = /\b(salad|slaw|coleslaw|rolls?|biscuits?|cornbread|bread|naan|pita|focaccia)\b/i;
const MEAL_CATS = ['Pasta', 'Soup, Stew & Chili', 'Rice & Bowls', 'Tacos & Wraps', 'Sandwiches & Burgers', 'Pizza & Flatbread', 'Stir-fry & Noodles', 'Salad'];
// Starch in the ingredients means the dish already carries its own carb (rice skillet, sheet-pan potatoes…).
const ING_STARCH_RE = /\b(rice|pasta|spaghetti|penne|noodles?|potato(?:es)?|gnocchi|tortillas?|buns?|orzo|risoni|couscous|quinoa|dumplings?|biscuits?|macaroni|shells|ziti|lasagna|lasagne|tortellini|ravioli|ramen|udon|pappardelle|linguine|fettuccine|sourdough|loaf)\b/i;
const NOT_STARCH_RE = /\b(bread ?crumbs|panko|flour|starch|rice vinegar|rice wine|noodle water)\b/i;

function sideTypeFor_(name) {
  if (/\b(salad|slaw|coleslaw)\b/i.test(name)) return 'Salad / bread';
  if (STARCH_RE.test(name)) return 'Starch';
  if (BREAD_SALAD_RE.test(name)) return 'Salad / bread';
  return 'Veggie';
}

function autoRole(r) {
  const name = String(r.name || '');
  const hintK = String((r.hints && r.hints.category) || (r.auto && r.auto.hints && r.auto.hints.category) || '').toLowerCase();
  const meaty = r.protein && r.protein !== 'Vegetarian';
  const notSide = r.category === 'Soup, Stew & Chili' || /\b(soup|stew|chili|chowder|rotolo|lasagna|casserole|bake|pizza|sandwich|burger|tacos?|bowl)\b/i.test(name);
  if (!notSide && (/\bside/.test(hintK) || (!meaty && SIDE_NAME_RE.test(name)))) {
    return { role: 'Side', side_type: sideTypeFor_(name), sure: /\bside/.test(hintK), why: /\bside/.test(hintK) ? 'Site files it as a side dish' : 'No meat, and the name sounds like a side ("' + (name.match(SIDE_NAME_RE) || [''])[0] + '")' };
  }
  if (MEAL_CATS.indexOf(r.category) >= 0) return { role: 'Complete meal', side_type: '', sure: true, why: r.category + ' dishes are a full dinner on their own' };
  const ingr = (r.ingredients || []).filter(i => !i.header).map(i => String(i.item || i.raw || ''));
  const carb = ingr.find(t => ING_STARCH_RE.test(t) && !NOT_STARCH_RE.test(t));
  if (carb) return { role: 'Complete meal', side_type: '', sure: false, why: 'Has its own starch (' + carb + '), so it probably doesn\'t need sides' };
  if (!meaty && r.protein !== 'Vegetarian') return { role: 'Complete meal', side_type: '', sure: false, why: 'Couldn\'t tell — filed as a complete meal' };
  return { role: 'Main', side_type: '', sure: r.category === 'Grill' || r.category === 'Skillet & Sides', why: 'A ' + String(r.protein || '').toLowerCase() + ' dish with no starch of its own — pair it with sides' };
}

/* ───────────────────────────── one-time bulk import (run from the editor only) ───────────────────────────── */
// Reads the "Kitchen Import" Google Sheets (columns: site, url, notes, data). A row with data (recipe JSON pulled
// through the browser) is read directly; a row without data is fetched like "From a link". Same reader and
// auto-tagging as a normal import. Skips links already in the library. Not callable from the web app.
const IMPORT_SHEETS_ = ['1-wzr_g0QEjrjgXbPluwOCNB1tsk15jfLhTBq409-6MI', '13VqXb5bz_gZE1vWFAUU8WCaolC9mpycMYwfxjvUJCHI', '11bdEo0HJ3oMTJfeyXJtg2ESKBLhWeYtED1ziYIjRE9g'];
function cleanIngr_(s) {
  return String(s || '').replace(/\(\(?\s*note\s*\d+\s*\)?\)/gi, '').replace(/\(\(/g, '(').replace(/\)\)/g, ')')
    .replace(/\(\s*,\s*/g, '(').replace(/\(\s*\)/g, '').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim();
}
function runBulkImport() {
  const norm = u => String(u || '').replace(/[?#].*$/, '').replace(/\/$/, '');
  const have = {};
  listRecipes_().forEach(r => { if (r.url) have[norm(r.url)] = 1; });
  const rows = [], log = [], now = new Date();
  IMPORT_SHEETS_.forEach(id => {
    const vals = SpreadsheetApp.openById(id).getSheets()[0].getDataRange().getValues();
    const h = vals[0].map(String);
    const ci = n => h.indexOf(n);
    vals.slice(1).forEach(v => {
      const site = v[ci('site')], url = String(v[ci('url')] || '').trim(), notes = String(v[ci('notes')] || ''), data = String(v[ci('data')] || '');
      try {
        if (!url) return;
        if (have[norm(url)]) { log.push('SKIP (already in) ' + url); return; }
        let html;
        if (data) {
          const j = JSON.parse(data);
          html = '<script type="application/ld+json">' + JSON.stringify(j) + '</script>';
        } else {
          const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true,
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } });
          if (res.getResponseCode() >= 400) throw new Error('site said ' + res.getResponseCode());
          html = res.getContentText();
        }
        const d = recipeFromHtml(html, url);
        if (!d) throw new Error('no recipe found');
        if (!d.image) d.image = ogImage_(html, url);
        d.ingredients = (d.ingredients || []).map(i => cleanIngr_(typeof i === 'string' ? i : (i.raw || ''))).filter(Boolean);
        if (notes) d.notes = (d.notes ? d.notes + '\n' : '') + notes;
        d.source = 'url'; d.url = url;
        const r = finishDraft(normalizeDraft_(d));
        if (!r.name || !r.ingredients.length) throw new Error('missing name or ingredients');
        r.id = Utilities.getUuid(); r.created_by = 'kevin'; r.created_at = now; r.updated_by = 'kevin'; r.updated_at = now;
        rows.push(toRow_(r)); have[norm(url)] = 1;
        log.push('OK ' + site + ' | ' + r.name + ' | ' + (r.total_min == null ? '?' : r.total_min) + ' min | ' + [r.cuisine, r.protein, r.category].join('/') + (r.image ? '' : ' | NO PHOTO'));
      } catch (err) { log.push('FAIL ' + site + ' ' + url + ' — ' + (err.message || err)); }
    });
  });
  if (rows.length) withLock_(() => { const sh = sheet_('Recipes'); sh.getRange(sh.getLastRow() + 1, 1, rows.length, KCFG.RECIPE_COLS.length).setValues(rows); });
  console.log('Saved ' + rows.length + ' recipes');
  log.forEach(l => console.log(l));
}

/* ───────────────────────────── setup (run once from the editor) ───────────────────────────── */

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SHEET_ID')) {
    const ss = SpreadsheetApp.create(KCFG.SHEET_NAME);
    const r = ss.getSheets()[0];
    r.setName('Recipes');
    r.appendRow(KCFG.RECIPE_COLS);
    r.setFrozenRows(1);
    props.setProperty('SHEET_ID', ss.getId());
  } else {
    // Add any new columns to an existing sheet.
    const sh = sheet_('Recipes');
    const head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
    KCFG.RECIPE_COLS.forEach(c => { if (head.indexOf(c) < 0) sh.getRange(1, sh.getLastColumn() + 1).setValue(c); });
  }
  if (!props.getProperty('KEYS')) {
    const keys = {};
    Object.keys(KCFG.PEOPLE).filter(p => KCFG.PEOPLE[p].role === 'parent').forEach(p => { keys[newKey_()] = p; });
    props.setProperty('KEYS', JSON.stringify(keys));
  }
  // Touch UrlFetch once so its permission is granted now.
  try { UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true }); } catch (e) {}
  showKeys();
}

function showKeys() {
  const props = PropertiesService.getScriptProperties();
  const keys = JSON.parse(props.getProperty('KEYS') || '{}');
  Object.keys(keys).forEach(k => console.log('APP ' + keys[k] + ': ?k=' + k));
  console.log('Sheet: https://docs.google.com/spreadsheets/d/' + props.getProperty('SHEET_ID'));
}

function resetKeyFor() {
  const person = 'CHANGE_ME'; // kevin | hillary
  if (!KCFG.PEOPLE[person]) throw new Error('Set person first');
  const props = PropertiesService.getScriptProperties();
  const m = JSON.parse(props.getProperty('KEYS') || '{}');
  Object.keys(m).forEach(k => { if (m[k] === person) delete m[k]; });
  m[newKey_()] = person;
  props.setProperty('KEYS', JSON.stringify(m));
  showKeys();
}

/* ───────────────────────────── helpers ───────────────────────────── */

function auth_(key) {
  const p = personForKey_(key);
  if (!p) throw new Error('This link is no longer valid. Ask Kevin for a new one.');
  if (KCFG.PEOPLE[p].role !== 'parent') throw new Error('Only Mom and Dad can change recipes.');
  return p;
}
function personForKey_(key) {
  if (!key || !/^[0-9a-f]{20,64}$/i.test(key)) return null;
  const m = JSON.parse(PropertiesService.getScriptProperties().getProperty('KEYS') || '{}');
  return m[key] || null;   // Kitchen's own keys only — no lookup against Madhouse
}
function newKey_() { return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8); }
function sheet_(name) {
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID')).getSheetByName(name);
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}
