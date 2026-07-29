param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("production", "test")]
    [string]$Environment
)

$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$managementRoot = if ($env:GALLEGOTOP_MANAGEMENT_ROOT) {
    $env:GALLEGOTOP_MANAGEMENT_ROOT
} else {
    "D:\Otros IA\gestion_gallego_top"
}

$deployment = switch ($Environment) {
    "production" {
        @{
            BuildScript = "build"
            Domain = "pdfing.gallego.top"
        }
    }
    "test" {
        @{
            BuildScript = "build:test"
            Domain = "test.pdfing.gallego.top"
        }
    }
}

$sitesRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $managementRoot "static-sites\sites")
)
$targetPath = [System.IO.Path]::GetFullPath(
    (Join-Path $sitesRoot $deployment.Domain)
)
$sourcePath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "dist"))

if (-not (Test-Path -LiteralPath $sitesRoot -PathType Container)) {
    throw "Static sites root does not exist: $sitesRoot"
}

if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) {
    throw "Registered site directory does not exist: $targetPath"
}

$resolvedSitesRoot = (Resolve-Path -LiteralPath $sitesRoot).Path.TrimEnd("\")
$resolvedTargetPath = (Resolve-Path -LiteralPath $targetPath).Path.TrimEnd("\")
$resolvedTargetParent = Split-Path -Parent $resolvedTargetPath

if ($resolvedTargetParent -ne $resolvedSitesRoot) {
    throw "Refusing to stage outside the registered static sites root."
}

Push-Location $projectRoot
try {
    & npm.cmd run $deployment.BuildScript
    if ($LASTEXITCODE -ne 0) {
        throw "The $($deployment.BuildScript) build failed."
    }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath (Join-Path $sourcePath "index.html") -PathType Leaf)) {
    throw "Build output is missing dist/index.html."
}

$forbiddenFiles = Get-ChildItem -LiteralPath $sourcePath -Recurse -Force -File |
    Where-Object {
        $_.Name -match "^\.env($|\.)" -or
        $_.Extension -in @(".key", ".pem", ".pfx", ".p12", ".age") -or
        $_.Name -match "^(id_rsa|id_ed25519)$"
    }

if ($forbiddenFiles) {
    $relativePaths = $forbiddenFiles |
        ForEach-Object { [System.IO.Path]::GetRelativePath($sourcePath, $_.FullName) }
    throw "Build output contains forbidden files: $($relativePaths -join ', ')"
}

& robocopy $sourcePath $resolvedTargetPath /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
$robocopyExitCode = $LASTEXITCODE

if ($robocopyExitCode -gt 7) {
    throw "Staging failed with robocopy exit code $robocopyExitCode."
}

Write-Output "Staged $Environment build for $($deployment.Domain) at $resolvedTargetPath"
