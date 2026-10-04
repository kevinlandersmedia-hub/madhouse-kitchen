/**
 * Madhouse Kitchen — weekly menu (build step 3).
 * Planner rules: only recipes under the 1-hour limit and not marked holiday, no repeats in a
 * week, nothing cooked in the last 3 weeks (relaxed if the library is small), and variety in
 * protein / cuisine / dish type from night to night. Nights can be kept (pinned) so a re-roll
 * never touches them. Cooked nights feed the "cooked vs never tried" history.
 * Data lives in the "Menus" tab of the Kitchen sheet (created automatically on first use).
 */

const MENU_COLS = ['date', 'recipe_id', 'status', 'pinned', 'note', 'updated_by', 'updated_at', 'sides', 'ok_events'];
const MEAL_BUFFER_MIN = 5;   // main + sides cook side by side; the meal takes the longest item plus a few minutes
const MENU_AVOID_DAYS = 21;

/* ───────────────────────────── client API ───────────────────────────── */

// Saved nights for one week (Mon–Sun starting at weekStart) + cook history for every recipe.
function api_menuState(key, weekStart) {
  auth_(key);
  ensureV2_();
  const start = weekStartOf_(weekStart);
  const days = weekDates_(start);
  const rows = readMenus_();
  return {
    weekStart: start,
    today: Utilities.formatDate(new Date(), KCFG.TZ, 'yyyy-MM-dd'),
    nights: rows.filter(r => days.indexOf(r.date) >= 0),
    history: cookHistory_(rows)
  };
}

// Build / fill / re-roll. Never saves — the client shows the result and saves it.
// spec: { plan:[{date,state,recipe_id,pinned,cooked}], variety:'auto'|'random', onlyEmpty:bool, onlyDate:'yyyy-MM-dd' }
function api_menuGenerate(key, spec) {
  auth_(key);
  spec = spec || {};
  const plan = normalizePlan_(spec.plan);
  const rows = readMenus_();
  const opts = {
    variety: spec.variety === 'random' ? 'random' : 'auto',
    onlyEmpty: !!spec.onlyEmpty,
    onlyDate: spec.onlyDate || null,
    maxMin: spec.quick ? QUICK_MEAL_MIN : KCFG.MAX_WEEKNIGHT_MIN,   // "Quicker meal" on a busy night
    pairs: pairMap_(readPairings_())
  };
  if (spec.sidesFor) {
    return { plan: fillSides_(listRecipes_(), cookHistory_(rows), plan, Object.assign(opts, { sidesFor: String(spec.sidesFor), slot: spec.slot == null ? -1 : Number(spec.slot) })), notes: [] };
  }
  return planWeek_(listRecipes_(), cookHistory_(rows), plan, opts);
}

// Replace everything saved for this week with the given nights.
function api_menuSave(key, weekStart, plan) {
  const me = auth_(key);
  const start = weekStartOf_(weekStart);
  const days = weekDates_(start);
  const clean = normalizePlan_(plan).filter(p => days.indexOf(p.date) >= 0);
  const now = new Date();
  withLock_(() => {
    const sh = menuSheet_();
    const keep = readMenus_().filter(r => days.indexOf(r.date) < 0);
    const mk = r => [r.date, r.recipe_id || '', r.status, !!r.pinned, r.note || '', r.updated_by || '', r.updated_at || '',
      Array.isArray(r.sides) ? JSON.stringify(r.sides) : '', Array.isArray(r.ok_events) && r.ok_events.length ? JSON.stringify(r.ok_events) : ''];
    const out = keep.map(mk).concat(clean.map(p => mk({
      date: p.date, recipe_id: p.state === 'out' ? '' : p.recipe_id,
      status: p.state === 'out' ? 'out' : (p.cooked && p.recipe_id ? 'cooked' : 'planned'),
      pinned: p.state === 'out' ? false : p.pinned, note: p.state === 'out' ? p.note : '', updated_by: me, updated_at: now,
      sides: p.state === 'out' || !p.recipe_id ? null : p.sides, ok_events: p.ok
    })));
    const last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, MENU_COLS.length).clearContent();
    if (out.length) sh.getRange(2, 1, out.length, MENU_COLS.length).setValues(out);
  });
  return { saved: true, history: cookHistory_(readMenus_()) };
}

/* ───────────────────────────── planner (pure JS — testable without Apps Script) ───────────────────────────── */

function isPlannable_(r, maxMin) {
  return !!r && !r.holiday && r.role !== 'Side' && r.total_min != null && r.total_min <= maxMin;
}
function isSideOk_(r, maxMin) {
  return !!r && r.role === 'Side' && !r.holiday && r.total_min != null && r.total_min <= maxMin;
}

function daysBetween_(a, b) {   // yyyy-MM-dd strings, b - a in days
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}

