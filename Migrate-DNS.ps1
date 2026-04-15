<#
.SYNOPSIS
    Migrates DNS zones from Azure DNS to Cloudflare.

.DESCRIPTION
    Reads all DNS records from an Azure DNS zone using the Azure CLI,
    transforms them into the correct format (stripping zone suffixes),
    and creates them in Cloudflare via the API.

    Supports: A, AAAA, CNAME, MX, TXT, SRV, CAA, NS (non-apex), PTR record types.
    Skips: SOA records and apex NS records (Cloudflare manages its own).

.PARAMETER AzureResourceGroup
    The Azure resource group containing the DNS zone.

.PARAMETER ZoneName
    The DNS zone name (e.g., andykemp.com).

.PARAMETER CloudflareApiToken
    Cloudflare API token with DNS edit permissions for the zone.

.PARAMETER CloudflareZoneId
    The Cloudflare Zone ID (found in the zone overview dashboard).

.PARAMETER DryRun
    If specified, shows what would be created without making any changes.

.PARAMETER Proxied
    If specified, enables Cloudflare proxy (orange cloud) for A/AAAA/CNAME records.
    Defaults to $false (DNS-only / grey cloud) for safe migration.

.PARAMETER SkipExisting
    If specified, skips records that already exist in Cloudflare instead of failing.

.EXAMPLE
    .\Migrate-DNS.ps1 -AzureResourceGroup "my-rg" -ZoneName "andykemp.com" `
        -CloudflareApiToken "your-api-token" -CloudflareZoneId "your-zone-id" -DryRun

.EXAMPLE
    .\Migrate-DNS.ps1 -AzureResourceGroup "my-rg" -ZoneName "andykemp.com" `
        -CloudflareApiToken "your-api-token" -CloudflareZoneId "your-zone-id"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AzureResourceGroup,

    [Parameter(Mandatory = $true)]
    [string]$ZoneName,

    [Parameter(Mandatory = $true)]
    [string]$CloudflareApiToken,

    [Parameter(Mandatory = $true)]
    [string]$CloudflareZoneId,

    [switch]$DryRun,

    [switch]$Proxied,

    [switch]$SkipExisting
)

$ErrorActionPreference = 'Stop'

# ── Cloudflare API helpers ──────────────────────────────────────────────────────

$cfBaseUrl = "https://api.cloudflare.com/client/v4"
$cfHeaders = @{
    "Authorization" = "Bearer $CloudflareApiToken"
    "Content-Type"  = "application/json"
}

function Invoke-CloudflareApi {
    param(
        [string]$Method,
        [string]$Endpoint,
        [object]$Body
    )
    $url = "$cfBaseUrl$Endpoint"
    $params = @{
        Method  = $Method
        Uri     = $url
        Headers = $cfHeaders
    }
    if ($Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 10)
    }
    try {
        $response = Invoke-RestMethod @params
        return $response
    }
    catch {
        $errorBody = $_.ErrorDetails.Message
        if ($errorBody) {
            $errorObj = $errorBody | ConvertFrom-Json -ErrorAction SilentlyContinue
            if ($errorObj -and $errorObj.errors) {
                return $errorObj
            }
        }
        throw
    }
}

function Get-CloudflareExistingRecords {
    $allRecords = @()
    $page = 1
    do {
        $response = Invoke-CloudflareApi -Method 'GET' -Endpoint "/zones/$CloudflareZoneId/dns_records?per_page=100&page=$page"
        if ($response.success) {
            $allRecords += $response.result
            $totalPages = $response.result_info.total_pages
        }
        else {
            Write-Warning "Failed to fetch existing Cloudflare records: $($response.errors | ConvertTo-Json)"
            return @()
        }
        $page++
    } while ($page -le $totalPages)
    return $allRecords
}

# ── Azure DNS reader ────────────────────────────────────────────────────────────

