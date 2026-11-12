param(
    [string]$Out = (Join-Path $PSScriptRoot '..\assets\social-preview.png')
)

Add-Type -AssemblyName System.Drawing

$outDir = Split-Path -Parent $Out
if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$width = 1280
$height = 640
$bitmap = [System.Drawing.Bitmap]::new($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.Color]::FromArgb(13, 17, 23))

$titleFont = [System.Drawing.Font]::new('Segoe UI', 38, [System.Drawing.FontStyle]::Bold)
$subFont = [System.Drawing.Font]::new('Segoe UI', 22)
$monoFont = [System.Drawing.Font]::new('Consolas', 18)
$white = [System.Drawing.Brushes]::White
$muted = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(139, 148, 158))
$red = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(248, 81, 73))
$green = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(63, 185, 80))
$blue = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(88, 166, 255))

$graphics.DrawString('GitHub Fetcher', $titleFont, $white, 64, 56)
$graphics.DrawString('Read-only GitHub MCP for unreliable networks', $subFont, $muted, 64, 116)

$graphics.DrawString('Before', $monoFont, $muted, 64, 210)
$graphics.DrawString('403 rate limit exceeded', $monoFont, $red, 64, 246)
$graphics.DrawString('raw.githubusercontent.com -> 0.0.0.0', $monoFont, $red, 64, 280)
$graphics.DrawString('agent gives up', $monoFont, $muted, 64, 314)

$graphics.DrawString('After', $monoFont, $muted, 690, 210)
$graphics.DrawString('github_rate_limit  auth: token', $monoFont, $green, 690, 246)
$graphics.DrawString('34 tools ready', $monoFont, $green, 690, 280)
$graphics.DrawString('34 tools, one command', $monoFont, $blue, 690, 314)

$graphics.DrawString('npx -y @kurvcygnus/github-fetcher@latest init', $monoFont, $blue, 64, 520)
$graphics.DrawString('github.com/KurvCygnus/github-fetcher', $monoFont, $muted, 64, 556)

$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output "wrote $Out"
