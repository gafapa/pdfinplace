param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("production")]
    [string]$Environment,
    [switch]$AllowProduction,
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (-not $AllowProduction) { throw "Production publishing requires -AllowProduction." }

$domain = "pdfinplace.com"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$serverHub = if ($env:GALLEGOTOP_SERVER_HUB) { $env:GALLEGOTOP_SERVER_HUB } else { "D:\gallego.top" }
$managementRoot = if ($env:GALLEGOTOP_MANAGEMENT_ROOT) {
    $env:GALLEGOTOP_MANAGEMENT_ROOT
} else {
    Join-Path $projectRoot ".codex\deployment"
}

. (Join-Path $serverHub "scripts\lib\server_hub.ps1")
$configuration = Get-ServerHubConfiguration -HubRoot $serverHub
Assert-RegisteredDomain -Domain $domain -HubRoot $serverHub
$ageExecutable = Resolve-AgeExecutable
$identityPath = Resolve-VaultIdentityPath -HubRoot $serverHub
$encryptedKeyPath = Resolve-CredentialEncryptedPath -CredentialId $configuration.CredentialId -HubRoot $serverHub

if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot "stage-static-site.ps1") -Environment $Environment
}
$sitesRoot = [System.IO.Path]::GetFullPath((Join-Path $managementRoot "static-sites\sites"))
$sitePath = Assert-PathWithinRoot -Path (Join-Path $sitesRoot $domain) -Root $sitesRoot
if (-not (Test-Path -LiteralPath (Join-Path $sitePath "index.html") -PathType Leaf)) {
    throw "The staged site is missing index.html."
}
Test-StaticSiteContent -SiteRoot $sitePath | Out-Null

$temporaryRoot = $null
$keyPath = $null
$sshOptions = @()
$remoteStage = "/tmp/gallegotop-content-$([guid]::NewGuid().ToString('N'))"
$remoteEndpoint = "$($configuration.User)@$($configuration.Host)"