function Get-AzureDnsRecords {
    param([string]$ResourceGroup, [string]$Zone)

    Write-Host "`n📖 Reading DNS records from Azure zone: $Zone" -ForegroundColor Cyan
    Write-Host "   Resource Group: $ResourceGroup" -ForegroundColor Gray

    # Verify az CLI is available and logged in
    try {
        $null = az account show 2>&1
    }
    catch {
        throw "Azure CLI is not logged in. Run 'az login' first."
    }

    $rawJson = az network dns record-set list `
        --resource-group $ResourceGroup `
        --zone-name $Zone `
        --output json 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to list DNS records: $rawJson"
    }

    $recordSets = $rawJson | ConvertFrom-Json
    Write-Host "   Found $($recordSets.Count) record sets in Azure" -ForegroundColor Green
    return $recordSets
}

# ── Record transformation ───────────────────────────────────────────────────────

function Convert-AzureRecordName {
    <#
    .DESCRIPTION
        Converts an Azure DNS FQDN to a Cloudflare-compatible name.
        Azure returns FQDNs like "home.andykemp.com." — we strip the zone
        suffix and trailing dot to get the relative name "home".
        Apex records ("@" or just the zone name) become "@".
    #>
    param([string]$Fqdn, [string]$Zone)

    # Remove trailing dot
    $name = $Fqdn.TrimEnd('.')

    # If it's exactly the zone name, it's an apex record
    if ($name -eq $Zone) {
        return "@"
    }

    # Strip the zone suffix to get relative name
    $suffix = ".$Zone"
    if ($name.EndsWith($suffix)) {
        return $name.Substring(0, $name.Length - $suffix.Length)
    }

    # If the name is "@", keep it
    if ($name -eq "@") {
        return "@"
    }

    # Return as-is if it doesn't match the zone (shouldn't happen)
    return $name
}

function Convert-AzureToCloudflareRecords {
    <#
    .DESCRIPTION
        Converts Azure DNS record sets into an array of Cloudflare DNS record objects.
    #>
    param(
        [array]$AzureRecordSets,
        [string]$Zone,
        [bool]$EnableProxy
    )

    $cfRecords = @()
    $skippedCount = 0

    foreach ($rs in $AzureRecordSets) {
        $type = $rs.type.Split('/')[-1].ToUpper()  # e.g., "Microsoft.Network/dnszones/A" -> "A"
        $name = Convert-AzureRecordName -Fqdn $rs.fqdn -Zone $Zone
        $ttl = if ($rs.ttl -and $rs.ttl -gt 0) { $rs.ttl } else { 1 }  # 1 = auto in Cloudflare

        # Skip SOA records — Cloudflare manages its own
        if ($type -eq 'SOA') {
            Write-Host "   ⏭  Skipping SOA record (Cloudflare manages this)" -ForegroundColor DarkGray
            $skippedCount++
            continue
        }

        # Skip apex NS records — Cloudflare manages its own nameservers
        if ($type -eq 'NS' -and $name -eq '@') {
            Write-Host "   ⏭  Skipping apex NS records (Cloudflare manages nameservers)" -ForegroundColor DarkGray
            $skippedCount++
            continue
        }

        switch ($type) {
            'A' {
                foreach ($record in $rs.aRecords) {
                    $cfRecords += @{
                        type    = 'A'
                        name    = $name
                        content = $record.ipv4Address
                        ttl     = $ttl
                        proxied = $EnableProxy
                    }
                }
            }
            'AAAA' {
                foreach ($record in $rs.aaaaRecords) {
                    $cfRecords += @{
                        type    = 'AAAA'
                        name    = $name
                        content = $record.ipv6Address
                        ttl     = $ttl
                        proxied = $EnableProxy
                    }
                }
            }
            'CNAME' {
                # Azure stores CNAME as a single record
                if ($rs.cnameRecord -and $rs.cnameRecord.cname) {
                    $target = $rs.cnameRecord.cname.TrimEnd('.')
                    $cfRecords += @{
                        type    = 'CNAME'
                        name    = $name
                        content = $target
                        ttl     = $ttl
                        proxied = $EnableProxy
                    }
                }
            }
            'MX' {
                foreach ($record in $rs.mxRecords) {
                    $exchange = $record.exchange.TrimEnd('.')
                    $cfRecords += @{
                        type     = 'MX'
                        name     = $name
                        content  = $exchange
                        priority = $record.preference
                        ttl      = $ttl
                    }
                }
            }
            'TXT' {
                foreach ($record in $rs.txtRecords) {
                    # Azure splits TXT into array of values; join them
                    $value = ($record.value -join '')
                    $cfRecords += @{
                        type    = 'TXT'
                        name    = $name
                        content = $value
                        ttl     = $ttl
                    }
                }
            }
            'SRV' {
                foreach ($record in $rs.srvRecords) {
                    $target = $record.target.TrimEnd('.')
                    $cfRecords += @{
                        type = 'SRV'
                        name = $name
                        ttl  = $ttl
                        data = @{
                            priority = $record.priority
                            weight   = $record.weight
                            port     = $record.port
                            target   = $target
                        }
                    }
                }
            }
            'CAA' {
                foreach ($record in $rs.caaRecords) {
                    $cfRecords += @{
                        type = 'CAA'
                        name = $name
                        ttl  = $ttl
                        data = @{
                            flags = $record.flags
                            tag   = $record.tag
                            value = $record.value
                        }
                    }
                }
            }
            'NS' {
                # Non-apex NS records (delegations)
                foreach ($record in $rs.nsRecords) {
                    $nsdname = $record.nsdname.TrimEnd('.')
                    $cfRecords += @{
                        type    = 'NS'
                        name    = $name
                        content = $nsdname
                        ttl     = $ttl
                    }
                }
            }
            'PTR' {
                foreach ($record in $rs.ptrRecords) {
                    $ptrdname = $record.ptrdname.TrimEnd('.')
                    $cfRecords += @{
                        type    = 'PTR'
                        name    = $name
                        content = $ptrdname
                        ttl     = $ttl
                    }
                }
            }
            default {
                Write-Warning "   ⚠  Unsupported record type: $type for $name — skipping"
                $skippedCount++
            }
        }
    }

    Write-Host "   Converted $($cfRecords.Count) records, skipped $skippedCount" -ForegroundColor Green
    return $cfRecords
}

# ── Cloudflare record creator ───────────────────────────────────────────────────

function Push-RecordsToCloudflare {
    param(
        [array]$Records,
        [array]$ExistingRecords,
        [bool]$IsDryRun,
        [bool]$SkipDuplicates
    )

    $created = 0
    $skipped = 0
    $failed = 0
    $total = $Records.Count

    Write-Host "`n☁️  Pushing $total records to Cloudflare..." -ForegroundColor Cyan
    if ($IsDryRun) {
        Write-Host "   🔍 DRY RUN — no changes will be made" -ForegroundColor Yellow
    }

    for ($i = 0; $i -lt $total; $i++) {
        $rec = $Records[$i]
        $displayName = if ($rec.name -eq '@') { "$ZoneName (apex)" } else { "$($rec.name).$ZoneName" }
        $displayContent = if ($rec.content) { $rec.content } elseif ($rec.data) { ($rec.data | ConvertTo-Json -Compress) } else { '(complex)' }

        Write-Host "   [$($i+1)/$total] $($rec.type) $displayName -> $displayContent" -ForegroundColor White -NoNewline

        # Check for existing record
        if ($SkipDuplicates -and $ExistingRecords) {
            $duplicate = $ExistingRecords | Where-Object {
                $_.type -eq $rec.type -and
                (($_.name -eq $rec.name) -or ($_.name -eq "$($rec.name).$ZoneName") -or ($rec.name -eq '@' -and $_.name -eq $ZoneName)) -and
                ((-not $rec.content) -or $_.content -eq $rec.content)
            }
            if ($duplicate) {
                Write-Host " [SKIP - exists]" -ForegroundColor DarkYellow
                $skipped++
                continue
            }
        }

        if ($IsDryRun) {
            Write-Host " [DRY RUN]" -ForegroundColor Yellow
            $created++
            continue
        }

        $response = Invoke-CloudflareApi -Method 'POST' `
            -Endpoint "/zones/$CloudflareZoneId/dns_records" `
            -Body $rec

        if ($response.success) {
            Write-Host " [OK]" -ForegroundColor Green
            $created++
        }
        else {
            $errMsg = ($response.errors | ForEach-Object { $_.message }) -join '; '

            # Handle "already exists" gracefully
            if ($errMsg -match 'already exists') {
                if ($SkipDuplicates) {
                    Write-Host " [SKIP - exists]" -ForegroundColor DarkYellow
                    $skipped++
                }
                else {
                    Write-Host " [EXISTS]" -ForegroundColor Yellow
                    $skipped++
                }
            }
            else {
                Write-Host " [FAIL] $errMsg" -ForegroundColor Red
                $failed++
            }
        }
    }

    return @{
        Created = $created
        Skipped = $skipped
        Failed  = $failed
    }
}

