# Project Enlightenment — Training Database

A modern replacement for the Microsoft Access training database used by
[Project Enlightenment](https://www.wcpss.net/projectenlightenment), an early-childhood
education programme of the Wake County Public School System.

The Access application is a 42 MB database with 48 forms and 112 reports, maintained by a
small staff and relied on for workshop scheduling, participant registration, CEU/CHC
certificate issuance, and state reporting. This repository is the migration target: a
SQL Server database, a documented REST API, and a responsive web application.

> **Status: in progress.** The schema, data migration, and core screens are built and
> verified. Reports, payments, and cutover are not yet complete. See
> [docs/plans/access-migration.md](docs/plans/access-migration.md) for the full plan.

---

## What is here

| Path | Contents |
| --- | --- |
| `apps/api` | Express + TypeScript REST API, OpenAPI 3.1 spec, Swagger UI |
| `apps/web` | React 19 + Vite staff application and public registration form |
| `packages/shared` | Shared TypeScript types and WCPSS design tokens |
| `db/` | Target schema DDL, ETL scripts, and feature migrations |
| `docs/` | Migration plan, feature specs, and build records |

## What it does

- **Staff application** — workshops, participants, registrations, agencies, users, and a dashboard.
- **Public registration** — each workshop can be opened for online registration via an
  unguessable, individually revocable link. The form branches on whether the registrant is
  an educator or a parent/caregiver. See
  [docs/features/public-registration.md](docs/features/public-registration.md).
- **API** — every screen is backed by a documented endpoint rather than bespoke queries.
  Browse the spec at `/api-docs` in the running app, or `/swagger` on the API directly.

## Stack

| Layer | Choice |
| --- | --- |
| Database | Azure SQL (SQL Server) |
| API | Node.js, Express, TypeScript, `mssql`, Zod |
| Web | React 19, Vite, TanStack Query, Recharts |
| Auth | JWT access token + httpOnly refresh cookie, role-based access |

## Getting started

### Prerequisites

- Node.js 20+
- An Azure SQL database with the schema applied

### Setup

```bash
npm install
```

Copy the environment template and fill in your own values:

```bash
cp apps/api/.env.example apps/api/.env
```

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Apply the schema:

```bash
sqlcmd -S <server> -d <database> -U <user> -P <password> -i db/schema.sql
sqlcmd -S <server> -d <database> -U <user> -P <password> -i db/auth.sql
sqlcmd -S <server> -d <database> -U <user> -P <password> -i db/public-registration.sql
```

### Run

```bash
npm run dev --workspace @pe/api   # API on http://localhost:3001
npm run dev --workspace @pe/web   # Web on http://localhost:5180
```

The super administrator is seeded on first boot from `SUPER_ADMIN_*` in `apps/api/.env`.

> **Port note:** the web app uses **5180**, not Vite's default 5173.

### Type checking

```bash
npm run typecheck --workspace @pe/api
npm run typecheck --workspace @pe/web
```

## Data migration

The Access database is not in this repository — it contains real participant records.
The migration is staging-first: extract to `staging.*`, transform into `core.*`/`ref.*`,
and gate on reconciliation checks (row counts and financial totals must match exactly).

```bash
pwsh db/etl/extract.ps1
sqlcmd -S <server> -d <database> -U <user> -P <password> -i db/etl/transform.sql
```

## Two databases

There is a production database and a test database for staff training. **Schema changes
must be applied to both** — see [docs/features/schema-environments.md](docs/features/schema-environments.md).

```powershell
# Rebuild the test database from production (production is read-only here)
powershell -File db/etl/copy-database.ps1 -Force

# Verify the two schemas have not drifted apart
powershell -File db/etl/compare-schema.ps1
```

`db/schema.sql` is idempotent and non-destructive — it creates objects only when absent, so
it is safe to run against a populated database. To change an existing object, add a guarded
`ALTER` in `db/migrations/` and apply it to both databases.

## Documentation

- [Migration plan](docs/plans/access-migration.md) — architecture, schema, phases, risks
- [Email setup](docs/features/email-setup.md) — Microsoft Graph configuration for sending mail
- [Deployment](docs/features/deployment.md) — Azure App Service, the pipeline, required settings
- [Schema environments](docs/features/schema-environments.md) — production vs test, and the dual-change rule
- [Public registration](docs/features/public-registration.md) — the two-audience split
- [Responsive & mobile](docs/features/responsive-mobile.md) — the phone-first requirement
- [School Cash Online integration](docs/plans/schoolcash-integration.md) — payment data plan
- [Build records](docs/completions/) — what was built, when, and what broke

## License

All rights reserved. This is internal work for the Wake County Public School System and is
not licensed for reuse.