// plan: [{date,state:'planned'|'out',recipe_id,pinned,cooked}] — returns { plan, notes }
function planWeek_(recipes, hist, plan, opts) {
  opts = opts || {};
  const rng = opts.rng || Math.random;
  const maxMin = opts.maxMin || 60;
  const byId = {};
  recipes.forEach(r => { byId[r.id] = r; });
  const out = plan.map(p => Object.assign({}, p));
  const notes = [];

  const kept = p => p.pinned && p.recipe_id && byId[p.recipe_id];
  const needs = out.filter(p => p.state === 'planned' && !kept(p) &&
    (!opts.onlyEmpty || !p.recipe_id || !byId[p.recipe_id]) &&
    (!opts.onlyDate || p.date === opts.onlyDate));
  const before = {};
  needs.forEach(p => { before[p.date] = p.recipe_id; p.recipe_id = ''; p.cooked = false; p.sides = null; });

  const pool = recipes.filter(r => isPlannable_(r, maxMin));
  if (!pool.length) {
    notes.push('No recipes fit yet — the planner only uses recipes with a total time of 1 hour or less that aren\'t holiday meals.');
    return { plan: out, notes: notes };
  }

  const chosenIds = () => out.filter(p => p.state === 'planned' && p.recipe_id).map(p => p.recipe_id);
  let relaxedRecent = 0, repeated = 0, unfilled = 0;

  needs.forEach(p => {
    const idx = out.indexOf(p);
    const used = chosenIds();
    const tier = (needFresh, needUnused) => pool.filter(r => {
      if (opts.onlyDate && r.id === before[p.date]) return false;      // a swap must change the dinner
      if (needUnused && used.indexOf(r.id) >= 0) return false;
      if (needFresh) {
        const h = hist[r.id];
        if (h && h.last && Math.abs(daysBetween_(h.last, p.date)) < MENU_AVOID_DAYS) return false;
      }
      return true;
    });
    let cands = tier(true, true);
    if (!cands.length) { cands = tier(false, true); if (cands.length) relaxedRecent++; }
    if (!cands.length) { cands = tier(false, false); if (cands.length) repeated++; }
    if (!cands.length) { unfilled++; return; }

    let pick;
    if (opts.variety === 'random') {
      pick = cands[Math.floor(rng() * cands.length)];
    } else {
      const near = [out[idx - 1], out[idx + 1]].map(q => q && q.state === 'planned' && q.recipe_id ? byId[q.recipe_id] : null).filter(Boolean);
      const weekR = used.map(id => byId[id]).filter(Boolean);
      const count = (f, v) => weekR.filter(x => x[f] === v).length;
      let best = -1e9;
      cands.forEach(r => {
        let s = rng() * 2;
        near.forEach(n => {
          if (n.protein === r.protein) s -= 6;
          if (n.cuisine === r.cuisine) s -= 4;
          if (n.category === r.category) s -= 3;
        });
        s -= 2 * count('protein', r.protein) + 1.5 * count('cuisine', r.cuisine) + 1.5 * count('category', r.category);
        const h = hist[r.id];
        if (!h || !h.count) s += 3;                                   // never cooked → nudge it up
        else if (h.last) s += Math.min(2, Math.max(0, daysBetween_(h.last, p.date)) / 30);
        if (s > best) { best = s; pick = r; }
      });
    }
    p.recipe_id = pick.id;
  });

  if (relaxedRecent) notes.push('A few dinners were cooked in the last 3 weeks — there aren\'t enough fresh recipes yet to avoid that.');
  if (repeated) notes.push('The library is small, so ' + repeated + ' dinner' + (repeated === 1 ? ' repeats' : 's repeat') + ' one from this week. Adding recipes fixes that.');
  if (unfilled) notes.push(unfilled + ' night' + (unfilled === 1 ? '' : 's') + ' couldn\'t be filled.');
  // Mains get sides: freshly picked nights, plus any main that has never had sides chosen.
  fillSides_(recipes, hist, out, opts);
  if (!recipes.some(r => isSideOk_(r, maxMin)) && out.some(p => p.recipe_id && byId[p.recipe_id] && byId[p.recipe_id].role === 'Main'))
    notes.push('No side dishes under an hour yet — add some sides so mains come with a veggie and a starch.');
  return { plan: out, notes: notes };
}

/* ───────────────────────────── helpers ───────────────────────────── */

