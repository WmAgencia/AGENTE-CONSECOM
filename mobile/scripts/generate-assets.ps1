param(
  [string]$Source = "C:\Users\junin\OneDrive\Desktop\favicon-VYNTRA.jpeg",
  [string]$ResDir = "C:\Projetos\opencode-samira\agenteprospector\mobile\android\app\src\main\res"
)
Add-Type -AssemblyName System.Drawing

function Save-JpegScaled {
  param([string]$OutPath, [int]$CanvasW, [int]$CanvasH, [System.Drawing.Bitmap]$Logo, [bool]$KeepBackground = $true)
  $canvas = [System.Drawing.Bitmap]::new($CanvasW, $CanvasH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  if ($KeepBackground) {
    $g.Clear([System.Drawing.Color]::White)
  }
  $scale = [Math]::Min($CanvasW / $Logo.Width, $CanvasH / $Logo.Height)
  # reserva ~18% de respiro (safe zone do adaptive icon)
  $scale = $scale * 0.64
  $w = [int]($Logo.Width * $scale); $h = [int]($Logo.Height * $scale)
  $x = [int](($CanvasW - $w) / 2); $y = [int](($CanvasH - $h) / 2)
  $g.DrawImage($Logo, $x, $y, $w, $h)
  $g.Dispose()
  $canvas.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Dispose()
}

$src = [System.Drawing.Bitmap]::new($Source)

# Recorta o conteúdo (remove borda branca)
$minX = $src.Width; $minY = $src.Height; $maxX = 0; $maxY = 0
for ($y = 0; $y -lt $src.Height; $y += 4) {
  for ($x = 0; $x -lt $src.Width; $x += 4) {
    $c = $src.GetPixel($x, $y)
    if ($c.R -lt 245 -or $c.G -lt 245 -or $c.B -lt 245) {
      if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
# padding de 2% do conteúdo
$pad = [int]((($maxX - $minX) * 0.02) + 2)
$minX = [Math]::Max(0, $minX - $pad); $minY = [Math]::Max(0, $minY - $pad)
$maxX = [Math]::Min($src.Width - 1, $maxX + $pad); $maxY = [Math]::Min($src.Height - 1, $maxY + $pad)
$cw = $maxX - $minX + 1; $ch = $maxY - $minY + 1
$crop = [System.Drawing.Bitmap]::new($cw, $ch)
$cg = [System.Drawing.Graphics]::FromImage($crop)
$cg.DrawImage($src, [System.Drawing.Rectangle]::new(0, 0, $cw, $ch), [System.Drawing.Rectangle]::new($minX, $minY, $cw, $ch), [System.Drawing.GraphicsUnit]::Pixel)
$cg.Dispose()
Write-Output "Conteudo recortado: ${cw}x${ch}"

# ---- Launcher icons legados (com fundo branco, ícone central) ----
$dpi = @{ mdpi = 48; hdpi = 72; xhdpi = 96; xxhdpi = 144; xxxhdpi = 192 }
foreach ($d in $dpi.Keys) {
  $dir = Join-Path $ResDir "mipmap-$d"
  Save-JpegScaled -OutPath (Join-Path $dir "ic_launcher.png") -CanvasW $dpi[$d] -CanvasH $dpi[$d] -Logo $crop -KeepBackground $true
  Save-JpegScaled -OutPath (Join-Path $dir "ic_launcher_round.png") -CanvasW $dpi[$d] -CanvasH $dpi[$d] -Logo $crop -KeepBackground $true
  # Foreground adaptativo (transparente, ícone central) — mesma arte
  Save-JpegScaled -OutPath (Join-Path $dir "ic_launcher_foreground.png") -CanvasW ([int]($dpi[$d] * 2.25)) -CanvasH ([int]($dpi[$d] * 2.25)) -Logo $crop -KeepBackground $false
}
Write-Output "Launcher + adaptive foreground gerados"

# ---- Splash screens (fundo branco + logo central) ----
$splash = @{ mdpi = @(320,480); hdpi = @(480,800); xhdpi = @(720,1280); xxhdpi = @(960,1600); xxxhdpi = @(1280,1920) }
foreach ($d in $splash.Keys) {
  $dir = Join-Path $ResDir "drawable-port-$d"
  Save-JpegScaled -OutPath (Join-Path $dir "splash.png") -CanvasW $splash[$d][0] -CanvasH $splash[$d][1] -Logo $crop -KeepBackground $true
  $dirL = Join-Path $ResDir "drawable-land-$d"
  Save-JpegScaled -OutPath (Join-Path $dirL "splash.png") -CanvasW $splash[$d][1] -CanvasH $splash[$d][0] -Logo $crop -KeepBackground $true
}
Save-JpegScaled -OutPath (Join-Path $ResDir "drawable\splash.png") -CanvasW 480 -CanvasH 320 -Logo $crop -KeepBackground $true
Write-Output "Splash screens gerados"

$src.Dispose(); $crop.Dispose()
Write-Output "OK"
