param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("production", "test")]
    [string]$Environment,

    [ValidateSet("pdfinplace.com")]
    [string]$Domain
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
            ExtraDomains = @("pdfinplace.com")
        }
    }
    "test" {
        @{
            BuildScript = "build:test"
            Domain = "test.pdfing.gallego.top"
            ExtraDomains = @()
        }
    }
}

if ($Domain) {
    if ($Environment -ne "production") {
        throw "A domain-specific stage is only available for production."
    }
    $deployment.Domain = $Domain
    $deployment.ExtraDomains = @()
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

if ($Domain -eq "pdfinplace.com") {
    $indexPath = Join-Path $sourcePath "index.html"
    $index = Get-Content -LiteralPath $indexPath -Raw
    $index = $index.Replace("https://pdfing.gallego.top/", "https://pdfinplace.com/")
    Set-Content -LiteralPath $indexPath -Value $index -NoNewline
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

foreach ($extraDomain in $deployment.ExtraDomains) {
    $extraPath = [System.IO.Path]::GetFullPath((Join-Path $sitesRoot $extraDomain))
    if (-not (Test-Path -LiteralPath $extraPath -PathType Container)) {
        throw "Registered site directory does not exist: $extraPath"
    }
    $resolvedExtraParent = Split-Path -Parent ((Resolve-Path -LiteralPath $extraPath).Path.TrimEnd("\"))
    if ($resolvedExtraParent -ne $resolvedSitesRoot) {
        throw "Refusing to stage outside the registered static sites root."
    }
    $resolvedExtraPath = (Resolve-Path -LiteralPath $extraPath).Path.TrimEnd("\")
    & robocopy $sourcePath $resolvedExtraPath /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -gt 7) {
        throw "Staging failed for ${extraDomain} with robocopy exit code $LASTEXITCODE."
    }
    Write-Output "Staged $Environment build for $extraDomain at $resolvedExtraPath"
}

Write-Output "Staged $Environment build for $($deployment.Domain) at $resolvedTargetPath"