function normalizePlan_(plan) {
  return (Array.isArray(plan) ? plan : []).map(p => ({
    date: String((p && p.date) || '').slice(0, 10),
    state: p && p.state === 'out' ? 'out' : 'planned',
    recipe_id: String((p && p.recipe_id) || ''),
    pinned: !!(p && p.pinned),
    cooked: !!(p && p.cooked),
    sides: p && Array.isArray(p.sides) ? p.sides.map(String).filter(Boolean).slice(0, 4) : null,
    note: String((p && p.note) || '').slice(0, 40),                              // e.g. "Leftovers", "Eating out"
    ok: p && Array.isArray(p.ok) ? p.ok.map(String).slice(0, 20) : []             // calendar conflicts marked "it's fine"
  })).filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p.date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Monday of the week containing the given date (default: today), as yyyy-MM-dd.
function weekStartOf_(s) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
    ? new Date(s + 'T12:00:00Z')
    : new Date(Utilities.formatDate(new Date(), KCFG.TZ, 'yyyy-MM-dd') + 'T12:00:00Z');
  const dow = (base.getUTCDay() + 6) % 7;      // Monday = 0
  base.setUTCDate(base.getUTCDate() - dow);
  return base.toISOString().slice(0, 10);
}
function weekDates_(start) {
  const d = new Date(start + 'T12:00:00Z'), out = [];
  for (let i = 0; i < 7; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

function menuSheet_() {
  const ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  let sh = ss.getSheetByName('Menus');
  if (!sh) {
    sh = ss.insertSheet('Menus');
    sh.getRange(1, 1, 1, MENU_COLS.length).setValues([MENU_COLS]);
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
  } else if (sh.getLastColumn() < MENU_COLS.length) {
    sh.getRange(1, 1, 1, MENU_COLS.length).setValues([MENU_COLS]);
  }
  return sh;
}

function dateStr_(v) {
  return v instanceof Date ? Utilities.formatDate(v, KCFG.TZ, 'yyyy-MM-dd') : String(v || '').slice(0, 10);
}

function readMenus_() {
  const sh = menuSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, MENU_COLS.length).getValues()
    .filter(r => r[0])
    .map(r => ({
      date: dateStr_(r[0]), recipe_id: String(r[1] || ''), status: String(r[2] || 'planned'),
      pinned: r[3] === true, note: String(r[4] || ''), updated_by: r[5], updated_at: r[6] instanceof Date ? r[6].toISOString() : String(r[6] || ''),
      sides: (() => { try { const a = r[7] ? JSON.parse(r[7]) : null; return Array.isArray(a) ? a.map(String) : null; } catch (e) { return null; } })(),
      ok_events: (() => { try { const a = r[8] ? JSON.parse(r[8]) : []; return Array.isArray(a) ? a.map(String) : []; } catch (e) { return []; } })()
    }));
}

// { recipeId: { last:'yyyy-MM-dd', count:n } } from nights marked cooked.
function cookHistory_(rows) {
  const h = {};
  rows.forEach(r => {
    if (r.status !== 'cooked' || !r.recipe_id) return;
    [r.recipe_id].concat(r.sides || []).forEach(id => {
      const e = h[id] || (h[id] = { last: '', count: 0 });
      e.count++;
      if (!e.last || r.date > e.last) e.last = r.date;
    });
  });
  return h;
}

/* ═════════════════════════════ sides, pairings, review (build step 3b) ═════════════════════════════ */

const PAIR_COLS = ['main_id', 'side_id', 'status', 'by', 'at'];   // status: liked | approved | no
const SIDE_SLOTS = [
  { key: 'Veggie', fits: s => s.side_type === 'Veggie' || (s.side_type === 'Salad / bread' && /\b(salad|slaw)\b/i.test(s.name)) },
  { key: 'Starch', fits: s => s.side_type === 'Starch' || (s.side_type === 'Salad / bread' && !/\b(salad|slaw)\b/i.test(s.name)) }
];

function slotOf_(s) { return SIDE_SLOTS.findIndex(x => x.fits(s)); }

// Fill / re-pick sides on Main nights. opts.sidesFor = one date (opts.slot = which side, -1 = all).
function fillSides_(recipes, hist, plan, opts) {
  opts = opts || {};
  const rng = opts.rng || Math.random, maxMin = opts.maxMin || 60, pairs = opts.pairs || {};
  const byId = {}; recipes.forEach(r => { byId[r.id] = r; });
  const sides = recipes.filter(r => isSideOk_(r, maxMin));
  plan.forEach(p => {
    const main = p.state === 'planned' && p.recipe_id ? byId[p.recipe_id] : null;
    if (opts.sidesFor) {
      if (p.date !== opts.sidesFor) return;
      if (!main) { p.sides = null; return; }
    } else if (!main || main.role !== 'Main' || Array.isArray(p.sides)) return;
    const cur = (Array.isArray(p.sides) ? p.sides : []).filter(id => byId[id]);
    const usedWeek = {};
    plan.forEach(q => { if (q !== p) (q.sides || []).forEach(id => { usedWeek[id] = 1; }); });
    const slots = opts.sidesFor && opts.slot >= 0 ? [opts.slot] : [0, 1];
    let next = opts.sidesFor && opts.slot >= 0 ? cur.slice() : [];
    slots.forEach(si => {
      const slot = SIDE_SLOTS[si] ? si : -1;
      const old = next[si];
      const taken = next.filter((id, i) => i !== si);
      let cands = sides.filter(s => (slot < 0 || SIDE_SLOTS[slot].fits(s)) && taken.indexOf(s.id) < 0 && s.id !== old &&
        !(pairs[main.id] && pairs[main.id][s.id] === 'no'));
      // If this slot was a side outside the two standard slots (e.g. added by hand), swap within any side.
      if (opts.sidesFor && opts.slot >= 0 && old && byId[old] && slotOf_(byId[old]) !== si) cands = sides.filter(s => taken.indexOf(s.id) < 0 && s.id !== old);
      const fresh = cands.filter(s => !usedWeek[s.id]);
      if (fresh.length) cands = fresh;
      if (!cands.length) { if (old && opts.sidesFor) next[si] = old; return; }
      let best = -1e9, pick = null;
      cands.forEach(s => {
        let sc = rng() * 2.5;
        const pr = pairs[main.id] && pairs[main.id][s.id];
        if (pr === 'liked') sc += 6; else if (pr === 'approved') sc += 4;
        if (s.cuisine === main.cuisine) sc += 1;
        if (!hist[s.id]) sc += 0.5;
        if (sc > best) { best = sc; pick = s; }
      });
      next[si] = pick.id;
    });
    p.sides = next.filter(Boolean);
  });
  return plan;
}

// Whole-meal minutes: the longest item, plus a few minutes when sides are cooking alongside.
function mealMinutes_(main, sides) {
  const all = [main].concat(sides || []).filter(Boolean);
  if (all.some(x => x.total_min == null)) return null;
  const m = Math.max.apply(null, all.map(x => x.total_min));
  return (sides && sides.length ? m + MEAL_BUFFER_MIN : m);
}

/* ── pairings ── */

function pairSheet_() {
  const ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  let sh = ss.getSheetByName('Pairings');
  if (!sh) { sh = ss.insertSheet('Pairings'); sh.getRange(1, 1, 1, PAIR_COLS.length).setValues([PAIR_COLS]); sh.setFrozenRows(1); }
  return sh;
}
function readPairings_() {
  const sh = pairSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, PAIR_COLS.length).getValues().filter(r => r[0] && r[1])
    .map(r => ({ main_id: String(r[0]), side_id: String(r[1]), status: String(r[2] || 'approved') }));
}
function pairMap_(list) {
  const m = {};
  list.forEach(p => { (m[p.main_id] = m[p.main_id] || {})[p.side_id] = p.status; });
  return m;
}
function writePairs_(changes, me) {   // changes: [{main_id, side_id, status|''}]
  withLock_(() => {
    const sh = pairSheet_();
    const list = readPairings_();
    changes.forEach(c => {
      const i = list.findIndex(p => p.main_id === c.main_id && p.side_id === c.side_id);
      if (!c.status) { if (i >= 0) list.splice(i, 1); return; }
      if (i >= 0) list[i].status = c.status; else list.push({ main_id: c.main_id, side_id: c.side_id, status: c.status });
    });
    const last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, PAIR_COLS.length).clearContent();
    const now = new Date();
    if (list.length) sh.getRange(2, 1, list.length, PAIR_COLS.length).setValues(list.map(p => [p.main_id, p.side_id, p.status, me, now]));
  });
  return readPairings_();
}

