<#
.SYNOPSIS
    Migrates multiple DNS zones from Azure DNS to Cloudflare in batch.

.DESCRIPTION
    Reads a JSON config file listing zones with their Azure resource group
    and Cloudflare zone ID, then migrates each one sequentially.

.PARAMETER ConfigFile
    Path to a JSON config file. See config.example.json for format.

.PARAMETER CloudflareApiToken
    Cloudflare API token with DNS edit permissions for all zones.

.PARAMETER DryRun
    If specified, shows what would be created without making changes.

.EXAMPLE
    .\Migrate-Batch.ps1 -ConfigFile ".\config.json" -CloudflareApiToken "your-token" -DryRun
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigFile,

    [Parameter(Mandatory = $true)]
    [string]$CloudflareApiToken,

    [switch]$DryRun,

    [switch]$Proxied,

    [switch]$SkipExisting
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ConfigFile)) {
    throw "Config file not found: $ConfigFile"
}

$config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$migrateScript = Join-Path $scriptDir "Migrate-DNS.ps1"

Write-Host "`n══════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "  Batch DNS Migration: $($config.zones.Count) zone(s)" -ForegroundColor Cyan
Write-Host "══════════════════════════════════════════════`n" -ForegroundColor Magenta

$results = @()

foreach ($zone in $config.zones) {
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
    Write-Host "  Migrating: $($zone.zoneName)" -ForegroundColor White
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray

    $params = @{
        AzureResourceGroup = $zone.resourceGroup
        ZoneName           = $zone.zoneName
        CloudflareApiToken = $CloudflareApiToken
        CloudflareZoneId   = $zone.cloudflareZoneId
    }

    if ($DryRun) { $params.DryRun = $true }
    if ($Proxied) { $params.Proxied = $true }
    if ($SkipExisting) { $params.SkipExisting = $true }

    try {
        & $migrateScript @params
        $results += @{ Zone = $zone.zoneName; Status = "OK" }
    }
    catch {
        Write-Host "`n❌ Failed to migrate $($zone.zoneName): $_" -ForegroundColor Red
        $results += @{ Zone = $zone.zoneName; Status = "FAILED: $_" }
    }

    Write-Host ""
}

# Final summary
Write-Host "`n══════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "  Batch Migration Complete" -ForegroundColor Cyan
Write-Host "══════════════════════════════════════════════" -ForegroundColor Magenta
foreach ($r in $results) {
    $color = if ($r.Status -eq 'OK') { 'Green' } else { 'Red' }
    Write-Host "  $($r.Zone): $($r.Status)" -ForegroundColor $color
}
Write-Host ""
