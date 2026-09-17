$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot
& ".\.venv\Scripts\python.exe" ".\configure-key.py"
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "Restart the EduGrade server to load the credential." -ForegroundColor Yellow
