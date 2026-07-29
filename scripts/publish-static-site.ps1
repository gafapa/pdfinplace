param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("production", "test")]
    [string]$Environment,

    [switch]$AllowProduction,

    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Environment -eq "production" -and -not $AllowProduction) {
    throw "Production publishing requires -AllowProduction."
}

$deployment = switch ($Environment) {
    "production" {
        @{
            Domain = "pdfing.gallego.top"
        }
    }
    "test" {
        @{
            Domain = "test.pdfing.gallego.top"
        }
    }
}

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$serverHub = if ($env:GALLEGOTOP_SERVER_HUB) {
    $env:GALLEGOTOP_SERVER_HUB
} else {
    "D:\gallego.top"
}
$managementRoot = if ($env:GALLEGOTOP_MANAGEMENT_ROOT) {
    $env:GALLEGOTOP_MANAGEMENT_ROOT
} else {
    "D:\Otros IA\gestion_gallego_top"
}

$ageCommand = Get-Command age -ErrorAction SilentlyContinue
$ageExecutable = if ($ageCommand) {
    $ageCommand.Source
} else {
    Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\age.exe"
}

$identityPath = if ($env:GALLEGOTOP_AGE_IDENTITY) {
    $env:GALLEGOTOP_AGE_IDENTITY
} else {
    [Environment]::GetEnvironmentVariable("GALLEGOTOP_AGE_IDENTITY", "User")
}

$encryptedKeyPath = Join-Path $serverHub (
    "secrets\encrypted\ssh\primary-server-huerta-20260725.age"
)
$siteParent = Join-Path $managementRoot "static-sites\sites"
$sitePath = Join-Path $siteParent $deployment.Domain
$syncScriptPath = Join-Path $managementRoot (
    "static-sites\sync-content-on-server.sh"
)
$stageScript = Join-Path $PSScriptRoot "stage-static-site.ps1"

if (-not (Test-Path -LiteralPath $ageExecutable -PathType Leaf)) {
    throw "The age executable is unavailable."
}
if (-not $identityPath -or -not (Test-Path -LiteralPath $identityPath -PathType Leaf)) {
    throw "The configured age identity is unavailable."
}
if (-not (Test-Path -LiteralPath $encryptedKeyPath -PathType Leaf)) {
    throw "The encrypted deployment credential is unavailable."
}
if (-not (Test-Path -LiteralPath $stageScript -PathType Leaf)) {
    throw "The local staging script is unavailable."
}
if (-not (Test-Path -LiteralPath $syncScriptPath -PathType Leaf)) {
    throw "The canonical content synchronization script is unavailable."
}

if (-not $SkipBuild) {
    & $stageScript -Environment $Environment
}

if (-not (Test-Path -LiteralPath (Join-Path $sitePath "index.html") -PathType Leaf)) {
    throw "The staged site is missing index.html."
}

