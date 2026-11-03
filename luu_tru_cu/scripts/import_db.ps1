# =============================================================
# Script import lst_tphcm.sql vào PostgreSQL
# Chạy: powershell -ExecutionPolicy Bypass -File .\scripts\import_db.ps1
# =============================================================

$ErrorActionPreference = "Stop"

# Đọc biến từ .env
$envFile = Join-Path $PSScriptRoot ".." ".env"
$env_vars = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match "^\s*([^#][^=]+)=(.*)$") {
        $env_vars[$matches[1].Trim()] = $matches[2].Trim()
    }
}

$PGHOST     = $env_vars["PGHOST"]     ?? "localhost"
$PGPORT     = $env_vars["PGPORT"]     ?? "5432"
$PGDATABASE = $env_vars["PGDATABASE"] ?? "webgis"
$PGUSER     = $env_vars["PGUSER"]     ?? "postgres"
$PGPASSWORD = $env_vars["PGPASSWORD"] ?? ""

$SQL_FILE = Join-Path $PSScriptRoot ".." "lst_tphcm.sql"

Write-Host "======================================================"
Write-Host " Import lst_tphcm.sql → $PGDATABASE @ $PGHOST:$PGPORT"
Write-Host "======================================================"
Write-Host ""

# Kiểm tra psql – tìm tự động trong C:\Program Files\PostgreSQL nếu không có trong PATH
$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
    $found = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
        $psql = $found.FullName
        Write-Host "Tìm thấy psql: $psql"
    } else {
        Write-Error "Không tìm thấy 'psql'. Hãy cài PostgreSQL hoặc thêm PostgreSQL\bin vào PATH."
        exit 1
    }
} else {
    $psql = $psql.Source
}

# Set password env var
$env:PGPASSWORD = $PGPASSWORD

Write-Host "[1/3] Xóa database cũ và tạo lại..."
& psql -h $PGHOST -p $PGPORT -U $PGUSER -d postgres -c "DROP DATABASE IF EXISTS `"$PGDATABASE`";" 2>&1
& psql -h $PGHOST -p $PGPORT -U $PGUSER -d postgres -c "CREATE DATABASE `"$PGDATABASE`" ENCODING 'UTF8';" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Lỗi tạo database."
    exit 1
}

Write-Host "[2/3] Import SQL (có thể mất vài phút do file ~150MB)..."
& psql -h $PGHOST -p $PGPORT -U $PGUSER -d $PGDATABASE -f $SQL_FILE 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Lỗi import SQL."
    exit 1
}

Write-Host "[3/3] Kiểm tra bảng..."
& psql -h $PGHOST -p $PGPORT -U $PGUSER -d $PGDATABASE -c @"
SELECT 'chi_so_diem' AS bang, COUNT(*) FROM public.chi_so_diem
UNION ALL SELECT 'lst_data', COUNT(*) FROM public.lst_data
UNION ALL SELECT 'lst_forecast', COUNT(*) FROM public.lst_forecast
UNION ALL SELECT 'lst_wide', COUNT(*) FROM public.lst_wide
UNION ALL SELECT 'model_results', COUNT(*) FROM public.model_results;
"@ 2>&1

Write-Host ""
Write-Host "✅ Import hoàn tất! Khởi động lại server: npm run dev"