function api_pairings(key) { auth_(key); return readPairings_(); }

// One pairing: status 'approved' | 'liked' | 'no' | '' (remove)
function api_setPairing(key, mainId, sideId, status) {
  const me = auth_(key);
  if (['approved', 'liked', 'no', ''].indexOf(status) < 0) throw new Error('Unknown pairing status');
  return writePairs_([{ main_id: String(mainId), side_id: String(sideId), status: status }], me);
}

// "Good combo" on a planned night: like (or un-like) every side with that main.
function api_likeCombo(key, mainId, sideIds, on) {
  const me = auth_(key);
  return writePairs_((sideIds || []).map(id => ({ main_id: String(mainId), side_id: String(id), status: on ? 'liked' : 'approved' })), me);
}

// Ranked side ideas for a main, per slot (skips ones already paired or turned down).
function api_suggestSides(key, mainId) {
  auth_(key);
  const recipes = listRecipes_(), main = recipes.find(r => r.id === mainId);
  if (!main) throw new Error('Recipe not found');
  const pm = pairMap_(readPairings_())[mainId] || {};
  const hist = cookHistory_(readMenus_());
  const sides = recipes.filter(r => r.role === 'Side' && !pm[r.id]);
  const out = {};
  SIDE_SLOTS.forEach(slot => {
    out[slot.key] = sides.filter(slot.fits).map(s => {
      let sc = 0; const why = [];
      if (s.cuisine === main.cuisine) { sc += 2; why.push('same cuisine'); }
      if (s.total_min != null && main.total_min != null && s.total_min <= main.total_min) { sc += 1; why.push('done in time'); }
      if (s.easy) why.push('easy'); else { sc += 0.6; why.push('a real recipe'); }
      if (hist[s.id]) { sc += 0.5; why.push('family has had it'); }
      if (s.total_min == null || s.total_min > KCFG.MAX_WEEKNIGHT_MIN) sc -= 3;
      return { id: s.id, score: sc, why: why.join(', ') };
    }).sort((a, b) => b.score - a.score).slice(0, 4);
  });
  return out;
}

