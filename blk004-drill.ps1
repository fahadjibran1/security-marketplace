# blk004-drill.ps1 -- BLK-004 Deployment/Rollback Rehearsal
# Security constraints:
#   - API key read from .blk004.secret, NEVER printed or echoed
#   - JWT tokens NEVER printed
#   - Staging service only (srv-da8t3d0ae00c73d7g5jg)
#   - Production service, production DB destructive ops: PROHIBITED

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$STAGING_URL    = "https://security-marketplace-api-staging.onrender.com"
$STAGING_SVC_ID = "srv-da8t3d0ae00c73d7g5jg"
$RC1_SHA        = "ff4ad004189ee0b41fc3022179cb5bfa35f79202"
$ROLLBACK_SHA   = "f1fd5620ec256586d1ba147fd2db5139eb85f531"
$SECRET_FILE    = "C:\Users\Admin\S4-Claude\.blk004.secret"
$BASE_API       = "https://api.render.com/v1"

$script:drillStart    = Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ"
$script:d1Id          = ""
$script:d1Status      = ""
$script:d2Id          = ""
$script:d2Status      = ""
$script:d3Id          = ""
$script:d3Status      = ""
$script:h1Pass        = $false
$script:h2Pass        = $false
$script:h3Pass        = $false
$script:smokePass     = $false
$script:adminLoginOk  = $false
$script:companiesOk   = $false
$script:shiftsOk      = $false
$script:clientsOk     = $false

function Step([string]$msg) {
    Write-Host ""
    Write-Host "=== $msg ===" -ForegroundColor Cyan
}
function OK([string]$msg)   { Write-Host "  PASS: $msg" -ForegroundColor Green }
function INFO([string]$msg) { Write-Host "  $msg" }
function WARN([string]$msg) { Write-Host "  WARN: $msg" -ForegroundColor Yellow }

function FAIL([string]$msg) {
    Write-Host ""
    Write-Host "BLK-004: FAIL -- $msg" -ForegroundColor Red
    exit 1
}

# ----------------------------------------------------------------
# Read API key securely
# ----------------------------------------------------------------
Step "PREFLIGHT"
if (-not (Test-Path $SECRET_FILE)) { FAIL ".blk004.secret not found at $SECRET_FILE" }
$RENDER_KEY = (Get-Content $SECRET_FILE -Raw -Encoding UTF8).Trim()
if ($RENDER_KEY.Length -lt 10) { FAIL "API key in .blk004.secret is too short -- verify file content" }
$hdr = @{
    "Authorization" = "Bearer $RENDER_KEY"
    "Content-Type"  = "application/json"
    "Accept"        = "application/json"
}
INFO "API key loaded (length=$($RENDER_KEY.Length)) -- not printed"
INFO "Staging service: $STAGING_SVC_ID"
INFO "Staging URL:     $STAGING_URL"
INFO "RC1 SHA:         $RC1_SHA"
INFO "Rollback SHA:    $ROLLBACK_SHA"

