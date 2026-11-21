# Rotating the SQL password

The app authenticates to Azure SQL with a **SQL login** (`wcpss-sql-admin`), not
Entra ID / managed identity. That means the password lives in two places and
both must change together:

| Where | Value |
| --- | --- |
| Azure SQL server | the login's password |
| `apps/api/.env` | `AZURE_SQL_PASSWORD` (local dev) |
| Azure App Service | `AZURE_SQL_PASSWORD` (deployed app) |

> **Both databases share this login.** Production (`wcpsssqlelasticpool`) and
> test (`wcpss-sql-serverless-freetier`) use the same username *and the same
> password*. Rotating it affects both. See
> [schema-environments.md](schema-environments.md) for why separate credentials
> per environment would be better.

---

## Where to rotate it

### Option A — Azure portal (recommended)

1. Go to the **Azure portal** → **SQL servers** → `wcpsssqlelasticpool`
2. Left menu → **Security** → **Authentication** (older portals: **Active Directory admin** is separate; look for **SQL logins**)
3. Select `wcpss-sql-admin` → **Reset password**
4. Enter the new password → **Save**

Repeat on `wcpss-sql-serverless-freetier` so both servers match.

> The portal path varies by portal version. If you cannot find it, use
> Option B — it is the same operation, executed in T-SQL.

### Option B — T-SQL

The app's login has `ALTER ANY LOGIN`, so it can rotate its own password:

```sql
ALTER LOGIN wcpss-sql-admin WITH PASSWORD = '<new-password>';
```

Run it against **each server** (the login is server-level, so connect to any
database on that server):

```powershell
sqlcmd -S wcpsssqlelasticpool.database.windows.net -d project-enlightenment `
       -U wcpss-sql-admin -P '<old-password>' `
       -Q "ALTER LOGIN wcpss-sql-admin WITH PASSWORD = '<new-password>'"

sqlcmd -S wcpss-sql-serverless-freetier.database.windows.net -d project-enlightenment-test `
       -U wcpss-sql-admin -P '<old-password>' `
       -Q "ALTER LOGIN wcpss-sql-admin WITH PASSWORD = '<new-password>'"
```

> **Order matters.** Changing the server password immediately invalidates the
> old one, so the app and any running scripts break until their config is
> updated. Do the update in one sitting.

---

## Then update the app

### 1. Local development

Edit `apps/api/.env`:

```ini
AZURE_SQL_PASSWORD=<new-password>
AZURE_SQL_PASSWORD_TEST=<new-password>
```

Restart the API. It reads `.env` at boot only.

### 2. Azure App Service

**Portal** → your App Service → **Configuration** → **Application settings** →
edit `AZURE_SQL_PASSWORD` → **Save**.

Saving restarts the app. Verify:

```bash
curl https://<your-app>.azurewebsites.net/health/ready
# {"status":"ready","database":"connected",...}
```

If it returns `503` with a login failure, the setting did not save or the
password does not match.

### 3. Anything else holding the credential

Search the repo for the old value before you finish:

```powershell
Get-ChildItem -Recurse -File |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
  Select-String -Pattern '<old-password>' -SimpleMatch
```

Expected hits: `apps/api/.env` only. If `database/.env.example` still exists
locally it will also match — that file is gitignored precisely because it holds
a real credential, and it should be updated or deleted.

---

## Generating a strong password

Azure SQL passwords must contain characters from three of: uppercase,
lowercase, digits, symbols.

```powershell
# 32 characters, URL-safe, no quoting problems in .env
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
```

Avoid `$`, `"`, and `` ` `` — they need escaping in `.env` files and in
PowerShell strings, which is how credentials end up mangled.

---

## A better long-term answer

Rotating a shared password is a recurring chore and the blast radius is both
databases. Two improvements worth considering:

**Separate credentials per environment.** Production and test currently share
one login. Giving each its own means a mistake in test cannot reach production.

**Use a managed identity instead of a password.** App Service can authenticate
to Azure SQL with its own Entra identity, so there is no password to store,
rotate, or leak. It requires:

1. A system-assigned managed identity on the App Service
2. That identity added to the database as a contained user:
   ```sql
   CREATE USER [projelmt] FROM EXTERNAL PROVIDER;
   ALTER ROLE db_datareader, db_datawriter ADD MEMBER [projelmt];
   ```
3. `db.ts` switched to `authentication: 'azure-active-directory-default'`
   with no `user`/`password`

That removes the credential from `.env` and App Service settings entirely. It
is the recommended configuration for an app running in Azure, and it is the
only option that makes "rotate the password" a non-issue.