/* ── review: confirm roles, fix tags/times ── */

// changes: any of { role, side_type, protein, total_min, holiday, reviewed }
function api_review(key, id, changes) {
  const me = auth_(key);
  changes = changes || {};
  let saved = null;
  withLock_(() => {
    const sh = sheet_('Recipes');
    const cols = colIndex_(sh);
    const rows = sh.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][cols.id] !== id) continue;
      const r = fromRow_(rows[i], cols);
      const lock = f => { if (r.locked.indexOf(f) < 0) r.locked.push(f); };
      if (changes.role && ROLE_OPTIONS.indexOf(changes.role) >= 0) { r.role = changes.role; lock('role'); }
      if (r.role === 'Side') {
        if (changes.side_type && SIDE_TYPES.indexOf(changes.side_type) >= 0) { r.side_type = changes.side_type; lock('side_type'); }
        if (!r.side_type) r.side_type = sideTypeFor_(r.name);
      } else r.side_type = '';
      if (changes.protein && TAG_OPTIONS.protein.indexOf(changes.protein) >= 0) { r.protein = changes.protein; lock('protein'); }
      if ('total_min' in changes) r.total_min = changes.total_min === '' || changes.total_min == null ? null : Math.max(0, Math.round(Number(changes.total_min))) || null;
      if ('holiday' in changes) r.holiday = !!changes.holiday;
      if (changes.reviewed) { r.reviewed = true; lock('role'); if (r.role === 'Side') lock('side_type'); }
      r.updated_by = me; r.updated_at = new Date();
      sh.getRange(i + 1, 1, 1, KCFG.RECIPE_COLS.length).setValues([KCFG.RECIPE_COLS.map((c, k) => toRow_(r)[k])]);
      saved = Object.assign({}, r, { updated_at: r.updated_at.toISOString(), created_at: String(r.created_at || '') });
      break;
    }
  });
  if (!saved) throw new Error('Recipe not found');
  return saved;
}

/* ── one-time upgrade: roles on every recipe + starter sides ── */

function ensureV2_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('KITCHEN_V2') === 'done') return;
  withLock_(() => {
    if (props.getProperty('KITCHEN_V2') === 'done') return;
    const sh = sheet_('Recipes');
    const cols = colIndex_(sh);                       // adds role / side_type / easy / reviewed columns
    const rng = sh.getDataRange(), rows = rng.getValues();
    const names = {};
    for (let i = 1; i < rows.length; i++) {
      if (!rows[i][cols.id]) continue;
      names[String(rows[i][cols.name]).toLowerCase()] = 1;
      if (rows[i][cols.role]) continue;
      const t = finishDraft(fromRow_(rows[i], cols));
      rows[i][cols.cuisine] = t.cuisine; rows[i][cols.protein] = t.protein; rows[i][cols.category] = t.category;
      rows[i][cols.auto_tags] = JSON.stringify(t.auto); rows[i][cols.role] = t.role; rows[i][cols.side_type] = t.side_type || '';
      if (rows[i][cols.easy] === '') rows[i][cols.easy] = false;
      if (rows[i][cols.reviewed] === '') rows[i][cols.reviewed] = false;
    }
    rng.setValues(rows);
    const now = new Date();
    const add = STARTER_SIDES_.filter(d => !names[d.name.toLowerCase()]).map(d => {
      const r = finishDraft(normalizeDraft_(Object.assign({ source: 'home' }, d)));
      r.locked = ['role'].concat(r.role === 'Side' ? ['side_type'] : []);
      r.role = d.role; r.side_type = d.side_type || ''; r.easy = !!d.easy; r.reviewed = true;
      r.id = Utilities.getUuid(); r.created_by = 'kevin'; r.created_at = now; r.updated_by = 'kevin'; r.updated_at = now;
      return toRow_(r);
    });
    if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, KCFG.RECIPE_COLS.length).setValues(add);
    pairSheet_();
    props.setProperty('KITCHEN_V2', 'done');
  });
}

