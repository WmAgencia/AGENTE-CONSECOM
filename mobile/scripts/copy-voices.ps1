$src = "C:\Users\junin\OneDrive\Desktop\AUDIOS-ELEVENLABS"
$destMobile = "C:\Projetos\opencode-samira\agenteprospector\mobile\android\app\src\main\res\raw"
$destWeb = "C:\Projetos\opencode-samira\agenteprospector\frontend\public\audio"

if (-not (Test-Path $destMobile)) { New-Item -ItemType Directory -Force -Path $destMobile | Out-Null }
if (-not (Test-Path $destWeb)) { New-Item -ItemType Directory -Force -Path $destWeb | Out-Null }

# Chave -> padrão de correspondência no nome do arquivo
$map = @{
  'reuniao_marcada.mp3'        = 'nova reuniao agendada|reuni.o agendada|nova reuni'
  'resumo_diario.mp3'          = 'resumo diario|resumo'
  'campanha_concluida.mp3'     = 'campanha foi conclu'
  'whatsapp_desconectado.mp3'  = 'whatsapp foi desconectada|conex.o com o whatsapp'
  'reuniao_5min.mp3'           = 'cinco minutos|5 min'
  'reuniao_10min.mp3'          = 'dez minutos|10 min'
  'reuniao_15min.mp3'          = 'quinze minutos|15 min'
  'reuniao_30min.mp3'          = 'trinta minutos|30 min'
  'reuniao_1min.mp3'           = 'um minuto|1 min'
  'lead_atencao.mp3'           = 'lead precisa da sua atenc|lead precisa'
  'campanha_atencao.mp3'       = 'campanha precisa da sua atenc|campanha precisa'
  'campanha_iniciada.mp3'      = 'nova campanha foi iniciada|campanha foi iniciada'
  'reuniao_cancelada.mp3'      = 'reuni.o foi cancelada|cancelada'
  'reuniao_reagendada.mp3'     = 'reagendada'
}

$files = Get-ChildItem $src -Filter *.mp3
$found = @{}
foreach ($f in $files) {
  $matched = $null
  foreach ($key in $map.Keys) {
    if ($f.Name -match $map[$key]) { $matched = $key; break }
  }
  if ($matched) {
    Copy-Item $f.FullName (Join-Path $destMobile $matched) -Force
    Copy-Item $f.FullName (Join-Path $destWeb $matched) -Force
    $found[$matched] = $f.Name
    Write-Output ("OK  " + $matched + "  <-  " + $f.Name)
  } else {
    Write-Output ("??  SEM MATCH: " + $f.Name)
  }
}

Write-Output "---"
$files2 = Get-ChildItem $src -Filter *.mp3
Write-Output ("Total arquivos origem: " + $files2.Count + " | mapeados: " + $found.Count)
Write-Output ("Arquivos no res/raw: " + (Get-ChildItem $destMobile).Count)
Write-Output ("Arquivos no public/audio: " + (Get-ChildItem $destWeb).Count)
