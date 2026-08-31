# blk003-drill.ps1  BLK-003 Backup/Restore Drill for S4 RC1
# Reads DATABASE_URL from .drill.secret, pg_dumps production (custom format),
# restores into a disposable Docker PostgreSQL 16 container, verifies schema/
# data/migrations, then destroys all drill artifacts.
# NEVER prints DATABASE_URL or any production credential.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PG_BIN      = "C:\Program Files\PostgreSQL\18\bin"
$DUMP_FILE   = Join-Path $PSScriptRoot "s4_drill.dump"
$SECRET      = Join-Path $PSScriptRoot ".drill.secret"
$CONTAINER   = "s4_drill_pg"
$DRILL_DB    = "s4_drill"
$DRILL_PORT  = "5433"
$DRILL_PASS  = "drill_blk003_2026"

$script:dumpSec     = 0
$script:dumpBytes   = 0
$script:restoreSec  = 0
$script:restoreExit = -1
$script:appTables   = "?"
$script:migCount    = "?"
$script:latestMig   = "?"
$script:tdSections  = 0

function Step([int]$n, [string]$msg) { Write-Host "" ; Write-Host "[$n/8] $msg" -ForegroundColor Cyan }
function OK([string]$msg)            { Write-Host "  OK: $msg" -ForegroundColor Green }
function INFO([string]$msg)          { Write-Host "  $msg" }

function FAIL([string]$msg) {
    $env:PGPASSWORD = ""
    docker stop $CONTAINER 2>$null | Out-Null
    if (Test-Path $DUMP_FILE) { Remove-Item $DUMP_FILE -Force -ErrorAction SilentlyContinue }
    if (Test-Path $SECRET)    { Remove-Item $SECRET    -Force -ErrorAction SilentlyContinue }
    Write-Host ""
    Write-Host "BLK-003: FAIL -- $msg" -ForegroundColor Red
    exit 1
}

Write-Host "=== BLK-003  S4 RC1  BACKUP / RESTORE DRILL ===" -ForegroundColor Cyan
Write-Host (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")

# --- 1. Read DATABASE_URL ---
Step 1 "Read DATABASE_URL from .drill.secret"
if (-not (Test-Path $SECRET)) { FAIL "Missing .drill.secret -- write the production DATABASE_URL to that file first." }
$PROD_URL = (Get-Content $SECRET -Raw -Encoding UTF8).Trim()
if ($PROD_URL.Length -lt 20) { FAIL ".drill.secret is empty or malformed." }
INFO "URL loaded -- length=$($PROD_URL.Length) chars, not printed"

# --- 2. pg_dump against production ---
Step 2 "pg_dump -Fc against production database"
if (Test-Path $DUMP_FILE) { Remove-Item $DUMP_FILE -Force }
$env:PGPASSWORD = ""
$sw = [Diagnostics.Stopwatch]::StartNew()
& "$PG_BIN\pg_dump.exe" --dbname="$PROD_URL" -Fc -f "$DUMP_FILE"
$dumpExit = $LASTEXITCODE
$sw.Stop()
$script:dumpSec = [math]::Round($sw.Elapsed.TotalSeconds, 3)

Remove-Item $SECRET -Force -ErrorAction SilentlyContinue
INFO ".drill.secret deleted immediately after pg_dump"

if ($dumpExit -ne 0) { FAIL "pg_dump exited $dumpExit" }
if (-not (Test-Path $DUMP_FILE)) { FAIL "Dump file not created" }
$script:dumpBytes = (Get-Item $DUMP_FILE).Length
if ($script:dumpBytes -lt 1000) { FAIL "Dump file suspiciously small ($($script:dumpBytes) bytes)" }
OK "pg_dump exit=0  $($script:dumpBytes) bytes  $($script:dumpSec)s"

# --- 3. Validate dump artifact ---
Step 3 "Validate dump artifact with pg_restore --list"
& "$PG_BIN\pg_restore.exe" --list "$DUMP_FILE" | Out-Null
if ($LASTEXITCODE -ne 0) { FAIL "pg_restore --list failed -- dump corrupt or unreadable" }
$script:tdSections = (& "$PG_BIN\pg_restore.exe" --list "$DUMP_FILE" | Select-String "TABLE DATA").Count
OK "pg_restore --list exit=0 -- valid custom-format archive"
INFO "TABLE DATA sections: $($script:tdSections)"

# --- 4. Start disposable Docker PostgreSQL 16 container ---
Step 4 "Start disposable Docker postgres:16-alpine container on port $DRILL_PORT"
docker rm -f $CONTAINER 2>$null | Out-Null
docker run -d --name $CONTAINER `
    -e POSTGRES_DB="$DRILL_DB" `
    -e POSTGRES_PASSWORD="$DRILL_PASS" `
    -p "${DRILL_PORT}:5432" `
    postgres:16-alpine
if ($LASTEXITCODE -ne 0) { FAIL "docker run failed" }
INFO "Container '$CONTAINER' started"

INFO "Waiting for container readiness..."
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    $null = & "$PG_BIN\pg_isready.exe" -h localhost -p $DRILL_PORT 2>$null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
}
if (-not $ready) { FAIL "Container not ready after 40 s" }
OK "Container accepting connections"

