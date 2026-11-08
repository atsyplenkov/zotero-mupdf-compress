# SPDX-License-Identifier: AGPL-3.0-or-later
# Build the Windows x64 development candidate on the Windows 2022 image.
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$native = Join-Path $root 'addon/native'
$output = Join-Path $native 'windows-x86_64'
$work = Join-Path $env:RUNNER_TEMP 'mupdf-windows-native'
$url = 'https://casper.mupdf.com/downloads/archive/mupdf-1.28.5-source.tar.gz'
$sha = '98a5c10cda20c3992cdf76ff6b2a1149c32bd79cc796d3f703230b1185b7e934'
if ($env:RUNNER_OS -ne 'Windows' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'A Windows x64 runner is required'
}
if ($env:NATIVE_SOURCE_REVISION -notmatch '^[a-f0-9]{40}$') {
    throw 'NATIVE_SOURCE_REVISION must be the checked-out commit'
}
if (Test-Path $work) { throw 'Native build work directory already exists' }
New-Item -ItemType Directory -Path $work, $output -Force | Out-Null
$trace = Join-Path $output 'build-trace.txt'
$archive = Join-Path $work 'mupdf-1.28.5-source.tar.gz'
$source = Join-Path $work 'mupdf-1.28.5-source'
Invoke-WebRequest -Uri $url -OutFile $archive
if ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant() -ne $sha) {
    throw 'MuPDF source archive digest mismatch'
}
& tar.exe -xzf $archive -C $work
if ($LASTEXITCODE -ne 0) { throw 'Could not extract MuPDF source' }
$projects = Join-Path $source 'platform/win32'
& python (Join-Path $root 'scripts/configure-windows-native.py') $projects 2>&1 | Tee-Object -FilePath $trace
if ($LASTEXITCODE -ne 0) { throw 'Windows project configuration failed' }

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installation = & $vswhere -latest -version '[17.0,18.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'Visual Studio 2022 x64 toolchain not found' }
$msbuild = Join-Path $installation 'MSBuild/Current/Bin/amd64/MSBuild.exe'
$vcvars = Join-Path $installation 'VC/Auxiliary/Build/vcvarsall.bat'
$tools = Get-ChildItem (Join-Path $installation 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$sdk = Get-ChildItem (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/Include') -Directory |
    Where-Object { $_.Name -match '^10\.0\.\d+\.0$' } | Sort-Object Name -Descending | Select-Object -First 1
if (-not $tools -or -not $sdk -or -not (Test-Path $msbuild) -or -not (Test-Path $vcvars)) {
    throw 'Visual Studio or Windows 10 SDK is incomplete'
}
$env:NATIVE_RUNNER = if ($env:ImageOS -eq 'win22') { 'windows-2022' } elseif ($env:ImageOS) { $env:ImageOS } else { 'unlabelled-windows' }
$env:NATIVE_RUNNER_VERSION = if ($env:ImageVersion) { $env:ImageVersion } else { 'unknown-local-image' }
$env:NATIVE_OS_VERSION = (Get-CimInstance Win32_OperatingSystem).Version
$env:NATIVE_MSBUILD = ((& $msbuild -nologo -version | Select-Object -Last 1).Trim())
$env:NATIVE_MSVC = $tools.Name
$env:NATIVE_SDK = $sdk.Name
# CL affects all MSBuild compiler invocations, including project references.
$env:CL = '/D_WIN32_WINNT=0x0A00 /DWINVER=0x0A00 /DNTDDI_VERSION=0x0A000000'
$solution = Join-Path $projects 'mupdf.sln'
$msbuildArguments = @(
    $solution, '/m:4', '/t:mutool', '/p:Configuration=Release', '/p:Platform=x64',
    '/p:PlatformToolset=v143', "/p:VCToolsVersion=$($tools.Name)", "/p:WindowsTargetPlatformVersion=$($sdk.Name)"
)
"MSBuild $($msbuildArguments -join ' ')" | Tee-Object -FilePath $trace -Append
& $msbuild @msbuildArguments 2>&1 | Tee-Object -FilePath $trace -Append
if ($LASTEXITCODE -ne 0) { throw 'MuPDF build failed' }
Copy-Item (Join-Path $projects 'x64/Release/mutool.exe') (Join-Path $output 'mutool.exe')

$helper = Join-Path $native 'session-lock-windows.c'
$helperOutput = Join-Path $output 'session-lock.exe'
$command = 'call "{0}" x64 {1} -vcvars_ver={2} >nul && cl /nologo /MT /O2 /W4 /D_WIN32_WINNT=0x0A00 /DWINVER=0x0A00 /DNTDDI_VERSION=0x0A000000 /Fe:"{3}" "{4}" /link Advapi32.lib' -f $vcvars, $sdk.Name, $tools.Name, $helperOutput, $helper
"cmd /d /c $command" | Tee-Object -FilePath $trace -Append
Push-Location $work
try {
    & cmd.exe /d /c $command 2>&1 | Tee-Object -FilePath $trace -Append
    if ($LASTEXITCODE -ne 0) { throw 'Windows session-lock helper build failed' }
    # The Node-only host adapter uses extra test commands, never packaged in the XPI.
    $testHost = Join-Path $work 'windows-test-host.exe'
    $testCommand = 'call "{0}" x64 {1} -vcvars_ver={2} >nul && cl /nologo /MT /O2 /W4 /DMUPDF_TEST_HOST /D_WIN32_WINNT=0x0A00 /DWINVER=0x0A00 /DNTDDI_VERSION=0x0A000000 /Fe:"{3}" "{4}" /link Advapi32.lib' -f $vcvars, $sdk.Name, $tools.Name, $testHost, $helper
    "cmd /d /c $testCommand" | Tee-Object -FilePath $trace -Append
    & cmd.exe /d /c $testCommand 2>&1 | Tee-Object -FilePath $trace -Append
    if ($LASTEXITCODE -ne 0) { throw 'Windows test host build failed' }
} finally {
    Pop-Location
}
& python (Join-Path $root 'scripts/inspect-windows-native.py') $output 2>&1 | Tee-Object -FilePath $trace -Append
if ($LASTEXITCODE -ne 0) { throw 'Windows native dependency inspection failed' }
& python (Join-Path $root 'scripts/record-windows-native.py') 2>&1 | Tee-Object -FilePath $trace -Append
if ($LASTEXITCODE -ne 0) { throw 'Windows native build recording failed' }
Write-Output "Built and recorded Windows components from $archive"
