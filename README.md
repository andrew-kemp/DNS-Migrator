# DNS Migrator: Any DNS → Cloudflare

Migrates DNS zones from **any provider** to Cloudflare. Supports universal DNS scanning (works with GoDaddy, Route53, Azure, Namecheap, etc.), direct Azure DNS API connection, or manual domain entry. Deployed as a Cloudflare Pages app or run locally.

## The Problem

When importing DNS zone files into Cloudflare, records often get mangled:
- `home` becomes `home.example.com` → resolves as `home.example.com.example.com`
- CNAME target `app.azurewebsites.net` becomes `app.azurewebsites.net.example.com`

## The Solution

This tool discovers your existing DNS records and pushes clean, correctly-formatted records to Cloudflare via the API. It **creates the zones** for you and **shows the nameservers** you need to set at your registrar.

### Three ways to source DNS records

| Source | What it does | Best for |
|--------|-------------|----------|
| **DNS Scan** | Queries live DNS via DNS-over-HTTPS to discover records | Any provider — GoDaddy, Route53, Azure, etc. |
| **Azure DNS** | Connects to Azure Management API for a full zone export | Azure DNS users who want guaranteed completeness |
| **Manual** | Creates empty zones in Cloudflare by domain name | Just moving nameservers, adding records later |

> **Note:** DNS Scan probes ~80 common subdomains and all standard record types. It catches the most important records but cannot discover every possible subdomain. Azure DNS connection gives a complete export.

---

## Deploy on Cloudflare Pages (Recommended)

The app runs as a Cloudflare Pages project with Functions (serverless API).

### Prerequisites

- **Cloudflare account** (free tier works)
- **Cloudflare API Token** with **Zone:Edit** + **Account:Read** permissions
  - Create at: https://dash.cloudflare.com/profile/api-tokens
  - Use the "Edit zone DNS" template and add Account:Read

### Deploy

```bash
npm install
npx wrangler pages deploy public
```

Or connect your GitHub repo to Cloudflare Pages for automatic deploys.

### Local dev with Wrangler

```bash
npm install
npm run pages:dev
```

Opens at http://localhost:3000 using the Cloudflare Workers runtime locally.

---

## Run locally with Node.js

```bash
npm install
npm start
```

Opens at http://localhost:3000. Uses Express for the API server.

### Azure connection (optional)

If using the Azure DNS source, you need one of:
- **Bearer token** — run `az account get-access-token --resource https://management.azure.com --query accessToken -o tsv`
- **Service Principal** — with DNS Reader role on the subscription

---

## Usage

1. **Cloudflare** — Paste your API token, the app validates it and detects your account
2. **Source** — Pick how to source DNS records:
   - **DNS Scan** — Enter domain names, records are discovered via live DNS lookup
   - **Azure DNS** — Authenticate with Azure, pick subscription, see all zones
   - **Manual** — Enter domain names, zones created without records
3. **Select Domains** — Review discovered domains/records, tick which to migrate
4. **Migrate** — Watch real-time progress, get Cloudflare nameservers to set at your registrar

### Security

- Tokens are passed per-request and used in-memory only — **never stored or logged**
- No database, no sessions, no cookies

---

## PowerShell CLI

For command-line use or automation.

### Prerequisites

- **Azure CLI** (`az`) installed and logged in (`az login`)
- **Cloudflare API Token** with Zone.DNS edit permissions
- **Cloudflare Zone ID** — found on the zone overview page in the Cloudflare dashboard

### Single Zone

```powershell
# Dry run first (no changes made)
.\Migrate-DNS.ps1 `
    -AzureResourceGroup "my-rg" `
    -ZoneName "andykemp.com" `
    -CloudflareApiToken "your-cf-api-token" `
    -CloudflareZoneId "your-cf-zone-id" `
    -DryRun

# Run for real
.\Migrate-DNS.ps1 `
    -AzureResourceGroup "my-rg" `
    -ZoneName "andykemp.com" `
    -CloudflareApiToken "your-cf-api-token" `
    -CloudflareZoneId "your-cf-zone-id" `
    -SkipExisting
```

### Batch Migration

1. Copy `config.example.json` to `config.json` and fill in your zones
2. Run:

```powershell
.\Migrate-Batch.ps1 -ConfigFile ".\config.json" -CloudflareApiToken "your-token" -DryRun
.\Migrate-Batch.ps1 -ConfigFile ".\config.json" -CloudflareApiToken "your-token" -SkipExisting
```

---

## Supported Record Types

| Type | Supported | Notes |
|------|-----------|-------|
| A | Yes | |
| AAAA | Yes | |
| CNAME | Yes | Target trailing dots stripped |
| MX | Yes | Priority preserved |
| TXT | Yes | Multi-value segments joined |
| SRV | Yes | Priority/weight/port/target |
| CAA | Yes | Flags/tag/value |
| NS | Yes | Non-apex only; apex NS skipped |
| SOA | Skip | Cloudflare manages its own |
| PTR | Yes | |

## How It Works

1. **Discover** — Scans live DNS via DoH, reads from Azure API, or accepts manual domain list
2. **Transform** — Strips zone suffixes from FQDNs, removes trailing dots from targets
3. **Create zone** — Creates the zone in Cloudflare, returns nameservers
4. **Push records** — Creates each record via Cloudflare API, skipping duplicates
5. **Report** — Shows created/skipped/failed counts and the nameservers to set

## Tips

- **Proxy is off by default** — records are created DNS-only (grey cloud) so nothing breaks during cutover
- After migration, update nameservers at your registrar to point to Cloudflare
- Keep Azure DNS zones intact until Cloudflare is fully propagated and verified

## Files

| File | Purpose |
|------|---------|
| `public/` | Frontend: wizard UI |
| `functions/` | Cloudflare Pages Functions (API endpoints) |
| `src/` | Shared backend modules: Azure API, Cloudflare API, DNS scan, transform logic |
| `server.js` | Express server (for local Node.js dev without Wrangler) |
| `wrangler.toml` | Cloudflare Pages deployment config |
| `Migrate-DNS.ps1` | PowerShell: single zone migration |
| `Migrate-Batch.ps1` | PowerShell: multi-zone batch |
| `config.example.json` | Example config for PS batch mode |
