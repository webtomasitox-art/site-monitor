// ===================================================================
//  מנטר שינויים ויזואליים באתר — גרסת ענן (GitHub Actions)
//  רץ אוטומטית, מצלם את האתר, משווה, ושומר תוצאות לדשבורד.
// ===================================================================

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

// ============ כאן אתה מגדיר מה לנטר — שנה רק את החלק הזה ============

const SITES = [
  { name: 'homepage', url: 'https://www.highlife-glamour.co.il' },
  // אפשר להוסיף עוד עמודים, כל אחד בשורה משלו, למשל:
  // { name: 'pricing', url: 'https://www.highlife-glamour.co.il/pricing' },
];

const THRESHOLD = 0.1;          // רגישות צבע (0-1). נמוך = רגיש יותר.
const MIN_CHANGED_PIXELS = 50;  // כמה פיקסלים צריכים לזוז כדי שייחשב שינוי.
const VIEWPORT = { width: 1280, height: 800 };
const PAGE_SETTLE_MS = 4000;    // המתנה אחרי טעינה לפני צילום.
const MAX_HISTORY = 30;         // כמה שינויים אחרונים לשמור בדשבורד.

// =================================================================
// מכאן והלאה — אין צורך לשנות כלום.
// =================================================================

const BASELINE_DIR = path.join(__dirname, 'baseline');
const DOCS_DIR = path.join(__dirname, 'docs');
const RESULTS_DIR = path.join(DOCS_DIR, 'results');
const DATA_FILE = path.join(DOCS_DIR, 'data.json');

function padTo(png, width, height) {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255; out.data[i + 1] = 255; out.data[i + 2] = 255; out.data[i + 3] = 255;
  }
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

function findChangedBounds(diff) {
  let minX = diff.width, minY = diff.height, maxX = -1, maxY = -1;
  for (let y = 0; y < diff.height; y++) {
    for (let x = 0; x < diff.width; x++) {
      const i = (y * diff.width + x) * 4;
      const r = diff.data[i], g = diff.data[i + 1], b = diff.data[i + 2];
      if (r > 200 && g < 120 && b < 120) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

function drawBox(png, bounds, pad, thickness) {
  const x0 = Math.max(0, bounds.minX - pad);
  const y0 = Math.max(0, bounds.minY - pad);
  const x1 = Math.min(png.width - 1, bounds.maxX + pad);
  const y1 = Math.min(png.height - 1, bounds.maxY + pad);
  const setPx = (x, y) => {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
    const i = (y * png.width + x) * 4;
    png.data[i] = 255; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = 255;
  };
  for (let t = 0; t < thickness; t++) {
    for (let x = x0; x <= x1; x++) { setPx(x, y0 + t); setPx(x, y1 - t); }
    for (let y = y0; y <= y1; y++) { setPx(x0 + t, y); setPx(x1 - t, y); }
  }
}

// קורא את היסטוריית השינויים הקיימת (אם יש).
function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

// שומר את ההיסטוריה, מוחק תיקיות ישנות שמעבר למגבלה.
function writeHistory(history) {
  const kept = history.slice(0, MAX_HISTORY);
  const removed = history.slice(MAX_HISTORY);
  for (const item of removed) {
    const dir = path.join(DOCS_DIR, item.folder);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(kept, null, 2));
}

async function run() {
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });

  let history = readHistory();
  let changesFound = 0;
  const checkedAt = new Date().toISOString();

  for (const site of SITES) {
    console.log(`\nבודק את "${site.name}"  (${site.url}) ...`);
    try {
      await page.goto(site.url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(PAGE_SETTLE_MS);
      const currentBuf = await page.screenshot({ fullPage: true });
      const baselinePath = path.join(BASELINE_DIR, `${site.name}.png`);

      if (fs.existsSync(baselinePath)) {
        const beforePng = PNG.sync.read(fs.readFileSync(baselinePath));
        const afterPng = PNG.sync.read(currentBuf);
        const width = Math.max(beforePng.width, afterPng.width);
        const height = Math.max(beforePng.height, afterPng.height);
        const a = padTo(beforePng, width, height);
        const b = padTo(afterPng, width, height);
        const diff = new PNG({ width, height });
        const numDiff = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: THRESHOLD });

        if (numDiff > MIN_CHANGED_PIXELS) {
          changesFound++;
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const folderName = `results/${site.name}__${stamp}`;
          const folder = path.join(DOCS_DIR, folderName);
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(path.join(folder, 'before.png'), PNG.sync.write(a));
          fs.writeFileSync(path.join(folder, 'after.png'), PNG.sync.write(b));
          fs.writeFileSync(path.join(folder, 'diff.png'), PNG.sync.write(diff));

          const marked = new PNG({ width, height });
          b.data.copy(marked.data);
          const bounds = findChangedBounds(diff);
          let percentFromTop = null;
          if (bounds) {
            drawBox(marked, bounds, 20, 6);
            percentFromTop = Math.round((bounds.minY / height) * 100);
          }
          fs.writeFileSync(path.join(folder, 'marked.png'), PNG.sync.write(marked));

          // מוסיף את השינוי לראש ההיסטוריה (החדש ביותר ראשון).
          history.unshift({
            site: site.name,
            url: site.url,
            time: new Date().toISOString(),
            numDiff,
            percentFromTop,
            folder: folderName,
          });

          // הצילום הנוכחי הופך לבסיס החדש (כדי לא להתריע שוב על אותו דבר).
          fs.writeFileSync(baselinePath, currentBuf);
          console.log(`  ⚠️  זוהה שינוי! ${numDiff} פיקסלים השתנו.`);
        } else {
          console.log(`  ✓ אין שינוי משמעותי (${numDiff} פיקסלים בלבד).`);
        }
      } else {
        fs.writeFileSync(baselinePath, currentBuf);
        console.log('  📷 צילום ראשון נשמר כבסיס להשוואות הבאות.');
      }
    } catch (err) {
      console.log(`  ❌ שגיאה בבדיקת "${site.name}": ${err.message}`);
    }
  }

  // שומר חותמת "נבדק לאחרונה" כדי שהדשבורד יציג זאת.
  fs.writeFileSync(path.join(DOCS_DIR, 'status.json'),
    JSON.stringify({ checkedAt, changesFound }, null, 2));

  writeHistory(history);
  await browser.close();
  console.log(`\nסיום. זוהו שינויים ב-${changesFound} אתר/ים.`);
}

run();
