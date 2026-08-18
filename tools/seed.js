/* Regenerate data/dashboard.js from the tracker spreadsheets.
   Usage:  node tools/seed.js  [file1.xlsx file2.xlsx ...]
   With no arguments it reads every .xlsx in source-files/.
   The browser importer (Update data tab) does exactly the same thing —
   this script is here for a quick refresh from the command line. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const XLSX = require(path.join(root, 'assets', 'vendor', 'xlsx.full.min.js'));
const FideoParse = require(path.join(root, 'assets', 'parse.js'));

const args = process.argv.slice(2);
const files = args.length
  ? args
  : fs.readdirSync(path.join(root, 'source-files'))
      .filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'))
      .map((f) => path.join(root, 'source-files', f));

if (!files.length) {
  console.error('No .xlsx files found. Put the trackers in source-files/ or pass paths as arguments.');
  process.exit(1);
}

const outPath = path.join(root, 'data', 'dashboard.js');
let data = FideoParse.emptyDataset();
if (fs.existsSync(outPath)) {
  try {
    // data/dashboard.js is `window.FIDEO_DATA = {...};` — pull the object back out
    // so hand-written updates survive a re-import.
    const text = fs.readFileSync(outPath, 'utf8');
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const existing = JSON.parse(json);
    data = existing;
    data.updates = existing.updates || [];
  } catch (err) {
    console.warn('Existing dashboard.js unreadable, starting fresh:', err.message);
  }
}

const stamp = new Date().toISOString();
for (const file of files) {
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellDates: false });
  const res = FideoParse.applyWorkbook(XLSX, wb, path.basename(file), data, stamp);
  if (res.error) {
    console.warn(`- ${path.basename(file)}: ${res.error}`);
    continue;
  }
  data = res.data;
  console.log(`- ${path.basename(file)}: ${res.applied.join(', ')}`);
}

const banner = `/* Fideo Global dashboard data — generated ${stamp}\n` +
  `   Regenerate by uploading a tracker on the "Update data" tab, or run: node tools/seed.js */\n`;
fs.writeFileSync(outPath, banner + 'window.FIDEO_DATA = ' + JSON.stringify(data, null, 2) + ';\n', 'utf8');
console.log(`\nWrote ${path.relative(root, outPath)} (${(fs.statSync(outPath).size / 1024).toFixed(1)} kB)`);
