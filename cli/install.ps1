[CmdletBinding()]
param(
    [string]$Version = "latest",
    [string]$InstallDir = "",
    [switch]$NoModifyPath,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$Repository = "sandbox0-ai/sandpi"
$LatestUrl = if ($env:SANDPI_INSTALL_LATEST_URL) {
    $env:SANDPI_INSTALL_LATEST_URL
} else {
    "https://github.com/$Repository/releases/latest/download/version.txt"
}
$ReleaseUrl = if ($env:SANDPI_INSTALL_RELEASE_URL) {
    $env:SANDPI_INSTALL_RELEASE_URL.TrimEnd("/")
} else {
    "https://github.com/$Repository/releases/download"
}

function Show-Usage {
    Write-Output @"
Install the Sandpi CLI for Windows.

Usage:
  .\install.ps1 [-Version VERSION] [-InstallDir DIRECTORY] [-NoModifyPath]

Options:
  -Version VERSION       Install a specific CLI version (for example 0.1.0).
  -InstallDir DIRECTORY  Install into DIRECTORY.
  -NoModifyPath          Do not add the install directory to the user PATH.
  -Help                  Show this help text.
"@
}

if ($Help) {
    Show-Usage
    exit 0
}

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    if ($env:LOCALAPPDATA) {
        $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\Sandpi"
    } elseif ($HOME) {
        $InstallDir = Join-Path $HOME ".local\bin"
    } else {
        throw "Could not determine a user install directory; pass -InstallDir."
    }
}

$Headers = @{
    "User-Agent" = "sandpi-installer"
}

if ($Version -eq "latest") {
    $Version = (Invoke-WebRequest -UseBasicParsing -Uri $LatestUrl -Headers $Headers).Content.Trim()
} else {
    if ($Version.StartsWith("cli/", [System.StringComparison]::Ordinal)) {
        $Version = $Version.Substring(4)
    }
    if ($Version.StartsWith("v", [System.StringComparison]::Ordinal)) {
        $Version = $Version.Substring(1)
    }
}

if ($Version -notmatch "^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$") {
    throw "Invalid CLI version: $Version"
}

$OperatingSystem = if ($env:SANDPI_INSTALL_OS) {
    $env:SANDPI_INSTALL_OS.ToLowerInvariant()
} elseif ($env:OS -eq "Windows_NT") {
    "windows"
} else {
    throw "install.ps1 supports Windows only."
}
if ($OperatingSystem -ne "windows") {
    throw "Unsupported operating system: $OperatingSystem"
}

$ArchitectureSource = if ($env:SANDPI_INSTALL_ARCH) {
    $env:SANDPI_INSTALL_ARCH
} elseif ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
} else {
    $env:PROCESSOR_ARCHITECTURE
}
switch ($ArchitectureSource.ToUpperInvariant()) {
    { $_ -in @("AMD64", "X86_64") } { $Architecture = "amd64"; break }
    { $_ -in @("ARM64", "AARCH64") } { $Architecture = "arm64"; break }
    default { throw "Supported architectures are amd64 and arm64." }
}

$Asset = "sandpi_${Version}_windows_${Architecture}.zip"
$TagSegment = [Uri]::EscapeDataString("cli/v$Version")
$TemporaryDir = Join-Path ([IO.Path]::GetTempPath()) ("sandpi-install-" + [Guid]::NewGuid().ToString("N"))
$Archive = Join-Path $TemporaryDir $Asset
$Checksums = Join-Path $TemporaryDir "checksums.txt"
$Extracted = Join-Path $TemporaryDir "extracted"
$StagedBinary = $null

try {
    New-Item -ItemType Directory -Path $TemporaryDir | Out-Null
    Invoke-WebRequest -UseBasicParsing -Headers $Headers -Uri "$ReleaseUrl/$TagSegment/checksums.txt" -OutFile $Checksums
    Invoke-WebRequest -UseBasicParsing -Headers $Headers -Uri "$ReleaseUrl/$TagSegment/$Asset" -OutFile $Archive

    $EscapedAsset = [Regex]::Escape($Asset)
    $Expected = $null
    foreach ($Line in Get-Content -LiteralPath $Checksums) {
        $Match = [Regex]::Match($Line, "^([0-9A-Fa-f]{64})\s+\*?$EscapedAsset$")
        if ($Match.Success) {
            $Expected = $Match.Groups[1].Value.ToLowerInvariant()
            break
        }
    }
    if (-not $Expected) {
        throw "checksums.txt has no valid checksum for $Asset"
    }
    $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) {
        throw "Checksum verification failed for $Asset"
    }

    Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted -Force
    $SourceBinary = Join-Path $Extracted "sandpi.exe"
    if (-not (Test-Path -LiteralPath $SourceBinary -PathType Leaf)) {
        throw "The release archive does not contain sandpi.exe"
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $StagedBinary = Join-Path $InstallDir (".sandpi." + [Guid]::NewGuid().ToString("N") + ".tmp")
    Copy-Item -LiteralPath $SourceBinary -Destination $StagedBinary
    $Destination = Join-Path $InstallDir "sandpi.exe"
    Move-Item -Force -LiteralPath $StagedBinary -Destination $Destination
    $StagedBinary = $null
    if ($env:OS -eq "Windows_NT") {
        Unblock-File -LiteralPath $Destination -ErrorAction SilentlyContinue
    }

    if (-not $NoModifyPath) {
        $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $PathEntries = @($UserPath -split ";" | Where-Object { $_ })
        if ($PathEntries -notcontains $InstallDir) {
            $UpdatedPath = (@($PathEntries) + $InstallDir) -join ";"
            [Environment]::SetEnvironmentVariable("Path", $UpdatedPath, "User")
        }
        if (($env:Path -split ";") -notcontains $InstallDir) {
            $env:Path = "$InstallDir;$env:Path"
        }
    }

    Write-Output "Installed Sandpi CLI v$Version to $Destination"
    if ($NoModifyPath) {
        Write-Output "Add $InstallDir to PATH before running sandpi."
    }
} finally {
    if ($StagedBinary -and (Test-Path -LiteralPath $StagedBinary)) {
        Remove-Item -Force -LiteralPath $StagedBinary
    }
    if (Test-Path -LiteralPath $TemporaryDir) {
        Remove-Item -Recurse -Force -LiteralPath $TemporaryDir
    }
}
