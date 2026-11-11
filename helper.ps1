param($role, $modeFile)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct XGP { public ushort B; public byte LT, RT; public short LX, LY, RX, RY; }
// Pad: room for the extra field the hidden XInputGetStateEx export may write
[StructLayout(LayoutKind.Sequential)] public struct XST { public uint Pk; public XGP G; public uint Pad; }
[StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
public static class N {
  [DllImport("xinput1_4.dll")] public static extern int XInputGetState(int i, out XST s);
  // Hidden export that also reports the Guide / PS button (0x0400)
  [DllImport("xinput1_4.dll", EntryPoint = "#100")] public static extern int XInputGetStateEx(int i, out XST s);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, int e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, int e);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
"@
# Work in real screen pixels (no Windows display-scaling rounding, which can freeze slow cursor moves)
[void][N]::SetProcessDPIAware()

# ---- shared input helpers ----
function Pos { $p = New-Object PT; [void][N]::GetCursorPos([ref]$p); return "$($p.X),$($p.Y)" }
function MoveCursor($dx, $dy) { $p = New-Object PT; [void][N]::GetCursorPos([ref]$p); [void][N]::SetCursorPos($p.X + [int]$dx, $p.Y + [int]$dy) }
function Btn($b, $down) {
  if ($b -eq 'r') { $fl = if ($down) { 8 } else { 16 } } else { $fl = if ($down) { 2 } else { 4 } }
  [N]::mouse_event([uint32]$fl, 0, 0, 0, 0)
}
# Arrow/navigation keys are "extended" keys; without that flag and a real scan code some sites ignore them.
$EXT = @(0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E)
function Key($vk, $alt = $false) {
  $vk = [int]$vk; $sc = [byte]([N]::MapVirtualKey([uint32]$vk, 0) -band 0xFF)
  $fl = if ($EXT -contains $vk) { 1 } else { 0 }
  if ($alt) { [N]::keybd_event(0x12, 0x38, 0, 0) }
  [N]::keybd_event([byte]$vk, $sc, [uint32]$fl, 0); [N]::keybd_event([byte]$vk, $sc, [uint32]($fl -bor 2), 0)
  if ($alt) { [N]::keybd_event(0x12, 0x38, 2, 0) }
}
function Scroll($n) { [N]::mouse_event(0x800, 0, 0, [int]$n, 0) }
# Key with modifiers, e.g. KeyCombo 'c' 0x26 = Ctrl+Up (c = Ctrl, a = Alt, s = Shift). Used for VLC's shortcuts.
function KeyCombo($mods, $vk) {
  $m = @(); if ($mods -match 'c') { $m += 0x11 }; if ($mods -match 'a') { $m += 0x12 }; if ($mods -match 's') { $m += 0x10 }
  foreach ($k in $m) { [N]::keybd_event([byte]$k, [byte]([N]::MapVirtualKey([uint32]$k, 0) -band 0xFF), 0, 0) }
  Key $vk
  [array]::Reverse($m); foreach ($k in $m) { [N]::keybd_event([byte]$k, [byte]([N]::MapVirtualKey([uint32]$k, 0) -band 0xFF), 2, 0) }
}

# Smart OK: if the cursor moved since the last arrow key, the user is pointing with the mouse,
# so OK clicks where the cursor is. If they were using arrow keys, OK presses Enter instead.
$script:arrowAt = $null
function Arrow($vk) { Key $vk; $script:arrowAt = Pos }
function Pointing { return (($null -eq $script:arrowAt) -or ((Pos) -ne $script:arrowAt)) }

if ($role -eq 'input') {
  Add-Type -AssemblyName System.Windows.Forms
  $okClick = $false
  while (($l = [Console]::In.ReadLine()) -ne $null) {
    $a = $l.Split(' ', 2)
    try {
      switch -CaseSensitive ($a[0]) {
        'm'     { $v = $a[1].Split(' '); MoveCursor $v[0] $v[1] }
        'c'     { Btn $a[1] $true; Btn $a[1] $false }
        'ld'    { Btn 'l' $true }
        'lu'    { Btn 'l' $false }
        'rd'    { Btn 'r' $true }
        'ru'    { Btn 'r' $false }
        's'     { Scroll $a[1] }
        'k'     { $vk = [int]$a[1]; if ($vk -ge 0x25 -and $vk -le 0x28) { Arrow $vk } else { Key $vk } }
        'kc'    { $v = $a[1].Split(' '); KeyCombo $v[0] ([int]$v[1]) }
        'ok'    { if (Pointing) { Btn 'l' $true; Btn 'l' $false } else { Key 0x0D } }
        'okd'   { if (Pointing) { Btn 'l' $true; $okClick = $true } else { Key 0x0D; $okClick = $false } }
        'oku'   { if ($okClick) { Btn 'l' $false; $okClick = $false } }
        'back'  { Key 0x25 $true }
        'altf4' { Key 0x73 $true }
        'osk'   { Start-Process osk.exe }
        't'     { $t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($a[1]))
                  [System.Windows.Forms.SendKeys]::SendWait(($t -replace '[+^%~(){}\[\]]', '{$0}')) }
      }
    } catch {}
  }
  exit
}