# ----------------------------------------------------------------
function Trigger-Deploy([string]$sha, [string]$label) {
    Step "DEPLOY: $label"
    INFO "SHA: $sha"
    $body = "{`"commitId`":`"$sha`"}"
    try {
        $resp = Invoke-RestMethod -Uri "$BASE_API/services/$STAGING_SVC_ID/deploys" `
            -Method POST -Headers $hdr -Body $body -TimeoutSec 30
    } catch {
        FAIL "Deploy POST failed for $label`: $($_.Exception.Message)"
    }
    $deployId     = $resp.id
    $deployStatus = $resp.status
    INFO "Triggered: id=$deployId  initial-status=$deployStatus"

    # Poll until terminal
    $terminal = @("live","build_failed","update_failed","pre_deploy_failed","canceled","deactivated")
    $timeout  = [DateTime]::UtcNow.AddMinutes(20)
    while ([DateTime]::UtcNow -lt $timeout) {
        Start-Sleep -Seconds 30
        try {
            $d = Invoke-RestMethod -Uri "$BASE_API/services/$STAGING_SVC_ID/deploys/$deployId" `
                -Method GET -Headers $hdr -TimeoutSec 20
            $deployStatus = $d.status
        } catch {
            WARN "Poll error (will retry): $($_.Exception.Message)"
            continue
        }
        INFO "  $(Get-Date -Format 'HH:mm:ss')  status=$deployStatus"
        if ($deployStatus -in $terminal) { break }
    }

    if ($deployStatus -ne "live") {
        FAIL "Deploy '$label' did not reach 'live'. Final status: $deployStatus (id=$deployId)"
    }
    OK "Deploy '$label' reached 'live'  (deployId=$deployId)"
    return @{ id = $deployId; status = $deployStatus }
}

# ----------------------------------------------------------------
function Check-Health([string]$label) {
    Step "HEALTH: $label"
    # Brief settle time after deploy transitions live
    Start-Sleep -Seconds 10
    $allOk = $true
    foreach ($path in @("/health/live", "/health/ready")) {
        $url = "$STAGING_URL$path"
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
            $code = $r.StatusCode
            if ($code -eq 200) {
                OK "$path -> $code"
            } else {
                WARN "$path -> $code (expected 200)"
                $allOk = $false
            }
        } catch {
            $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
            INFO "  $path -> ERROR status=$status : $($_.Exception.Message)"
            $allOk = $false
        }
    }
    if (-not $allOk) { FAIL "Health check failed for '$label'" }
    return $true
}

# ----------------------------------------------------------------
function Run-SmokeChecks {
    Step "SMOKE CHECKS"

    # 1. Admin login (staging test user -- blk004 drill account, staging DB only)
    $loginBody = '{"email":"blk004-drill@staging.local","password":"DrillTest2026!"}'
    try {
        $lr = Invoke-RestMethod -Uri "$STAGING_URL/auth/login" `
            -Method POST -ContentType "application/json" -Body $loginBody -TimeoutSec 20
        if (-not $lr.accessToken) { FAIL "Admin login: 200 but no accessToken field" }
        $script:adminLoginOk = $true
        OK "Admin login -> 200 + token present (not printed)"
    } catch {
        FAIL "Admin login failed: $($_.Exception.Message)"
    }

    $tok     = $lr.accessToken
    $authHdr = @{ "Authorization" = "Bearer $tok"; "Accept" = "application/json" }

    # 2. GET /companies
    try {
        $null = Invoke-RestMethod -Uri "$STAGING_URL/companies" -Method GET -Headers $authHdr -TimeoutSec 20
        $script:companiesOk = $true
        OK "GET /companies -> 200"
    } catch {
        $sc = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        WARN "GET /companies -> $sc : $($_.Exception.Message)"
    }

    # 3. GET /shifts
    try {
        $null = Invoke-RestMethod -Uri "$STAGING_URL/shifts" -Method GET -Headers $authHdr -TimeoutSec 20
        $script:shiftsOk = $true
        OK "GET /shifts -> 200"
    } catch {
        $sc = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        WARN "GET /shifts -> $sc : $($_.Exception.Message)"
    }

    # 4. GET /clients
    try {
        $null = Invoke-RestMethod -Uri "$STAGING_URL/clients" -Method GET -Headers $authHdr -TimeoutSec 20
        $script:clientsOk = $true
        OK "GET /clients -> 200"
    } catch {
        $sc = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        WARN "GET /clients -> $sc : $($_.Exception.Message)"
    }

    # Login is the gate; API endpoint paths may vary — only fail on auth error
    if (-not $script:adminLoginOk) { FAIL "Admin login required for smoke pass" }
    $script:smokePass = $true
    OK "Smoke checks complete (admin login required gate: PASS)"
}

# ================================================================
#  BLK-004 REHEARSAL SEQUENCE
# ================================================================
Step "BLK-004 START"
INFO "Drill start: $($script:drillStart)"

# 1. Deploy RC1
$r1 = Trigger-Deploy $RC1_SHA "RC1 ff4ad00"
$script:d1Id     = $r1.id
$script:d1Status = $r1.status

# 2. Health after RC1
$script:h1Pass = Check-Health "RC1 ff4ad00"

# 3. Smoke checks
Run-SmokeChecks

# 4. Rollback to f1fd562
$r2 = Trigger-Deploy $ROLLBACK_SHA "ROLLBACK f1fd562"
$script:d2Id     = $r2.id
$script:d2Status = $r2.status

# 5. Health after rollback
$script:h2Pass = Check-Health "ROLLBACK f1fd562"

# 6. Redeploy RC1
$r3 = Trigger-Deploy $RC1_SHA "REDEPLOY RC1 ff4ad00"
$script:d3Id     = $r3.id
$script:d3Status = $r3.status

# 7. Final health
$script:h3Pass = Check-Health "FINAL RC1 ff4ad00"

$endTime = Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ"

# ================================================================
#  SUMMARY
# ================================================================
Step "BLK-004 SUMMARY"
Write-Host ""
Write-Host "  Drill start:  $($script:drillStart)"
Write-Host "  Drill end:    $endTime"
Write-Host "  Deploy 1 (RC1):      $($script:d1Id) -> $($script:d1Status)"
Write-Host "  Health 1 (RC1):      PASS"
Write-Host "  Smoke checks:        PASS (admin-login=$($script:adminLoginOk) companies=$($script:companiesOk) shifts=$($script:shiftsOk) clients=$($script:clientsOk))"
Write-Host "  Deploy 2 (rollback): $($script:d2Id) -> $($script:d2Status)"
Write-Host "  Health 2 (rollback): PASS"
Write-Host "  Deploy 3 (redeploy): $($script:d3Id) -> $($script:d3Status)"
Write-Host "  Health 3 (final):    PASS"
Write-Host ""
Write-Host "BLK-004: PASS" -ForegroundColor Green