# ── Main ────────────────────────────────────────────────────────────────────────

function Main {
    $banner = @"

╔═══════════════════════════════════════════════════════╗
║         DNS Migrator: Azure -> Cloudflare             ║
╚═══════════════════════════════════════════════════════╝
"@
    Write-Host $banner -ForegroundColor Magenta

    if ($DryRun) {
        Write-Host "🔍 DRY RUN MODE — no changes will be made to Cloudflare" -ForegroundColor Yellow
    }

    # Step 1: Read records from Azure
    $azureRecordSets = Get-AzureDnsRecords -ResourceGroup $AzureResourceGroup -Zone $ZoneName

    # Step 2: Convert to Cloudflare format
    Write-Host "`n🔄 Converting records..." -ForegroundColor Cyan
    $cfRecords = Convert-AzureToCloudflareRecords `
        -AzureRecordSets $azureRecordSets `
        -Zone $ZoneName `
        -EnableProxy $Proxied.IsPresent

    if ($cfRecords.Count -eq 0) {
        Write-Host "`n⚠  No records to migrate!" -ForegroundColor Yellow
        return
    }

    # Step 3: Show summary before pushing
    Write-Host "`n📋 Records to migrate:" -ForegroundColor Cyan
    $cfRecords | Group-Object { $_.type } | ForEach-Object {
        Write-Host "   $($_.Name): $($_.Count) record(s)" -ForegroundColor White
    }

    # Step 4: Get existing Cloudflare records (for skip-existing check)
    $existingRecords = @()
    if ($SkipExisting -and -not $DryRun) {
        Write-Host "`n📡 Fetching existing Cloudflare records..." -ForegroundColor Cyan
        $existingRecords = Get-CloudflareExistingRecords
        Write-Host "   Found $($existingRecords.Count) existing records" -ForegroundColor Gray
    }

    # Step 5: Push to Cloudflare
    $result = Push-RecordsToCloudflare `
        -Records $cfRecords `
        -ExistingRecords $existingRecords `
        -IsDryRun $DryRun.IsPresent `
        -SkipDuplicates $SkipExisting.IsPresent

    # Step 6: Summary
    Write-Host "`n═══════════════════════════════════════════════════════" -ForegroundColor Magenta
    Write-Host "📊 Migration Summary for $ZoneName" -ForegroundColor Cyan
    Write-Host "   Created: $($result.Created)" -ForegroundColor Green
    Write-Host "   Skipped: $($result.Skipped)" -ForegroundColor Yellow
    Write-Host "   Failed:  $($result.Failed)" -ForegroundColor $(if ($result.Failed -gt 0) { 'Red' } else { 'Green' })
    Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Magenta

    if ($DryRun) {
        Write-Host "`n💡 Run again without -DryRun to apply changes." -ForegroundColor Yellow
    }

    if ($result.Failed -gt 0) {
        Write-Host "`n⚠  Some records failed. Review the output above for details." -ForegroundColor Red
        exit 1
    }
}

Main