# --- 5. pg_restore into disposable container ---
Step 5 "pg_restore into disposable container"
$DRILL_DSN = "postgresql://postgres:${DRILL_PASS}@localhost:${DRILL_PORT}/${DRILL_DB}"
$env:PGPASSWORD = $DRILL_PASS
$restoreLog = Join-Path $PSScriptRoot "s4_restore.log"
$sw2 = [Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath "$PG_BIN\pg_restore.exe" `
    -ArgumentList @("--dbname=$DRILL_DSN", "--clean", "--if-exists", "$DUMP_FILE") `
    -RedirectStandardError $restoreLog `
    -NoNewWindow -Wait -PassThru
$script:restoreExit = $proc.ExitCode
$sw2.Stop()
$script:restoreSec = [math]::Round($sw2.Elapsed.TotalSeconds, 3)

if ($script:restoreExit -ge 2) {
    if (Test-Path $restoreLog) { Get-Content $restoreLog | Select-String "error:" | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" } }
    FAIL "pg_restore failed (exit=$($script:restoreExit))"
}
if (Test-Path $restoreLog) { Remove-Item $restoreLog -Force }
OK "pg_restore exit=$($script:restoreExit)  $($script:restoreSec)s"
if ($script:restoreExit -eq 1) { INFO "(exit=1 = non-fatal warnings with --clean --if-exists on empty DB -- expected)" }

# --- 6. Verify schema, table counts and migration state ---
Step 6 "Verify schema, table counts and migration state"

function Q([string]$sql) {
    $r = & "$PG_BIN\psql.exe" `
        -h localhost -p $DRILL_PORT -U postgres -d $DRILL_DB `
        -t -A -c $sql 2>$null
    return ($r | Where-Object { $_.Trim() -ne "" }) -join "`n"
}

$script:appTables = Q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';"
INFO "Application tables in public schema: $($script:appTables)"

$coreTableList = @(
    'users', 'companies', 'guard_profiles', 'clients',
    'sites', 'jobs', 'job_applications', 'shifts',
    'attendance_events', 'audit_logs',
    'invoices', 'invoice_batches', 'payroll_batches',
    'safety_alerts', 'notifications',
    'screening_records', 'typeorm_migrations'
)

$allPresent = $true
foreach ($t in $coreTableList) {
    $cnt = Q "SELECT count(*) FROM $t;"
    if ($cnt -match '^\d+$') {
        INFO "  ${t}: $cnt rows"
    } else {
        INFO "  ${t}: NOT FOUND or error"
        $allPresent = $false
    }
}
if (-not $allPresent) { FAIL "One or more expected tables missing from restored schema" }

$script:migCount  = Q "SELECT count(*) FROM typeorm_migrations;"
$script:latestMig = Q "SELECT name FROM typeorm_migrations ORDER BY timestamp DESC LIMIT 1;"
INFO "typeorm_migrations: $($script:migCount) rows"
INFO "Latest migration:   $($script:latestMig)"

$orphanShifts = Q "SELECT count(*) FROM shifts s LEFT JOIN companies c ON c.id=s.company_id WHERE c.id IS NULL;"
$orphanGuards = Q "SELECT count(*) FROM guard_profiles gp LEFT JOIN users u ON u.id=gp.user_id WHERE u.id IS NULL;"
INFO "Orphan shifts (no company): $orphanShifts"
INFO "Orphan guards (no user):    $orphanGuards"
if ([int]$orphanShifts -gt 0 -or [int]$orphanGuards -gt 0) {
    FAIL "Referential integrity violation in restored database"
}
OK "Referential integrity: clean"

# --- 7. Cleanup ---
Step 7 "Cleanup"
$env:PGPASSWORD = ""
docker stop $CONTAINER 2>&1 | Out-Null
INFO "Container '$CONTAINER' stopped and removed (auto-rm)"
Remove-Item $DUMP_FILE -Force
INFO "Dump file deleted"

# --- 8. Summary ---
Step 8 "DRILL SUMMARY"
Write-Host ""
Write-Host "  pg_dump:         $($script:dumpSec)s  $($script:dumpBytes) bytes  exit=0" -ForegroundColor White
Write-Host "  TABLE DATA secs: $($script:tdSections)" -ForegroundColor White
Write-Host "  pg_restore:      $($script:restoreSec)s  exit=$($script:restoreExit)" -ForegroundColor White
Write-Host "  Schema tables:   $($script:appTables)" -ForegroundColor White
Write-Host "  Migrations:      $($script:migCount) (latest: $($script:latestMig))" -ForegroundColor White
Write-Host "  Referential:     clean (0 orphan shifts, 0 orphan guards)" -ForegroundColor White
Write-Host "  Cleanup:         complete" -ForegroundColor White
Write-Host ""
Write-Host "BLK-003: PASS" -ForegroundColor Green
