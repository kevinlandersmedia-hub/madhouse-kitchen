/**
 * Madhouse Kitchen — calendar conflict checks (build step 5).
 * Reads the Family, Kevin, Hillary and Kevin's work calendars (read-only) and flags any timed event that overlaps
 * the dinner window (6:00–7:30 PM) on a planned night, with who's busy. The app never changes a dinner on its own:
 * the Week tab shows the conflict and the family picks what to do (quicker meal, move the night, leftovers,
 * eating out, or "it's fine", which hides that event for that night).
 * Kitchen only READS these calendars — it never writes to them.
 */

const DINNER_WINDOW = { start: '18:00', end: '19:30' };
const CONFLICT_CALS = [
  { key: 'family',  id: 'family09992373359778545799@group.calendar.google.com', who: '' },
  { key: 'kevin',   id: 'kevinlandersmedia@gmail.com',                         who: 'Kevin' },
  { key: 'hillary', id: 'hillary.landers@gmail.com',                           who: 'Hillary' },
  { key: 'work',    id: 'klanders@foundationoutdoorgroup.com',                 who: 'Kevin (work)' }
];
const QUICK_MEAL_MIN = 30;

// { window:{start,end,label}, nights:{ 'yyyy-MM-dd': [{id,title,who:[...],time,cal}] }, missing:[calendar names it couldn't read] }
function api_menuConflicts(key, weekStart) {
  auth_(key);
  const start = weekStartOf_(weekStart);
  const days = weekDates_(start);
  // Midnight-to-midnight in Eastern time, whatever the server clock says.
  const etFrom = etDate_(days[0], '00:00'), etTo = etDate_(days[6], '23:59');
  const raw = [], missing = [];
  CONFLICT_CALS.forEach(c => {
    let cal = null;
    try { cal = CalendarApp.getCalendarById(c.id); } catch (e) { cal = null; }
    if (!cal) { missing.push(c.key); return; }
    try {
      cal.getEvents(etFrom, etTo).forEach(ev => {
        if (ev.isAllDayEvent()) return;
        try { const s = ev.getMyStatus(); if (s === CalendarApp.GuestStatus.NO) return; } catch (e) {}
        raw.push({ cal: c, id: ev.getId(), title: ev.getTitle() || '(busy)', start: ev.getStartTime(), end: ev.getEndTime(), desc: ev.getDescription() || '' });
      });
    } catch (e) { missing.push(c.key); }
  });
  return { window: { start: DINNER_WINDOW.start, end: DINNER_WINDOW.end, label: '6:00–7:30 PM' }, nights: conflictsByNight_(raw, days), missing: missing };
}

// Pure-ish: events → per-night conflicts (dedupes the same event showing on several calendars).
function conflictsByNight_(events, days) {
  const out = {}, seen = {};
  days.forEach(d => {
    const ws = etDate_(d, DINNER_WINDOW.start).getTime(), we = etDate_(d, DINNER_WINDOW.end).getTime();
    events.forEach(e => {
      if (!(e.start.getTime() < we && e.end.getTime() > ws)) return;
      const dk = d + '|' + e.title.toLowerCase().trim() + '|' + e.start.getTime();
      const who = whoFor_(e.cal, e.title, e.desc);
      if (seen[dk]) { who.forEach(w => { if (seen[dk].who.indexOf(w) < 0) seen[dk].who.push(w); }); return; }
      const item = { id: String(e.id).replace(/@.*$/, '') + '@' + e.start.getTime(), title: e.title, who: who, cal: e.cal.key,
        time: fmtTime_(e.start) + '–' + fmtTime_(e.end) };
      seen[dk] = item;
      (out[d] = out[d] || []).push(item);
    });
  });
  return out;
}

function whoFor_(cal, title, desc) {
  if (cal.who) return [cal.who];
  const t = String(title || ''), found = [];
  ['Reese', 'Avery', 'Kevin', 'Hillary'].forEach(n => { if (new RegExp('\\b' + n + '\\b', 'i').test(t)) found.push(n); });
  if (found.length) return found;
  if (/\b(v-?ball|volleyball)\b/i.test(t)) return ['Avery'];
  if (/\b(b-?ball|basketball|chorus|choir)\b/i.test(t)) return ['Reese'];
  return ['Family'];
}

function fmtTime_(d) { return Utilities.formatDate(d, KCFG.TZ, 'h:mm a').replace(':00', '').replace(' ', '').toLowerCase(); }

// 'yyyy-MM-dd' + 'HH:mm' in America/New_York → Date
function etDate_(day, hm) {
  const guess = new Date(day + 'T' + hm + ':00Z');
  const off = Utilities.formatDate(guess, KCFG.TZ, 'Z');                     // e.g. -0400
  const m = off.match(/([+-])(\d\d)(\d\d)/);
  const mins = (m[1] === '-' ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3]));
  return new Date(guess.getTime() + mins * 60000);
}

// Run once from the editor so Google asks for calendar (read-only) permission.
function authorizeCalendars() {
  CONFLICT_CALS.forEach(c => console.log(c.key + ': ' + (CalendarApp.getCalendarById(c.id) ? 'OK' : 'not found / no access')));
}
