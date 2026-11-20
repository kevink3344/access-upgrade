# Sending email — Microsoft Graph setup

The app needs to send transactional email (registration confirmations). SMTP is not
available: the WCPSS relay (`smtp-out5.wcpss.net`, `smtp.wcpss.net`) authenticates by
source IP, not credentials, and rejects Azure App Service egress.

Microsoft Graph sends over HTTPS with an app identity, so there is no firewall change and
no IP allow-listing to maintain.

---

## What you need from IT

Send this to whoever administers the WCPSS Microsoft 365 tenant.

> **Request:** an Entra ID app registration with application permission `Mail.Send`, plus a
> service mailbox to send from.
>
> - Application (not delegated) permission: `Microsoft Graph → Mail.Send`
> - Admin consent granted for the tenant
> - A mailbox the app may send as, e.g. `projectenlightenment@wcpss.net`
> - The three values below returned to us

| Value | Where it comes from | Looks like |
| --- | --- | --- |
| **Tenant ID** | Entra admin center → Overview | `38d49456-54d4-455d-a8d6-c383c71e0a6d` |
| **Client ID** | App registration → Overview → Application (client) ID | `535fb089-9ff3-47b6-9bfb-4f1264799865` |
| **Client secret** | App registration → Certificates & secrets → New client secret | `qWgdYA...L1qKv5bPX` |
| **Sender mailbox** | A licensed mailbox in the tenant | `projectenlightenment@wcpss.net` |

> **Note on the secret:** it is shown once, at creation. Record it immediately. Note the
> expiry date — Entra secrets expire (12 or 24 months by default) and email will silently
> stop working when they do.

---

## Security decisions worth agreeing up front

**Use an application access policy to scope the mailbox.** By default, `Mail.Send` lets the
app send as **any** mailbox in the tenant. That is far more access than this app needs.

An Exchange administrator can restrict it to one mailbox:

```powershell
# Exchange Online PowerShell
New-ApplicationAccessPolicy `
  -AppId <client-id> `
  -PolicyScopeGroupId projectenlightenment@wcpss.net `
  -AccessRight RestrictAccess `
  -Description "Project Enlightenment app - send only as this mailbox"
```

Verify with:

```powershell
Test-ApplicationAccessPolicy -AppId <client-id> -Identity projectenlightenment@wcpss.net
```

This is the single most valuable hardening step. Without it, a leaked client secret allows
sending as the superintendent.

**Prefer a certificate over a client secret** if IT offers it. Certificates cannot be
guessed from a config file and are the recommended approach for production apps. The code
below supports either.

---

## Configuration in this app

Add to `apps/api/.env` (and to App Service → Configuration for the deployed app):

```ini
# ---- Email (Microsoft Graph) -----------------------------------------
GRAPH_TENANT_ID=<tenant-id>
GRAPH_CLIENT_ID=<client-id>
GRAPH_CLIENT_SECRET=<client-secret>
MAIL_FROM=projectenlightenment@wcpss.net
MAIL_FROM_NAME=Project Enlightenment
```

Leave them blank to disable email. The app must degrade gracefully when they are absent —
a missing mail configuration must never break registration.

---

## How it works

Three steps, all over HTTPS:

1. **Get a token** — POST to the identity platform with the client credentials.
2. **Send** — POST to Graph `sendMail` as the sender mailbox.
3. **Cache the token** — it is valid ~60 minutes; request a new one only when it expires.

### 1. Token request

```http
POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

client_id={client-id}
&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default
&client_secret={client-secret}
&grant_type=client_credentials
```

Response:

```json
{
  "token_type": "Bearer",
  "expires_in": 3599,
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIs..."
}
```

`scope` must be exactly `https://graph.microsoft.com/.default` — that tells Entra to include
every application permission the admin consented to.

### 2. Send

```http
POST https://graph.microsoft.com/v1.0/users/{sender-mailbox}/sendMail
Authorization: Bearer {access-token}
Content-Type: application/json

{
  "message": {
    "subject": "You're registered — A Guided Observation of the Blended Classroom",
    "body": { "contentType": "HTML", "content": "<p>...</p>" },
    "toRecipients": [
      { "emailAddress": { "address": "parent@example.com", "name": "Jane Doe" } }
    ]
  },
  "saveToSentItems": false
}
```

Returns **`202 Accepted`** with an empty body. A 202 means *queued*, not *delivered* — see
the caveat below.

---

## Things that will bite you

**202 does not mean delivered.** Graph accepts the message and Exchange delivers it
asynchronously. A 202 with a bad recipient address still returns 202. Do not treat it as
proof of delivery.

**Throttling.** Exchange Online limits are roughly 10,000 recipients per day and 30 messages
per minute for an app-only mailbox. For registration confirmations that is ample, but batch
sends (a mailing list of 4,000) will need chunking and retry on `429`.

**The secret expires.** Entra client secrets have a fixed lifetime. When one expires, every
send fails with `401`. Set a calendar reminder, or use a certificate.

**`saveToSentItems: false`** keeps the service mailbox from filling with thousands of
confirmations. Set it unless staff need to see sent mail.

**Consent must be re-granted** whenever permissions change. Editing the app registration is
not enough — an admin has to consent again.

---

## Verifying the setup

Once the values are in place, this proves the whole chain without sending real mail:

```powershell
$tenant = '<tenant-id>'; $clientId = '<client-id>'; $secret = '<client-secret>'

$token = (Invoke-RestMethod -Method Post `
  -Uri "https://login.microsoftonline.com/$tenant/oauth2/v2.0/token" `
  -Body @{
    client_id     = $clientId
    scope         = 'https://graph.microsoft.com/.default'
    client_secret = $secret
    grant_type    = 'client_credentials'
  }).access_token

# Who is this token for? Confirms the app identity resolved.
(Invoke-RestMethod -Uri 'https://graph.microsoft.com/v1.0/$metadata' -Headers @{ Authorization = "Bearer $token" }) | Out-Null
"Token acquired: $($token.Substring(0,20))..."

# Confirm the sender mailbox exists and is reachable
Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/users/projectenlightenment@wcpss.net" `
  -Headers @{ Authorization = "Bearer $token" } | Select-Object displayName, mail
```

If the token request fails with `AADSTS7000215`, the secret is wrong or expired.
If `sendMail` returns `403`, admin consent has not been granted or the access policy is
blocking the mailbox.

---

## Fallback options

If IT cannot grant Graph permissions:

| Option | Requirement | Trade-off |
| --- | --- | --- |
| Azure Communication Services Email | Azure subscription, domain verification | Sends from `@azurecomm.net` unless a custom domain is verified |
| SendGrid / Postmark / SES | API key | Fastest to working; recipient data leaves the district |
| SMTP with credentials | A relay that supports `AUTH` on 587 | The WCPSS relay does not — it has no `AUTH` capability at all |

---

## Current state of the app

Email is **not implemented yet**. `nodemailer` is not installed and no send code exists.

The public registration form currently says *"A confirmation email is on its way"* — which
is not true. Until Graph is configured and the send path is built, that message should be
replaced with something honest, such as *"Your registration is confirmed — save this page
for your records."*
