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
| `apps-script/Index.html` | The app's screens. |
| `apps-script/appsscript.json` | Apps Script manifest. |

## Status
- Steps 1–2 built (2026-09-27): recipe library + automatic tagging.
- 2026-09-29: split out from Madhouse. Removed the Madhouse key lookup (Kitchen now accepts only its own keys),
  moved from `/family/kitchen/` in the Madhouse repo to this repo, and moved the files out of `FamilyCommandCenter`.
- Next: step 3, weekly menu generator (Mon–Fri, uses tags for variety, skips recipes over 60 min).

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
Sheet "Madhouse Kitchen – Data" in Kevin's Drive, tab **Recipes**. One row per recipe; ingredients and steps are
stored as JSON. Deleting in the app only marks the row deleted.

## Updating the code
Edit in the Apps Script editor → Save → Deploy → Manage deployments → pencil → Version: New version → Deploy.
Keep this repo in sync with what's deployed.

## Build plan
1. Recipe input ✅  2. Auto-tagging ✅  3. Weekly menu generator  4. Grocery list  5. Calendar conflict checks
6. Phone app  7. Ordering (Publix / Walmart / Instacart)  8. Kids' suggestion list

## Future connector (not built — do not add without Kevin's go-ahead)
When Kevin decides to join the two, the plan is a small read-only JSON endpoint on Kitchen
(e.g. this week's menu and the grocery list) that Madhouse can show. Until then, no shared keys, no shared
data and no links between the two apps.
