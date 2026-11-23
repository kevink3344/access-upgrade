import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

/**
 * Renders HTML to a PDF using a Chromium-family browser.
 *
 * Two sources, in order:
 *
 *  1. A browser already installed on the machine (CHROME_PATH, then the usual
 *     Windows/Linux/macOS locations). This is the dev-machine path.
 *  2. A Puppeteer-managed Chromium in the app's cache directory. Azure's
 *     Linux App Service image ships no browser, so the deploy step installs
 *     one this way and the app finds it in the cache.
 *
 * Deliberately not Playwright: the deploy artifact is a plain Node package, and
 * Puppeteer's own download is a single directory that can be pointed at a
 * location on the persistent disk. Headless Chrome's `--print-to-pdf` produces
 * the same output for a fixed 8.5x11 layout.
 */

/**
 * Where a managed Chromium may live.
 *
 * The deploy workflow installs it into the package's own `.cache/puppeteer`,
 * which lands beside `dist/` on App Service. Puppeteer's default is under the
 * home directory, which is a *different* place on App Service (`/home` vs
 * `/home/site/wwwroot`), so both are searched. PUPPETEER_CACHE_DIR wins if set.
 */
function managedCacheDirs(): string[] {
  if (process.env.PUPPETEER_CACHE_DIR) return [process.env.PUPPETEER_CACHE_DIR];

  // dist/services/pdf.js -> dist -> package root
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(here, '..', '..');

  return [
    // Where the deploy workflow installs it. Not dot-prefixed: upload-artifact
    // skips hidden directories, so a `.cache` copy never reaches the server.
    path.join(packageRoot, 'puppeteer-cache'),
    path.join(packageRoot, '.cache', 'puppeteer'),
    path.join(os.homedir(), '.cache', 'puppeteer'),
  ];
}

const MANAGED_CACHE = managedCacheDirs()[0]!;

const CANDIDATES = [
  // Explicit override wins, for environments with an unusual install path.
  process.env.CHROME_PATH,
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  // Linux (App Service image, if a browser is ever present)
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean) as string[];

let cachedBrowser: string | null | undefined;

/**
 * Resolves the executable to use.
 *
 * The managed cache is searched by walking it rather than by a fixed path,
 * because Puppeteer names the directory after the exact Chrome build, which
 * changes on every upgrade.
 */
async function findManagedChromium(): Promise<string | null> {
  const exe = process.platform === 'win32' ? 'chrome.exe' : 'chrome';

  async function walk(dir: string, depth: number): Promise<string | null> {
    if (depth > 4) return null;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await walk(full, depth + 1);
        if (found) return found;
      } else if (entry.name === exe) {
        return full;
      }
    }
    return null;
  }

  for (const dir of managedCacheDirs()) {
    const found = await walk(dir, 0);
    if (found) return found;
  }
  return null;
}

export async function findBrowser(): Promise<string | null> {
  if (cachedBrowser !== undefined) return cachedBrowser;

  for (const candidate of CANDIDATES) {
    try {
      await fs.access(candidate);
      cachedBrowser = candidate;
      return candidate;
    } catch {
      // try the next one
    }
  }

  const managed = await findManagedChromium();
  cachedBrowser = managed;
  return managed;
}

/** Clears the memoised lookup, so a newly installed browser is picked up. */
export function resetBrowserCache(): void {
  cachedBrowser = undefined;
}

export class PdfUnavailableError extends Error {
  constructor() {
    super(
      'No Chromium-family browser found for PDF rendering. Set CHROME_PATH to the browser executable.',
    );
    this.name = 'PdfUnavailableError';
  }
}

/**
 * @param html Full HTML document. Images must already be data URIs — the
 *             renderer loads from a temp file and must not make network calls.
 */
export async function renderPdf(html: string): Promise<Buffer> {
  const browser = await findBrowser();
  if (!browser) throw new PdfUnavailableError();

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pe-cert-'));
  const htmlPath = path.join(dir, 'certificate.html');
  const pdfPath = path.join(dir, 'certificate.pdf');

  try {
    await fs.writeFile(htmlPath, html, 'utf8');

    const args = [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-dev-shm-usage',
      // The template owns all spacing, so preview and print cannot diverge.
      '--no-pdf-header-footer',
      '--print-to-pdf-no-header',
      `--print-to-pdf=${pdfPath}`,
      // Give fonts and images a moment to settle before printing.
      '--virtual-time-budget=5000',
      `file:///${htmlPath.replace(/\\/g, '/')}`,
    ];

    await execFileAsync(browser, args, { timeout: 60_000, windowsHide: true });

    return await fs.readFile(pdfPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** What the capabilities endpoint reports, so the UI can explain itself. */
export interface PdfCapability {
  available: boolean;
  /** The executable in use, or null. Safe to expose: it is a path, not a secret. */
  browserPath: string | null;
  /** Every directory searched for a managed browser, for troubleshooting. */
  searchedDirs: string[];
}

export async function pdfCapability(): Promise<PdfCapability> {
  const browser = await findBrowser();
  return {
    available: browser !== null,
    browserPath: browser,
    searchedDirs: managedCacheDirs(),
  };
}