$resolvedSiteParent = (Resolve-Path -LiteralPath $siteParent).Path.TrimEnd("\")
$resolvedSitePath = (Resolve-Path -LiteralPath $sitePath).Path.TrimEnd("\")
if ((Split-Path -Parent $resolvedSitePath) -ne $resolvedSiteParent) {
    throw "Refusing to publish outside the registered static sites root."
}

$reparsePoints = Get-ChildItem -LiteralPath $resolvedSitePath -Recurse -Force |
    Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }
if ($reparsePoints) {
    throw "The staged site contains reparse points or symbolic links."
}

$tempBase = [System.IO.Path]::GetFullPath(
    [System.IO.Path]::GetTempPath()
).TrimEnd("\")
$tempRoot = Join-Path $tempBase (
    "pdfing-deploy-" + [guid]::NewGuid().ToString("N")
)
$keyPath = Join-Path $tempRoot "deployment-key"
$remoteStage = "/tmp/gallegotop-content-$([guid]::NewGuid().ToString("N"))"
$remoteStageCreated = $false
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (
    -not [System.IO.Path]::GetFullPath($tempRoot).StartsWith(
        "$tempBase\pdfing-deploy-",
        [System.StringComparison]::OrdinalIgnoreCase
    )
) {
    throw "Unsafe local temporary directory."
}
if ($remoteStage -notmatch "^/tmp/gallegotop-content-[0-9a-f]{32}$") {
    throw "Unsafe remote staging directory."
}

New-Item -ItemType Directory -Path $tempRoot | Out-Null
& icacls.exe $tempRoot /inheritance:r /grant:r "${currentUser}:(OI)(CI)F" |
    Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Unable to restrict the temporary directory ACL."
}

$sshOptions = @(
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-p", "2276",
    "-i", $keyPath
)

try {
    & $ageExecutable --decrypt `
        --identity $identityPath `
        --output $keyPath `
        $encryptedKeyPath
    if (
        $LASTEXITCODE -ne 0 -or
        -not (Test-Path -LiteralPath $keyPath -PathType Leaf)
    ) {
        throw "Deployment credential decryption failed."
    }

    & icacls.exe $keyPath /inheritance:r /grant:r "${currentUser}:F" |
        Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to restrict the temporary key ACL."
    }

    & ssh @sshOptions ubuntu@test.gallego.top "printf connected"
    if ($LASTEXITCODE -ne 0) {
        throw "SSH connection preflight failed."
    }

    & ssh @sshOptions ubuntu@test.gallego.top (
        "sudo -n test -d " +
        "/opt/docker/stacks/static-sites/sites/$($deployment.Domain)"
    )
    if ($LASTEXITCODE -ne 0) {
        throw "The remote site directory is unavailable."
    }

    $preflight = & ssh @sshOptions ubuntu@test.gallego.top (
        "sudo -n docker inspect static-sites --format " +
        "'{{.Id}} {{.State.Status}} " +
        "{{if .State.Health}}{{.State.Health.Status}}{{end}}'"
    )
    if ($LASTEXITCODE -ne 0) {
        throw "The remote static-sites container is unavailable."
    }
    Write-Output "preflight=$preflight"

    & ssh @sshOptions ubuntu@test.gallego.top (
        "install -d -m 700 '$remoteStage'"
    )
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to create the remote staging directory."
    }
    $remoteStageCreated = $true

    $scpOptions = @(
        "-q",
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-P", "2276",
        "-i", $keyPath
    )

    Push-Location $resolvedSiteParent
    try {
        & scp @scpOptions -r $deployment.Domain (
            "ubuntu@test.gallego.top:$remoteStage/"
        )
        if ($LASTEXITCODE -ne 0) {
            throw "Static site upload failed."
        }
    } finally {
        Pop-Location
    }

    Push-Location (Split-Path -Parent $syncScriptPath)
    try {
        & scp @scpOptions (Split-Path -Leaf $syncScriptPath) (
            "ubuntu@test.gallego.top:$remoteStage/"
        )
        if ($LASTEXITCODE -ne 0) {
            throw "Content synchronization script upload failed."
        }
    } finally {
        Pop-Location
    }

    $syncOutput = & ssh @sshOptions ubuntu@test.gallego.top (
        "sh '$remoteStage/sync-content-on-server.sh' " +
        "'$remoteStage' '$($deployment.Domain)'"
    )
    if ($LASTEXITCODE -ne 0) {
        throw "Remote atomic content synchronization failed."
    }

    $remoteStageCreated = $false
    Write-Output $syncOutput
} finally {
    if (
        $remoteStageCreated -and
        $remoteStage -match "^/tmp/gallegotop-content-[0-9a-f]{32}$" -and
        (Test-Path -LiteralPath $keyPath -PathType Leaf)
    ) {
        & ssh @sshOptions ubuntu@test.gallego.top (
            "if [ -d '$remoteStage' ]; then rm -rf -- '$remoteStage'; fi"
        ) | Out-Null
    }

    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTempRoot = (Resolve-Path -LiteralPath $tempRoot).Path
        if (
            $resolvedTempRoot.StartsWith(
                "$tempBase\pdfing-deploy-",
                [System.StringComparison]::OrdinalIgnoreCase
            )
        ) {
            [System.IO.Directory]::Delete($resolvedTempRoot, $true)
        }
    }
}
