# Cài Whisper (whisper.cpp) chạy local cho AI Meeting Translator.
#  - Có GPU NVIDIA: bản CUDA 11.8 + thư viện cuBLAS (lấy từ gói chính thức nvidia-cublas-cu11 trên PyPI)
#  - Không có GPU NVIDIA: bản CPU
#  - Model mặc định ggml-small.bin; thêm -Turbo để tải ggml-large-v3-turbo-q5_0.bin
# Mọi file tải về đều được kiểm tra SHA-256.
# Chạy: powershell -ExecutionPolicy Bypass -File tools\install-whisper.ps1 [-Turbo] [-Cpu]
param([switch]$Turbo, [switch]$Cpu)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Join-Path $PSScriptRoot 'whisper.cpp'
$dl = Join-Path $PSScriptRoot '_download'
New-Item -ItemType Directory -Force -Path "$root\bin", "$root\models", $dl | Out-Null

$release = 'b5454' # whisper.cpp v1.9.5
$files = @{
  cuda   = @{ url = "https://github.com/ggml-org/whisper.cpp/releases/download/$release/whisper-bin-win-cuda-11.8.0-x64.zip"; sha = 'e81c86c542be6e3d7b7245392d4e1c52ab6e5c61dbe38721754bc0ab59d4d027' }
  cpu    = @{ url = "https://github.com/ggml-org/whisper.cpp/releases/download/$release/whisper-bin-x64.zip"; sha = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb' }
  cublas = @{ url = 'https://files.pythonhosted.org/packages/py3/n/nvidia-cublas-cu11/nvidia_cublas_cu11-11.11.3.6-py3-none-win_amd64.whl'; sha = '6ab12b1302bef8ac1ff4414edd1c059e57f4833abef9151683fb8f4de25900be' }
  small  = @{ url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin'; sha = '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' }
  turbo  = @{ url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'; sha = '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' }
}

function Get-Verified($key, $dest) {
  $f = $files[$key]
  if ((Test-Path $dest) -and ((Get-FileHash $dest -Algorithm SHA256).Hash -eq $f.sha)) { Write-Host "  da co: $(Split-Path $dest -Leaf)"; return }
  Write-Host "  dang tai: $($f.url)"
  & curl.exe -sSL --fail -o $dest $f.url
  if ($LASTEXITCODE -ne 0) { throw "Tai that bai: $($f.url)" }
  $hash = (Get-FileHash $dest -Algorithm SHA256).Hash
  if ($hash -ne $f.sha) { Remove-Item $dest; throw "Sai checksum cho $(Split-Path $dest -Leaf) ($hash)" }
}

# Dừng whisper-server đang chạy (nếu có) để thay được file
Get-Process whisper-server -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$root*" } | Stop-Process -Force
Start-Sleep -Milliseconds 500

$hasNvidia = -not $Cpu -and [bool](Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' })
Write-Host "1. whisper.cpp $release ($(if ($hasNvidia) { 'GPU NVIDIA - CUDA 11.8' } else { 'CPU' }))"
$zipKey = if ($hasNvidia) { 'cuda' } else { 'cpu' }
$zip = Join-Path $dl "$zipKey.zip"
Get-Verified $zipKey $zip
$tmp = Join-Path $dl 'extracted'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Expand-Archive $zip -DestinationPath $tmp
Copy-Item -Recurse -Force "$tmp\Release\*" "$root\bin\"

if ($hasNvidia) {
  Write-Host '2. Thu vien cuBLAS 11 (NVIDIA)'
  $whl = Join-Path $dl 'cublas.zip'
  Get-Verified 'cublas' $whl
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $z = [IO.Compression.ZipFile]::OpenRead($whl)
  try {
    foreach ($name in 'cublas64_11.dll', 'cublasLt64_11.dll') {
      $entry = $z.Entries | Where-Object { $_.FullName -eq "nvidia/cublas/bin/$name" }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, "$root\bin\$name", $true)
    }
  } finally { $z.Dispose() }
}

Write-Host '3. Model'
Get-Verified 'small' "$root\models\ggml-small.bin"
if ($Turbo) { Get-Verified 'turbo' "$root\models\ggml-large-v3-turbo-q5_0.bin" }

Remove-Item -Recurse -Force $dl
Write-Host "`nDa cai Whisper tai $root"
Write-Host 'Start.bat se tu khoi dong Whisper o http://127.0.0.1:8178.'
Write-Host 'Trong ung dung: Cai dat -> Speech-to-Text = Local AI, Kieu API = whisper.cpp server, Dia chi = http://127.0.0.1:8178'
