# Fideo Global — Company Dashboard

One place for build progress, projects, the sales pipeline and company updates.
Everything on screen comes from the tracker spreadsheets — nobody retypes anything.

## What's in it

| Tab | What it shows |
|---|---|
| **Overview** | Headline numbers, pipeline funnel, what needs attention, what's coming up |
| **Sales pipeline** | Every deal — stage, priority, target go-live, annual revenue, next action |
| **Deal plans** | The five milestones each deal has to clear, per client |
| **Course builds** | Where each programme sits in the ten-stage build, with owners and blockers |
| **Projects** | Pre-pipeline opportunities, their lead and their next step |
| **Updates** | Written notes, plus an automatic entry each time new data is imported |
| **Update data** | Drop a new spreadsheet in and publish the new numbers |

## Shared data

The dashboard state lives in one row of a Supabase table (, in the
Model Room project, kept apart by the  prefix). Everyone reads the same
copy from wherever they are.

- **Reading** is open to anyone with the link, signed in or not.
- **Editing** needs an account whose email is on the  table. The
  database enforces that, not the page: an anonymous write is refused by
  row-level security.
- If the database cannot be reached the app falls back to the copy bundled in
   and says so on screen. Anything edited then stays on that
  device until it can be shared.

To add an editor, insert their email into .

## Updating the numbers (the normal way — no command line)

1. Open the dashboard and go to **Update data**.
2. Drag the new tracker spreadsheet onto the box. Both trackers can go in at once.
3. Read the list of changes it found — "Deal moved: Solance — 4 Contracting → 5 Contracted", and so on.
4. Click **Apply and preview**. The whole dashboard now shows the new numbers *on your machine only*.
5. Click **Download data file** and save it over `data/dashboard.js`.
6. Commit and push that one file. Vercel redeploys in about a minute and everyone sees it.

Until step 6, a yellow "Local preview — not published" badge sits in the top right,
so nobody mistakes a preview for the real thing.

## Updating the numbers (command line)

Put the latest spreadsheets in `source-files/` and run:

```bash
node tools/seed.js
```

That rewrites `data/dashboard.js` from scratch, keeping any written updates. Commit and push.

## Which spreadsheet sheets are read

| Sheet name | Feeds |
|---|---|
| `Course Build Tracker` | Course builds |
| `Projects` | Projects |
| `Pipeline Tracker` | Sales pipeline |
| `Deal Stage Plans` | Deal plans |
| `Funnel Summary` | Cross-check on the revenue total only |

Sheets are found by name and columns by their headings, so re-ordering columns or
adding rows is fine. Renaming a sheet entirely is not — that section will simply stop
updating, and the **Update data** tab will tell you which sections it recognised.

## Files

```
index.html            the page itself
assets/app.css        all styling — Fideo brand colours live at the top
assets/app.js         every view, plus the importer
assets/parse.js       spreadsheet → dashboard data (shared by browser and command line)
assets/vendor/        SheetJS, the .xlsx reader (bundled, no internet needed)
data/dashboard.js     THE DATA. This is the only file that changes on a normal update
tools/seed.js         command-line rebuild of data/dashboard.js
source-files/         the spreadsheets the current data came from
```

## Hosting

Static site — no build step, no server, no database. Deploy the folder to Vercel and
point it at the repository; every push to `main` goes live within a minute.

## Brand

From the Fideo brand kit: Chrysler Blue `#560BAD`, Amber `#F9C300`, Ghost White `#F8F4F8`,
Deep Charcoal `#221E1B`, Graphite Grey `#949697`. The logo typeface is MADE Tommy;
the dashboard falls back to Poppins / Century Gothic, which are close and available everywhere.
