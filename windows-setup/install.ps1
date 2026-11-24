$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$finished = Join-Path $runtime 'setup-complete'
if (Test-Path -LiteralPath $finished) { return }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Setup requires Windows x64.' }

$cache = Join-Path $root '.setup'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$lock = [IO.File]::Open((Join-Path $cache 'install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $ProgressPreference = 'SilentlyContinue'
    $artifacts = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dependencies.json') -Raw | ConvertFrom-Json
    $downloads = @{}
    foreach ($artifact in $artifacts) {
        $algorithm = if ($artifact.algorithm) { $artifact.algorithm } else { 'SHA256' }
        $file = Join-Path $cache $artifact.file
        if (!(Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file -Algorithm $algorithm).Hash -ne $artifact.hash) {
            Write-Host "Downloading $($artifact.file)"
            & curl.exe --fail --location --proto '=https' --proto-redir '=https' --silent --show-error --retry 2 --max-time 600 --output $file $artifact.url
            if ($LASTEXITCODE -ne 0) { throw "Download failed for $($artifact.file). Check your network connection." }
            if ((Get-FileHash -LiteralPath $file -Algorithm $algorithm).Hash -ne $artifact.hash) {
                Remove-Item -LiteralPath $file
                throw "Checksum mismatch for $($artifact.file)."
            }
        }
        $downloads[$artifact.group] += @($file)
    }

    Write-Host 'Installing Node.js, Python, .NET, and the CAD converters...'
    $node = Join-Path $runtime 'node'
    New-Item -ItemType Directory -Path $node -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $nodeZip = [IO.Compression.ZipFile]::OpenRead($downloads.node[0])
    try {
        foreach ($entry in $nodeZip.Entries) {
            if ($entry.Name -in @('node.exe', 'LICENSE')) {
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $node $entry.Name), $true)
            }
        }
    } finally {
        $nodeZip.Dispose()
    }
    Expand-Archive -LiteralPath $downloads.python[0] -DestinationPath (Join-Path $runtime 'python') -Force
    Expand-Archive -LiteralPath $downloads.dotnet[0] -DestinationPath (Join-Path $runtime 'dotnet') -Force

    $python = Join-Path $runtime 'python\python.exe'
    $pip = "import sys, runpy; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module('pip', run_name='__main__')"
    foreach ($group in 'ocp', 'cad') {
        $target = Join-Path $root ".local-$group"
        $wheels = $downloads[$group]
        & $python -c $pip $downloads.pip[0] --isolated --disable-pip-version-check --no-color install --no-index --no-deps --no-warn-script-location --upgrade --target $target @wheels
        if ($LASTEXITCODE -ne 0) { throw "Installing the $group Python dependencies failed." }
    }
    & (Join-Path $node 'node.exe') --version
    if ($LASTEXITCODE -ne 0) { throw 'Node.js could not start.' }
    & (Join-Path $runtime 'dotnet\dotnet.exe') --list-runtimes
    if ($LASTEXITCODE -ne 0) { throw '.NET could not start.' }

    New-Item -ItemType File -Path $finished -Force | Out-Null
    foreach ($file in $downloads.Values) { Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue }
    Write-Host 'CAD Workspace setup is complete.'
} finally {
    $lock.Dispose()
}
