# Deploying to Azure

The app runs as a single Azure App Service: the Express API serves both the API
(`/api/*`, `/health`, `/swagger`, `/openapi.json`) and the built React app (everything else).
Staff open one URL, log in, and the SPA calls the API on the same origin — so there is no
CORS to configure and no second host to pay for.

| | |
| --- | --- |
| App Service | `projelmt` |
| Slot | `dev` |
| Workflow | `.github/workflows/deploy-projelmt.yml` |
| Trigger | push to `main`, or manual dispatch |

## How the pipeline works

```
build job                          deploy job
─────────                          ──────────
npm ci                             download artifact
npm run typecheck                  verify dist/server.js + web/dist/index.html
npm run build                      azure/webapps-deploy@v3
assemble package  ──artifact──▶
```

The **artifact is deliberately small** — only what Azure needs to run:

```
dist/              compiled API (tsc output)
web/dist/          built React app
package.json       rewritten: start = node dist/server.js, prod deps only
node_modules/      production dependencies (~79 MB)
```

## Why the default Azure workflow fails

Azure's generated workflow uploads `path: .` — the entire repository — and deploys it. That
fails for this project in two ways:

1. **`npm run build` fails.** The root build chains `--workspace=@pe/shared`, which had no
   `build` script. (Fixed: `@pe/shared` is types and CSS only, so its build is a no-op.)
2. **There is no `server.js` at the repo root.** This is a monorepo with the API in
   `apps/api`. Azure looks for a start command at the package root and finds nothing, so it
   fails with "couldn't detect a start command" or serves a 404.

The custom workflow solves both by assembling a package whose root *is* the API.

## Required App Service configuration

Set these under **Configuration → Application settings** on `projelmt` (and the `dev` slot).
They are **not** in the repository — `apps/api/.env` is local only.

| Setting | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `AZURE_SQL_SERVER` | `wcpsssqlelasticpool.database.windows.net` |
| `AZURE_SQL_DATABASE` | `project-enlightenment` |
| `AZURE_SQL_USER` | *(SQL admin user)* |
| `AZURE_SQL_PASSWORD` | *(SQL admin password)* |
| `JWT_SECRET` | 32+ random characters |
| `WEB_ORIGIN` | `https://projelmt-dev.azurewebsites.net` |
| `SUPER_ADMIN_EMAIL` | `admin@oracleinsights.local` |
| `SUPER_ADMIN_PASSWORD` | *(initial admin password)* |
| `MODE` | `TEST SITE` for test, **blank** for production |

### The `MODE` badge

`MODE` is a deployment label shown as a badge next to the WCPSS badge on the
sign-in page. It tells staff at a glance which environment they are signing into.

| Value | Result |
| --- | --- |
| `MODE=TEST SITE` | Gold **TEST SITE** badge appears |
| `MODE=` (blank or unset) | No badge |

Production needs no configuration — leave it blank. The value is served by
`GET /health/config` (unauthenticated, non-sensitive) because the React bundle
is static and cannot read server environment variables at runtime.

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Also set the **Startup Command** to `bash startup.sh`. It installs the Chromium
runtime libraries the certificate PDFs need, then starts the API — see
[Certificate PDF rendering](#certificate-pdf-rendering) below.

On a Linux App Service the field is under **Configuration → Stack → Settings**
(not the Windows "General settings" blade):

```
Startup Command:  bash startup.sh
```

### `WEBSITE_NODE_DEFAULT_VERSION`

Set to `~22` so the App Service matches the build.

## Certificate PDF rendering

PDF downloads are rendered by headless Chromium. The Linux App Service image
ships **no browser and not the shared libraries Chrome needs**, so both are
provisioned by the pipeline:

| What | Where | Why |
| --- | --- | --- |
| Chromium binary | Deploy workflow: `npx puppeteer browsers install chrome` into `.cache/puppeteer` | The app searches that cache when no system browser exists |
| Runtime libraries | `scripts/startup.sh`, run on the host at boot | `apt-get` must run on the machine that runs the app, not the build runner |

**Startup Command** must therefore be `bash startup.sh`, not `npm start`. The
wrapper installs the libraries (best-effort), then `exec`s `node dist/server.js`.
It is set under **Configuration → Stack → Settings**.

Every step is best-effort: if the libraries cannot be installed the site still
starts, and the Certificates page reports that PDF downloads are unavailable
rather than the whole app failing to boot. Previews never depend on the browser.

To confirm on a deployed environment:

```bash
curl -H "Authorization: Bearer <token>" https://projelmt-dev.azurewebsites.net/api/certificates/capabilities
# {"pdfRendering":true,"browserPath":"/home/site/wwwroot/.cache/puppeteer/chrome/..."}
```

If `pdfRendering` is `false`, either set `CHROME_PATH` to a browser on the host
or check the startup log for the `[startup]` lines.


## Notes on behaviour in production

- **Refresh cookie** is `secure: true` in production, so the site must be served over HTTPS.
  App Service provides this by default.
- **Static caching**: hashed assets get `immutable` (1 year); `index.html` gets `no-cache` so
  a deploy is picked up immediately.
- **Client-side routing**: any non-API GET returns `index.html`, so refreshing a deep link
  like `/workshops/3023` works.
- **Swagger** is available at `/swagger` and the spec at `/openapi.json`.

## Verifying a deploy

```bash
curl https://projelmt-dev.azurewebsites.net/health
# {"status":"ok",...}

curl -I https://projelmt-dev.azurewebsites.net/
# 200, content-type: text/html

curl -I https://projelmt-dev.azurewebsites.net/workshops
# 200, text/html  (SPA fallback, not a 404)
```

If `/health` returns 500, check **Log stream** — the most common cause is a missing or wrong
application setting, which fails fast at boot with a list of what is invalid.

## Serverless SQL caveat

The production database is on an elastic pool and the test database is serverless (it
auto-pauses). If the first request after idle times out, it is waking up — retry. Consider
setting a minimum vCore on the serverless database if cold starts are a problem for staff.
