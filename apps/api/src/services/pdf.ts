import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Renders HTML to a PDF using a locally installed Chromium-family browser.
 *
 * Deliberately not Playwright: the deploy artifact is a plain Node package and
 * shipping a bundled browser (~400 MB) plus its shared-library dependencies to
 * App Service is a large, fragile addition. Headless Chrome's own
 * `--print-to-pdf` produces the same output for a fixed 8.5x11 layout, and the
 * browser is already present on the dev machines and on the Linux App Service
 * image.
 */

const CANDIDATES = [
  // Explicit override wins, for environments with an unusual install path.
  process.env.CHROME_PATH,
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  // Linux (App Service)
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean) as string[];

let cachedBrowser: string | null | undefined;

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
  cachedBrowser = null;
  return null;
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