# ---- controller role: XInput (Xbox pads, PS4-style pads in Xbox mode, Steam Input, DS4Windows) ----

# Stick value -32768..32767 -> -1..1 with a dead zone and a smooth response curve.
# (Cast to [int] first: Abs() of the int16 value -32768 throws, which used to break mouse movement.)
function Stk([int]$v) {
  $a = [math]::Abs($v); $dz = 7849
  if ($a -le $dz) { return 0.0 }
  $n = [math]::Min(1.0, ($a - $dz) / (32767.0 - $dz))
  return [math]::Sign($v) * [math]::Pow($n, 1.7)
}
# Direction of a stick for menu navigation: the dominant axis wins, so diagonals don't misfire.
function StickDir([int]$x, [int]$y) {
  $ax = [math]::Abs($x); $ay = [math]::Abs($y)
  if ([math]::Max($ax, $ay) -lt 16000) { return '' }
  if ($ax -gt $ay) { if ($x -gt 0) { return 'right' } else { return 'left' } }
  if ($y -gt 0) { return 'up' } else { return 'down' }
}
function Emit($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }

# Cursor speed at full stick: about one screen width per second (scaled to the real screen)
$screenW = [N]::GetSystemMetrics(0); if ($screenW -lt 640) { $screenW = 1920 }
$SPEED = $screenW * 1.05

# Test hook (off unless TV_FAKE_PAD is set): read "buttons LX LY RX RY LT RT" from a file instead of a controller.
$fake = $env:TV_FAKE_PAD