try {
    $temporaryRoot = New-SecuredTemporaryDirectory -Prefix "pdfinplace-deploy"
    $manifestPath = Join-Path $temporaryRoot "release.sha256"
    $manifest = foreach ($file in Get-ChildItem -LiteralPath $sitePath -Recurse -Force -File | Sort-Object FullName) {
        $relativePath = $file.FullName.Substring($sitePath.Length + 1).Replace('\', '/')
        if ($relativePath -match '[\r\n\\]') { throw "Unsafe release filename." }
        "{0}  {1}" -f (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relativePath
    }
    [System.IO.File]::WriteAllText($manifestPath, ($manifest -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))

    # Credential access requires explicit user authorization under the server hub's AGENTS.md.
    $keyPath = New-TemporarySshKey -Directory $temporaryRoot -AgeExecutable $ageExecutable -IdentityPath $identityPath -EncryptedKeyPath $encryptedKeyPath
    $sshOptions = Get-SshOptions -Configuration $configuration -PrivateKeyPath $keyPath
    $scpOptions = Get-ScpOptions -Configuration $configuration -PrivateKeyPath $keyPath

    $preflight = & ssh @sshOptions $remoteEndpoint (
        "sudo -n test -d /opt/docker/stacks/static-sites/sites/$domain && " +
        "sudo -n test -f /opt/docker/stacks/static-sites/sync-content-on-server.sh && " +
        "sudo -n docker inspect static-sites --format '{{.Id}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}'"
    )
    if ($LASTEXITCODE -ne 0 -or $preflight -notmatch ' running(?: healthy)?\s*$') {
        throw "Authenticated production preflight failed."
    }
    Write-Output "preflight=$preflight"

    & ssh @sshOptions $remoteEndpoint "install -d -m 700 '$remoteStage'"
    if ($LASTEXITCODE -ne 0) { throw "Unable to create remote staging." }
    & scp @scpOptions -q -r $sitePath "${remoteEndpoint}:$remoteStage/"
    if ($LASTEXITCODE -ne 0) { throw "Static site upload failed." }
    & scp @scpOptions -q $manifestPath "${remoteEndpoint}:$remoteStage/release.sha256"
    if ($LASTEXITCODE -ne 0) { throw "Release checksum upload failed." }
    $verification = & ssh @sshOptions $remoteEndpoint (
        "cd '$remoteStage/$domain' && sha256sum --quiet -c '../release.sha256' && printf 'upload_verified=true\n'"
    )
    if ($LASTEXITCODE -ne 0) { throw "Uploaded content failed SHA-256 verification." }
    Write-Output $verification

    # Verify a dedicated rollback archive before the installed atomic sync mutates live content.
    $backupName = "pdfinplace-release-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))-$([guid]::NewGuid().ToString('N')).tar.gz"
    $backupPath = "/opt/docker/backups/static-sites/$backupName"
    $backupScript = @"
set -eu
umask 077
mkdir -p /opt/docker/backups/static-sites
 tar -czf '$backupPath' -C /opt/docker/stacks/static-sites/sites '$domain'
sha256sum '$backupPath' > '$backupPath.sha256'
sha256sum --quiet -c '$backupPath.sha256'
tar -tzf '$backupPath' >/dev/null
printf 'rollback_backup=$backupPath\nrollback_verified=true\n'
"@
    $backupScript.Replace("`r`n", "`n") | & ssh @sshOptions $remoteEndpoint "sudo -n sh -s"
    if ($LASTEXITCODE -ne 0) { throw "Rollback backup verification failed; production was not replaced." }

    & scp @scpOptions -q (Join-Path $PSScriptRoot "retain-previous-release.sh") "${remoteEndpoint}:$remoteStage/retain-previous-release.sh"
    if ($LASTEXITCODE -ne 0) { throw "Previous-release retention script upload failed." }
    & ssh @sshOptions $remoteEndpoint "sudo -n sh '$remoteStage/retain-previous-release.sh' '$remoteStage'"
    if ($LASTEXITCODE -ne 0) { throw "Previous-release retention failed; production was not replaced." }

    & ssh @sshOptions $remoteEndpoint (
        "sudo -n sh /opt/docker/stacks/static-sites/sync-content-on-server.sh '$remoteStage' '$domain'"
    )
    if ($LASTEXITCODE -ne 0) { throw "Remote atomic content synchronization failed." }

    # The installed sync may remove staging, so upload a separate verification manifest.
    & scp @scpOptions -q $manifestPath "${remoteEndpoint}:$remoteStage.sha256"
    if ($LASTEXITCODE -ne 0) { throw "Live checksum manifest upload failed." }
    $remoteVerification = @"
set -eu
cd '/opt/docker/stacks/static-sites/sites/$domain'
sha256sum --quiet -c '$remoteStage.sha256'
install -m 0600 '$remoteStage.sha256' '/opt/docker/backups/static-sites/$domain-current-release.sha256.next'
mv '/opt/docker/backups/static-sites/$domain-current-release.sha256.next' '/opt/docker/backups/static-sites/$domain-current-release.sha256'
printf 'live_content_verified=true\n'
docker inspect static-sites --format 'container_after={{.Id}} {{.State.Status}}'
"@
    $remoteVerification.Replace("`r`n", "`n") | & ssh @sshOptions $remoteEndpoint "sudo -n sh -s"
    if ($LASTEXITCODE -ne 0) { throw "Live content failed SHA-256 verification." }
} finally {
    if ($keyPath -and (Test-Path -LiteralPath $keyPath) -and $remoteStage -match '^/tmp/gallegotop-content-[0-9a-f]{32}$') {
        & ssh @sshOptions $remoteEndpoint "rm -f -- '$remoteStage.sha256'; if [ -d '$remoteStage' ]; then rm -rf -- '$remoteStage'; fi" | Out-Null
    }
    if ($temporaryRoot -and (Test-Path -LiteralPath $temporaryRoot)) {
        $safeRoot = Assert-PathWithinRoot -Path $temporaryRoot -Root ([System.IO.Path]::GetTempPath())
        Remove-Item -LiteralPath $safeRoot -Recurse -Force
    }
}