// Kevin's own sides + panko tilapia (from his cooking notes) and no-recipe "easy sides".
const STARTER_SIDES_ = [
  { name: 'Garlic Zucchini and Onions', role: 'Side', side_type: 'Veggie', servings: 4, prep_min: 10, cook_min: 15, total_min: 25,
    ingredients: ['1 Vidalia onion, diced', 'Olive oil', 'Salt and pepper, to taste', '1-1 1/2 tsp Kerrygold butter', 'Pre-minced garlic (squeeze bottle), to taste', '4 zucchini, cut into half-moons'],
    steps: ['Heat a splash of olive oil in the All-Clad stainless pan. Add the diced onion with salt and pepper.',
      'Add the Kerrygold butter and sauté a few minutes until the onion softens.',
      'Clear a space in the pan and add the squeeze-bottle garlic.',
      'Add the zucchini half-moons and raise the heat to about 4 (dial runs low–9–high).',
      'Cook uncovered about 8 minutes, splashing in olive oil as needed so it doesn\'t dry out. Salt and pepper to taste.'],
    notes: 'Kevin\'s recipe — turned out great.' },
  { name: 'Pearl Couscous with Chicken Broth', role: 'Side', side_type: 'Starch', servings: 4, prep_min: 2, cook_min: 13, total_min: 15,
    ingredients: ['Rice Select pearl couscous (package amount for 1 1/2 cups liquid)', '1 cup chicken broth', '1/2 cup water'],
    steps: ['Cook the couscous following the Rice Select package directions, but swap the package\'s 1 1/2 cups water for 1 cup chicken broth + 1/2 cup water.'],
    notes: 'Kevin\'s tweak — the broth adds a lot more flavor.' },
  { name: 'Panko Tilapia', role: 'Main', servings: 4, prep_min: 10, cook_min: 9, total_min: 20, oven: '425°F',
    ingredients: ['4 tilapia fillets, patted dry', 'Mayonnaise', 'Salt and pepper', 'Publix panko breadcrumbs', 'Italian seasoning', 'Olive oil sizzle spray (green bottle, yellow label)'],
    steps: ['Heat the oven to 425°F on convection.', 'Pat the tilapia dry, then coat each fillet with mayonnaise, salt and pepper.',
      'Mix the panko with Italian seasoning and a few sprays of the olive oil sizzle spray.', 'Press the panko mix onto the tops of the fillets.',
      'Bake at 425°F convection about 8–9 minutes.'],
    notes: 'Came out perfect — keep this version as is.' },
  // Easy sides — no real recipe, but they still land on the grocery list.
  { name: 'Steamed White Rice', role: 'Side', side_type: 'Starch', easy: true, servings: 4, total_min: 20, ingredients: ['1 1/2 cups long grain white rice', '3 cups water', 'Salt'], steps: ['Bring the water and a pinch of salt to a boil, stir in the rice, cover and simmer on low 18 minutes. Rest 5 minutes and fluff.'] },
  { name: 'Instant Mashed Potatoes', role: 'Side', side_type: 'Starch', easy: true, servings: 4, total_min: 10, ingredients: ['1 pouch instant mashed potatoes'], steps: ['Make following the package directions.'] },
  { name: 'Dinner Rolls', role: 'Side', side_type: 'Salad / bread', easy: true, servings: 6, total_min: 10, ingredients: ['1 package dinner rolls'], steps: ['Warm in the oven for a few minutes.'] },
  { name: 'Garlic Bread', role: 'Side', side_type: 'Salad / bread', easy: true, servings: 6, total_min: 15, ingredients: ['1 loaf frozen garlic bread'], steps: ['Bake following the package directions.'] },
  { name: 'Bagged Salad Kit', role: 'Side', side_type: 'Salad / bread', easy: true, servings: 4, total_min: 5, ingredients: ['1 bag salad kit'], steps: ['Toss with the dressing and toppings in the bag.'] },
  { name: 'Buttered Green Beans', role: 'Side', side_type: 'Veggie', easy: true, servings: 4, total_min: 10, ingredients: ['1 bag frozen green beans', '1 tbsp butter', 'Salt and pepper'], steps: ['Steam or microwave the green beans, then toss with butter, salt and pepper.'] },
  { name: 'Steamed Broccoli', role: 'Side', side_type: 'Veggie', easy: true, servings: 4, total_min: 8, ingredients: ['1 bag steam-in-bag broccoli'], steps: ['Microwave following the bag directions; season to taste.'] },
  { name: 'Buttered Corn', role: 'Side', side_type: 'Veggie', easy: true, servings: 4, total_min: 10, ingredients: ['1 bag frozen sweet corn', '1 tbsp butter', 'Salt'], steps: ['Heat the corn, then stir in butter and salt.'] }
];