$prev = 0; $f = 0; $mode = 'nav'; $lastDir = ''; $rep = 0; $reps = 0; $ax = 0.0; $ay = 0.0; $conn = $false
$aPrev = $false; $aClick = $false; $rtPrev = $false; $ltPrev = $false
$useEx = $true; try { $t = New-Object XST; [void][N]::XInputGetStateEx(0, [ref]$t) } catch { $useEx = $false }
$sw = [Diagnostics.Stopwatch]::StartNew(); $lastT = 0.0
while ($true) {
  Start-Sleep -Milliseconds 8
  $now = $sw.Elapsed.TotalSeconds; $dt = [math]::Min(0.05, $now - $lastT); $lastT = $now
  $nowMs = [int64]($now * 1000)
  if (($f++ % 10) -eq 0) { try { $mode = ([IO.File]::ReadAllText($modeFile)).Trim() } catch {} }

  $s = New-Object XST; $ok = $false; $g = $null
  if ($fake) {
    try { $v = ([IO.File]::ReadAllText($fake)).Trim().Split(' ')
      $g = New-Object XGP
      $g.B = [uint16]$v[0]; $g.LX = [int16]$v[1]; $g.LY = [int16]$v[2]; $g.RX = [int16]$v[3]; $g.RY = [int16]$v[4]
      $g.LT = [byte]$v[5]; $g.RT = [byte]$v[6]; $ok = $true; $gLast = $g } catch { if ($gLast) { $g = $gLast; $ok = $true } }
  } else {
    for ($i = 0; $i -lt 4; $i++) {
      $r = if ($useEx) { [N]::XInputGetStateEx($i, [ref]$s) } else { [N]::XInputGetState($i, [ref]$s) }
      if ($r -eq 0) { $ok = $true; $g = $s.G; break }
    }
  }
  if ($ok -ne $conn) { $conn = $ok; Emit ('xi ' + [int]$ok) }
  if (-not $ok) {
    if ($aClick -or $rtPrev) { Btn 'l' $false }
    $prev = 0; $aPrev = $false; $aClick = $false; $rtPrev = $false; $ltPrev = $false; $lastDir = ''
    Start-Sleep -Milliseconds 500; continue
  }
  $b = [int]$g.B
  $pr = $b -band (-bnot $prev)
  # Share / View = Control Center (inside apps it opens on top of the app). Start or Guide/PS = Home.
  if (($pr -band 0x20) -ne 0) { if ($mode -eq 'nav') { Emit 'nav quick' } else { Emit 'cc' } }
  if (($pr -band 0x410) -ne 0) { Emit 'home' }

  # Directions: D-pad and the LEFT stick (the right stick is the mouse in apps). Key-repeat speeds up while held.
  $dir = ''
  if (($b -band 1) -ne 0) { $dir = 'up' } elseif (($b -band 2) -ne 0) { $dir = 'down' }
  elseif (($b -band 4) -ne 0) { $dir = 'left' } elseif (($b -band 8) -ne 0) { $dir = 'right' }
  else { $dir = StickDir $g.LX $g.LY }
  $fire = $false
  if ($dir -ne $lastDir) { $lastDir = $dir; $reps = 0; $rep = $nowMs + 320; $fire = ($dir -ne '') }
  elseif ($dir -ne '' -and $nowMs -ge $rep) { $reps++; $rep = $nowMs + $(if ($reps -gt 4) { 70 } else { 115 }); $fire = $true }

  $a = ($b -band 0x1000) -ne 0
  if ($mode -ne 'mouse') {
    # 'nav' = TV Home, 'keys' = TV-style apps (YouTube): TV turns these into its own navigation / key presses
    if ($fire) { Emit "nav $dir" }
    if ($a -and -not $aPrev) { Emit 'nav ok' }
    if (($pr -band 0x2000) -ne 0) { Emit 'nav back' }
    if (($mode -eq 'nav' -or $mode -eq 'vlc') -and ($pr -band 0x8000) -ne 0) { Emit 'nav menu' }
    if (($mode -eq 'vlc' -or $mode -eq 'nav') -and ($pr -band 0x4000) -ne 0) { Emit 'nav sub' }
    if ($mode -eq 'keys' -or $mode -eq 'vlc') {
      if (($pr -band 0x100) -ne 0) { Key 0xAE }
      if (($pr -band 0x200) -ne 0) { Key 0xAF }
    }
  } else {
    if ($fire) { $vk = @{ up = 0x26; down = 0x28; left = 0x25; right = 0x27 }[$dir]; Arrow $vk }
    # The RIGHT stick moves the mouse (the left stick navigates); frame-time based so speed is smooth and steady
    $sx = Stk $g.RX; $sy = Stk $g.RY
    $sx = [math]::Max(-1.0, [math]::Min(1.0, $sx)); $sy = [math]::Max(-1.0, [math]::Min(1.0, $sy))
    $ax += $sx * $SPEED * $dt; $ay += -$sy * $SPEED * $dt
    $mx = [int][math]::Truncate($ax); $my = [int][math]::Truncate($ay); $ax -= $mx; $ay -= $my
    if ($mx -ne 0 -or $my -ne 0) { MoveCursor $mx $my }
    # A = smart OK (click where the cursor is, or Enter after arrow-key navigation)
    if ($a -and -not $aPrev) { if (Pointing) { Btn 'l' $true; $aClick = $true } else { Key 0x0D; $aClick = $false } }
    elseif (-not $a -and $aPrev -and $aClick) { Btn 'l' $false; $aClick = $false }
    # RT = plain left mouse button (hold to drag)
    $rt = $g.RT -gt 100
    if ($rt -and -not $rtPrev) { Btn 'l' $true } elseif (-not $rt -and $rtPrev) { Btn 'l' $false }
    $rtPrev = $rt
    $lt = ($g.LT -gt 100) -or (($b -band 0x4000) -ne 0)
    if ($lt -and -not $ltPrev) { Btn 'r' $true; Btn 'r' $false }; $ltPrev = $lt
    # B = Back (TV turns a quick double press into "close app and go Home")
    if (($pr -band 0x2000) -ne 0) { Emit 'nav back' }
    if (($pr -band 0x100) -ne 0) { Key 0xAE }
    if (($pr -band 0x200) -ne 0) { Key 0xAF }
    if (($pr -band 0x8000) -ne 0) { Start-Process osk.exe }
  }
  if ($mode -ne 'mouse') { $ax = 0.0; $ay = 0.0 }
  if ($mode -ne 'mouse' -and $rtPrev) { Btn 'l' $false; $rtPrev = $false }
  if ($mode -ne 'mouse' -and $aClick -and -not $a) { Btn 'l' $false; $aClick = $false }
  $aPrev = $a
  $prev = $b
}
