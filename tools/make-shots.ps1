param(
  [string]$Exe = 'app_qml\build\release\release\StrongholdLink.exe',
  [string]$Repo = 'C:\Users\18072\Documents\deepseek-harness\default-workspace\Stronghold-Link\source'
)

# 重新生成三页 x 三分辨率的验收截图，并输出 sha256 供 asset-provenance.json 回填。
# 说明：界面改成"画布等比缩放"之后，1440x900 也要重拍，否则台账里的哈希对不上。
Set-Location $Repo
$env:PATH = "D:\Qt\6.8.3\mingw_64\bin;D:\Qt\Tools\mingw1310_64\bin;$env:PATH"
$exe = (Resolve-Path $Exe).Path

$specs = @('1440x900', '1280x720', '1024x768')
$pages = @('session', 'friends', 'setting')
$result = @()

foreach ($spec in $specs) {
  foreach ($p in $pages) {
    $png = Join-Path $Repo "app_qml\shots\$p-$spec.png"
    $lg  = Join-Path $Repo "app_qml\shots\$p-$spec.log"
    $cfg = Join-Path $env:TEMP "shl-shot-$p-$spec"
    New-Item -ItemType Directory -Force -Path $cfg | Out-Null
    $env:SHL_CONFIG_DIR = $cfg
    Remove-Item $png, $lg -ErrorAction SilentlyContinue

    $ok = $false
    for ($try = 1; $try -le 3 -and -not $ok; $try++) {
      & $exe --page $p --size $spec --grab $png --delay 4000 --log $lg 2>$null
      if ((Test-Path $png) -and (Get-Item $png).Length -gt 20000) { $ok = $true }
      else { Start-Sleep -Seconds 2 }
    }

    if ($ok) {
      $hash = (Get-FileHash $png -Algorithm SHA256).Hash.ToLower()
      $size = (Get-Item $png).Length
      $result += [pscustomobject]@{ page = $p; spec = $spec; file = "$p-$spec.png"; bytes = $size; sha256 = $hash }
      "  OK   {0,-24} {1,8} B  {2}" -f "$p-$spec.png", $size, $hash
    } else {
      "  FAIL {0,-24} 三次尝试都没出图" -f "$p-$spec.png"
    }
  }
}

"`n=== 汇总（回填 asset-provenance.json 用） ==="
$result | ForEach-Object { "  {0}  {1}  {2}" -f $_.file, $_.bytes, $_.sha256 }