/* ── one-time staples import (run from the editor: runStapleImport) ── */
// 20 mains + 40 sides Kevin approved on 2026-10-03. Skips links already in the library.
const STAPLES_ = [
  ['Main', '', 'https://www.recipetineats.com/honey-garlic-chicken/'],
  ['Main', '', 'https://www.recipetineats.com/garlic-chicken-thighs-recipe/'],
  ['Main', '', 'https://www.recipetineats.com/honey-mustard-chicken/'],
  ['Main', '', 'https://www.recipetineats.com/chicken-marsala/'],
  ['Main', '', 'https://www.recipetineats.com/parmesan-crusted-chicken-breast/'],
  ['Main', '', 'https://www.recipetineats.com/oven-baked-chicken-breast/'],
  ['Main', '', 'https://www.budgetbytes.com/chicken-tenders/'],
  ['Main', '', 'https://www.recipetineats.com/salisbury-steak-with-mushroom-gravy/'],
  ['Main', '', 'https://damndelicious.net/2014/08/13/easy-beef-broccoli/'],
  ['Main', '', 'https://damndelicious.net/2016/06/23/perfect-steak-wtih-garlic-butter/'],
  ['Main', '', 'https://damndelicious.net/2013/07/07/korean-beef-bowl/'],
  ['Main', '', 'https://www.recipetineats.com/balsamic-pork-chops/'],
  ['Main', '', 'https://www.recipetineats.com/pork-tenderloin-with-honey-garlic-sauce/'],
  ['Main', '', 'https://www.budgetbytes.com/glazed-pork-chops/'],
  ['Main', '', 'https://www.recipetineats.com/french-pork-schnitzel-recipe/'],
  ['Main', '', 'https://damndelicious.net/2014/08/18/honey-glazed-salmon/'],
  ['Main', '', 'https://damndelicious.net/2014/04/11/garlic-butter-shrimp/'],
  ['Main', '', 'https://www.budgetbytes.com/garlic-butter-baked-cod/'],
  ['Main', '', 'https://www.budgetbytes.com/turkey-meatballs/'],
  ['Main', '', 'https://www.budgetbytes.com/turkey-taco-skillet/'],
  ['Side', 'Veggie', 'https://damndelicious.net/2014/09/19/garlic-parmesan-roasted-broccoli/'],
  ['Side', 'Veggie', 'https://www.recipetineats.com/garlic-sauteed-green-beans/'],
  ['Side', 'Veggie', 'https://damndelicious.net/2023/03/03/glazed-carrots/'],
  ['Side', 'Veggie', 'https://www.budgetbytes.com/easy-roasted-brussels-sprouts/'],
  ['Side', 'Veggie', 'https://damndelicious.net/2016/05/04/roasted-parmesan-asparagus/'],
  ['Side', 'Veggie', 'https://www.budgetbytes.com/roasted-cauliflower/'],
  ['Side', 'Veggie', 'https://damndelicious.net/2021/03/18/garlic-butter-mushrooms-and-cauliflower/'],
  ['Side', 'Veggie', 'https://damndelicious.net/2014/11/12/easy-creamed-corn/'],
  ['Side', 'Veggie', 'https://www.budgetbytes.com/street-corn-salad/'],
  ['Side', 'Veggie', 'https://www.recipetineats.com/garlic-sauteed-spinach/'],
  ['Side', 'Veggie', 'https://www.budgetbytes.com/fried-cabbage/'],
  ['Side', 'Veggie', 'https://damndelicious.net/2014/10/04/roasted-vegetables/'],
  ['Side', 'Veggie', 'https://www.budgetbytes.com/creamed-peas/'],
  ['Side', 'Veggie', 'https://www.recipetineats.com/baked-zucchini/'],
  ['Side', 'Veggie', 'https://www.budgetbytes.com/roasted-butternut-squash/'],
  ['Side', 'Veggie', 'https://www.recipetineats.com/vegetable-stir-fry/'],
  ['Side', 'Salad / bread', 'https://www.recipetineats.com/chicken-caesar-salad/', 'Caesar Salad'],
  ['Side', 'Salad / bread', 'https://www.recipetineats.com/coleslaw/'],
  ['Side', 'Salad / bread', 'https://www.recipetineats.com/cucumber-salad-with-herb-garlic-vinaigrette/'],
  ['Side', 'Salad / bread', 'https://www.recipetineats.com/garden-salad/'],
  ['Side', 'Starch', 'https://damndelicious.net/2014/07/23/garlic-parmesan-roasted-potatoes/'],
  ['Side', 'Starch', 'https://www.budgetbytes.com/fluffy-garlic-herb-mashed-potatoes/'],
  ['Side', 'Starch', 'https://www.budgetbytes.com/skillet-breakfast-potatoes/'],
  ['Side', 'Starch', 'https://www.budgetbytes.com/roasted-sweet-potatoes/'],
  ['Side', 'Starch', 'https://www.budgetbytes.com/southern-style-potato-salad/'],
  ['Side', 'Starch', 'https://damndelicious.net/2014/03/12/mexican-rice/'],
  ['Side', 'Starch', 'https://www.budgetbytes.com/cilantro-lime-rice/'],
  ['Side', 'Starch', 'https://www.recipetineats.com/garlic-rice/'],
  ['Side', 'Starch', 'https://www.budgetbytes.com/mushroom-rice/'],
  ['Side', 'Starch', 'https://www.recipetineats.com/hot-buttered-corn-rice/'],
  ['Side', 'Starch', 'https://www.recipetineats.com/rice-pilaf/'],
  ['Side', 'Starch', 'https://www.budgetbytes.com/vegetable-fried-rice/'],
  ['Side', 'Starch', 'https://damndelicious.net/2014/02/10/parmesan-spinach-orzo/'],
  ['Side', 'Starch', 'https://www.recipetineats.com/couscous/'],
  ['Side', 'Starch', 'https://damndelicious.net/2014/05/02/garlic-mushroom-quinoa/'],
  ['Side', 'Starch', 'https://www.budgetbytes.com/garlic-noodles/'],
  ['Side', 'Salad / bread', 'https://www.budgetbytes.com/everyday-cornbread/'],
  ['Side', 'Salad / bread', 'https://www.recipetineats.com/garlic-bread/'],
  ['Side', 'Salad / bread', 'https://www.budgetbytes.com/cheddar-drop-biscuits/'],
  ['Side', 'Salad / bread', 'https://damndelicious.net/2014/04/14/easy-garlic-parmesan-knots/'],
  // 2026-10-03 round 2: 20 popular-site mains
  ['Main', '', 'https://natashaskitchen.com/chicken-piccata-recipe/'],
  ['Main', '', 'https://www.onceuponachef.com/recipes/cashew-chicken.html'],
  ['Main', '', 'https://www.spendwithpennies.com/bruschetta-baked-chicken/'],
  ['Main', '', 'https://www.cookingclassy.com/teriyaki-chicken/'],
  ['Main', '', 'https://tastesbetterfromscratch.com/simple-chicken-parmesan/'],
  ['Main', '', 'https://www.gimmesomeoven.com/grilled-chicken-kabobs/'],
  ['Main', '', 'https://www.spendwithpennies.com/4-ingredient-salsa-chicken/'],
  ['Main', '', 'https://natashaskitchen.com/mongolian-beef/'],
  ['Main', '', 'https://www.dinneratthezoo.com/pepper-steak-stir-fry/'],
  ['Main', '', 'https://natashaskitchen.com/beef-stroganoff/'],
  ['Main', '', 'https://www.wellplated.com/ground-beef-stir-fry/'],
  ['Main', '', 'https://tastesbetterfromscratch.com/pork-chops-with-creamy-mustard-sauce/'],
  ['Main', '', 'https://therecipecritic.com/hawaiian-pork-chops/'],
  ['Main', '', 'https://www.spendwithpennies.com/sausage-and-peppers/'],
  ['Main', '', 'https://www.spendwithpennies.com/pan-seared-pork-chops/'],
  ['Main', '', 'https://natashaskitchen.com/baked-salmon-with-garlic-and-dijon/'],
  ['Main', '', 'https://www.dinneratthezoo.com/shrimp-stir-fry/'],
  ['Main', '', 'https://natashaskitchen.com/salmon-patties/'],
  ['Main', '', 'https://www.wellplated.com/egg-roll-in-a-bowl/'],
  ['Main', '', 'https://ifoodreal.com/turkey-zucchini/']
];

