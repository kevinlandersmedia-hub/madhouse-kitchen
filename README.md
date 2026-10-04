# Madhouse Kitchen

Dinner planning app for the Landers family. **A standalone build, kept separate from Madhouse (MDHSE) on purpose.**
It has its own Apps Script project, its own Google Sheet, its own personal keys, its own GitHub repo and its own
folder on the home PC. It does not call Madhouse and Madhouse does not call it. Joining them later is a planned,
separate step (see "Future connector").

- GitHub repo: `kevinlandersmedia-hub/madhouse-kitchen`
- Home PC folder: `Documents\MadhouseKitchen`
- Link: `https://kevinlandersmedia-hub.github.io/madhouse-kitchen/?k=<Kitchen key>`

## What's in here
| Path | What it is |
|---|---|
| `index.html` | Home-screen wrapper, served by GitHub Pages. Loads the Apps Script app full-screen with an icon. |
| `apps-script/Code.gs` | Server code: recipe storage, link import, text parser, auto-tagging, keys. |
| `apps-script/Menu.gs` | Weekly menu planner, sides pairing, pairings, role review, one-time v2 upgrade, one-time staples import. |
| `apps-script/Conflicts.gs` | Calendar conflict checks: reads Family, Kevin, Hillary and work calendars (read-only) for 6:00–7:30 PM. |
| `apps-script/Grocery.gs` | Grocery list: merges the week's ingredients, store sections, check-offs, added and every-week items. |
| `apps-script/Index.html` | The app's screens. |
| `apps-script/appsscript.json` | Apps Script manifest. |

## Status
- Steps 1–2 built (2026-09-27): recipe library + automatic tagging.
- 2026-09-29: split out from Madhouse. Removed the Madhouse key lookup (Kitchen now accepts only its own keys),
  moved from `/family/kitchen/` in the Madhouse repo to this repo, and moved the files out of `FamilyCommandCenter`.
- 2026-10-01: step 3 weekly menu planner (Week tab) deployed.
- 2026-10-03 (version 8): meal roles + sides. Every recipe is a Complete meal, a Main (needs sides) or a Side
  (Veggie / Starch / Salad & bread). Auto-sorted by rules, confirmed on the "Review roles" screen. Added Kevin's
  sides (garlic zucchini & onions, pearl couscous with broth), panko tilapia, and 8 no-recipe "easy sides".
  Week planner gives each Main one veggie + one starch (swap / pick / remove / add), "Good combo" saves the
  pairing, and the whole-meal time = longest item + 5 min. New Protein options: Lamb, Game. New sheet tab: Pairings.
- 2026-10-03 (version 9): step 4 grocery list (Groceries tab). Built from the week's saved menu (mains + sides);
  the same ingredient across dinners is merged with amounts added up; sorted by store section (Produce, Bakery,
  Meat & Seafood, Dairy & Eggs, Pantry, Sauces/Oils, Spices, Baking, Frozen, Other); staples always included.
  Check off in the app (saved, so Hillary sees the same list), free-add items, every-week items, take an item
  off for one week, move an item to another section (remembered), leave a whole dish or one part of a recipe
  (e.g. a from-scratch bread) off the list, Share / Copy as text. Opens next week's list on Sat/Sun.
  New sheet tabs: Grocery (one row per week), Weekly items. Section moves live in script property GROCERY_SECTIONS.
- 2026-10-03 (version 10): step 5 calendar conflict checks. Week tab flags any timed event between 6:00 and 7:30 PM on
  the Family, Kevin, Hillary or Kevin's work calendar (read-only; app never edits calendars or changes dinners on its own),
  shows who's busy, and offers Quicker meal (30 min or less), Move to another night, Leftovers, Eating out, or It's fine
  (hides that event for that night). New Menus column ok_events; out nights can carry a note (Leftovers / Eating out).
  Needs the calendar.readonly scope (Kevin authorized it 2026-10-03 via authorizeCalendars).
- Next: step 6, phone app. (Instacart ordering is step 7 and still parked.)

## What it does
- **Add a recipe three ways:** paste the whole recipe text, import it from a link (reads the recipe data most big
  sites embed), or write your own in plain language. Every new recipe opens in a review screen before it's saved.
- **Auto-tagging:** cuisine, protein and dish type come from keyword rules (no AI/API). The "i" button shows why.
  Hand-picked tags override the rules and are kept when the rules are re-run.
- **1-hour rule:** recipes over 60 min total (or with no time) are flagged "Needs attention" and skipped by the weekly
  planner. "Holiday / big-occasion meal" keeps a recipe out of weekly planning entirely.
- **Scaling:** −/+ servings scales the amounts on screen (the saved recipe isn't changed).
- **Edit everything:** ingredients, steps, spices, times, oven temp, servings, notes.

## Who can open it
Kevin and Hillary (admin), each with their own Kitchen key. Run `showKeys` in the Apps Script editor to see them.
Lost or leaked link: set the person in `resetKeyFor`, Run, and send the new link.
Kids' "Dinner Suggestions" comes later (build step 8) with their own Kitchen keys.

## Data
Sheet "Madhouse Kitchen – Data" in Kevin's Drive, tabs **Recipes**, **Menus** (one row per night, sides as JSON), **Pairings** (main, side, liked/approved/no), **Grocery** (one row per week: check-offs, removed and added items as JSON) and **Weekly items** (one item per row).
Recipes tab One row per recipe; ingredients and steps are
stored as JSON. Deleting in the app only marks the row deleted.

## Updating the code
Edit in the Apps Script editor → Save → Deploy → Manage deployments → pencil → Version: New version → Deploy.
Keep this repo in sync with what's deployed.

## Build plan
1. Recipe input ✅  2. Auto-tagging ✅  3. Weekly menu generator ✅ (+ mains & sides) 4. Grocery list ✅  5. Calendar conflict checks ✅
6. Phone app  7. Ordering (Publix / Walmart / Instacart)  8. Kids' suggestion list

## Future connector (not built — do not add without Kevin's go-ahead)
When Kevin decides to join the two, the plan is a small read-only JSON endpoint on Kitchen
(e.g. this week's menu and the grocery list) that Madhouse can show. Until then, no shared keys, no shared
data and no links between the two apps.