function runStapleImport() {
  ensureV2_();
  const norm = u => String(u || '').replace(/[?#].*$/, '').replace(/\/$/, '');
  const have = {};
  listRecipes_().forEach(r => { if (r.url) have[norm(r.url)] = 1; });
  const todo = STAPLES_.filter(s => !have[norm(s[2])]);
  const hdr = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' };
  const rows = [], log = [], fails = [], now = new Date();
  for (let i = 0; i < todo.length; i += 10) {
    const batch = todo.slice(i, i + 10);
    const res = UrlFetchApp.fetchAll(batch.map(s => ({ url: s[2], muteHttpExceptions: true, followRedirects: true, headers: hdr })));
    res.forEach((x, k) => {
      const [role, sideType, url, nameOverride] = batch[k];
      try {
        if (x.getResponseCode() >= 400) throw new Error('site said ' + x.getResponseCode());
        const html = x.getContentText();
        const d = recipeFromHtml(html, url);
        if (!d) throw new Error('no recipe found');
        if (!d.image) d.image = ogImage_(html, url);
        d.ingredients = (d.ingredients || []).map(g => cleanIngr_(typeof g === 'string' ? g : (g.raw || ''))).filter(Boolean);
        if (nameOverride) d.name = nameOverride;
        d.source = 'url'; d.url = url;
        d.role = role; d.side_type = sideType; d.locked = ['role'].concat(role === 'Side' ? ['side_type'] : []);
        const r = finishDraft(normalizeDraft_(d));
        r.reviewed = true;
        if (!r.name || !r.ingredients.length) throw new Error('missing name or ingredients');
        r.id = Utilities.getUuid(); r.created_by = 'kevin'; r.created_at = now; r.updated_by = 'kevin'; r.updated_at = now;
        rows.push(toRow_(r)); have[norm(url)] = 1;
        log.push('OK ' + r.role + (r.side_type ? '/' + r.side_type : '') + ' | ' + r.name + ' | ' + (r.total_min == null ? '?' : r.total_min) + ' min' + (r.image ? '' : ' | NO PHOTO'));
      } catch (err) { fails.push(url); log.push('FAIL ' + url + ' — ' + (err.message || err)); }
    });
  }
  if (rows.length) withLock_(() => { const sh = sheet_('Recipes'); colIndex_(sh); sh.getRange(sh.getLastRow() + 1, 1, rows.length, KCFG.RECIPE_COLS.length).setValues(rows); });
  console.log('Saved ' + rows.length + ' of ' + todo.length + ' (' + (STAPLES_.length - todo.length) + ' already in library). Failed: ' + fails.length);
  log.forEach(l => console.log(l));
}
