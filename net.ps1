# TV network helper: Wi-Fi (netsh) and Bluetooth (Windows Runtime) without opening Windows Settings.
# Usage: powershell -File net.ps1 <command> [arg]   (wifi-connect reads {"ssid","password","auth"} JSON from stdin)
# Always prints one line of JSON.
param($cmd, $arg)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Out($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Depth 5 -Compress)); exit 0 }
function Fail($msg) { Out @{ error = $msg } }
function Val($line) { ($line -split ':', 2)[1].Trim() }

# ---------------- Sound output (Windows default speaker) ----------------
function InitAudio {
  if ('TvAudio' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
[StructLayout(LayoutKind.Sequential)] public struct TvPropKey { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit)] public struct TvPropVar { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(8)] public long l; }
[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITvPropStore { int GetCount(out int c); int GetAt(int i, out TvPropKey k); int GetValue(ref TvPropKey k, out TvPropVar v); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITvDevice { int Activate(ref Guid iid, int ctx, IntPtr p, out IntPtr o); int OpenPropertyStore(int access, out ITvPropStore ps); int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); int GetState(out int s); }
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITvDeviceList { int GetCount(out int c); int Item(int i, out ITvDevice d); }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITvEnum { int EnumAudioEndpoints(int flow, int mask, out ITvDeviceList l); int GetDefaultAudioEndpoint(int flow, int role, out ITvDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class TvEnumCls {}
[ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITvPolicy { int A(); int B(); int C(); int D(); int E(); int F(); int G(); int H(); int I(); int J();
  int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role); }
[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] public class TvPolicyCls {}
public static class TvAudio {
  public static List<string[]> List() {
    var r = new List<string[]>(); var e = (ITvEnum)new TvEnumCls();
    string def = ""; ITvDevice dd; if (e.GetDefaultAudioEndpoint(0, 1, out dd) == 0 && dd != null) dd.GetId(out def);
    ITvDeviceList l; e.EnumAudioEndpoints(0, 1, out l); int n; l.GetCount(out n);
    var key = new TvPropKey(); key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); key.pid = 14;
    for (int i = 0; i < n; i++) {
      ITvDevice d; l.Item(i, out d); string id; d.GetId(out id); string name = id;
      ITvPropStore ps; if (d.OpenPropertyStore(0, out ps) == 0) { TvPropVar v; if (ps.GetValue(ref key, out v) == 0 && v.vt == 31) name = Marshal.PtrToStringUni(v.p); }
      r.Add(new string[] { id, name, id == def ? "1" : "0" });
    }
    return r;
  }
  public static int Set(string id) { var p = (ITvPolicy)new TvPolicyCls(); int h = 0; for (int role = 0; role < 3; role++) h |= p.SetDefaultEndpoint(id, role); return h; }
}
'@
}

# ---------------- Wi-Fi ----------------
function WifiStatus {
  $o = netsh wlan show interfaces 2>&1 | Out-String
  if ($o -match 'There is no wireless interface') { return @{ adapter = $false } }
  if ($o -match 'location') { return @{ adapter = $true; location = $false } }
  $s = @{ adapter = $true; location = $true; connected = $false }
  foreach ($l in ($o -split "`r?`n")) {
    if ($l -match '^\s+State\s+:') { $s.connected = (Val $l) -eq 'connected' }
    elseif ($l -match '^\s+SSID\s+:') { $s.ssid = Val $l }
    elseif ($l -match '^\s+Signal\s+:') { $s.signal = [int]((Val $l) -replace '\D') }
  }
  return $s
}
function WifiScan {
  $o = netsh wlan show networks mode=bssid 2>&1 | Out-String
  if ($o -match 'location') { return @{ location = $false; networks = @() } }
  $known = @(netsh wlan show profiles 2>&1 | Where-Object { $_ -match 'All User Profile\s+:' } | ForEach-Object { Val $_ })
  $nets = @(); $cur = $null
  foreach ($l in ($o -split "`r?`n")) {
    if ($l -match '^SSID \d+ :') { if ($cur -and $cur.ssid) { $nets += $cur }; $cur = @{ ssid = Val $l; signal = 0; auth = '' } }
    elseif ($cur -and $l -match '^\s+Authentication\s+:') { $cur.auth = Val $l }
    elseif ($cur -and $l -match '^\s+Signal\s+:') { $sg = [int]((Val $l) -replace '\D'); if ($sg -gt $cur.signal) { $cur.signal = $sg } }
  }
  if ($cur -and $cur.ssid) { $nets += $cur }
  foreach ($n in $nets) { $n.known = $known -contains $n.ssid; $n.open = $n.auth -eq 'Open' }
  return @{ location = $true; networks = @($nets | Sort-Object { -$_.signal }) }
}
function Esc($s) { [Security.SecurityElement]::Escape($s) }
function WifiConnect {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $ssid = [string]$req.ssid; $pw = [string]$req.password; $auth = [string]$req.auth
  if (-not $ssid) { Fail 'No network name' }
  $known = @(netsh wlan show profiles 2>&1 | Where-Object { $_ -match 'All User Profile\s+:' } | ForEach-Object { Val $_ })
  if ($pw -or -not ($known -contains $ssid)) {
    $a = if ($auth -match 'WPA3') { 'WPA3SAE' } elseif ($auth -eq 'Open') { 'open' } else { 'WPA2PSK' }
    $key = if ($a -eq 'open') { '<authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption>' }
      else { "<authEncryption><authentication>$a</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption><sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>$(Esc $pw)</keyMaterial></sharedKey>" }
    $xml = "<?xml version=`"1.0`"?><WLANProfile xmlns=`"http://www.microsoft.com/networking/WLAN/profile/v1`"><name>$(Esc $ssid)</name><SSIDConfig><SSID><name>$(Esc $ssid)</name></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>auto</connectionMode><MSM><security>$key</security></MSM></WLANProfile>"
    $tmp = Join-Path $env:TEMP ('tvwifi-' + [guid]::NewGuid().ToString('N') + '.xml')
    try { [IO.File]::WriteAllText($tmp, $xml); $r = netsh wlan add profile filename="$tmp" user=current 2>&1 | Out-String }
    finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    if ($r -notmatch 'is added') { Fail 'Could not save this network' }
  }
  netsh wlan connect name="$ssid" ssid="$ssid" 2>&1 | Out-Null
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 750; $s = WifiStatus; if ($s.connected -and $s.ssid -eq $ssid) { Out @{ ok = $true; ssid = $ssid } } }
  if ($pw) { netsh wlan delete profile name="$ssid" 2>&1 | Out-Null }
  Fail 'Could not connect. Check the password and try again.'
}

# ---------------- Bluetooth (Windows Runtime) ----------------
function InitWinRT {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  [void][Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
  [void][Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
  [void][Windows.Devices.Bluetooth.BluetoothDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
  [void][Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
}
function Await($op, [Type]$t) { $task = $script:asTask.MakeGenericMethod($t).Invoke($null, @($op)); [void]$task.Wait(-1); $task.Result }
function BtRadio {
  [void](Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus]))
  $all = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
  return ($all | Where-Object { $_.Kind -eq 'Bluetooth' } | Select-Object -First 1)
}
$PROPS = [System.Collections.Generic.List[string]]@('System.Devices.Aep.IsConnected', 'System.Devices.Aep.IsPaired', 'System.Devices.Aep.Category')
function Find($selector) {
  $kind = [Windows.Devices.Enumeration.DeviceInformationKind]::AssociationEndpoint
  $col = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector, $PROPS, $kind)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
  return @($col | Where-Object { $_.Name } | ForEach-Object {
    $cat = ''; try { $cat = ($_.Properties['System.Devices.Aep.Category'] -join ' ') } catch {}
    @{ id = $_.Id; name = $_.Name; connected = [bool]$_.Properties['System.Devices.Aep.IsConnected']; paired = [bool]$_.Pairing.IsPaired; canPair = [bool]$_.Pairing.CanPair; kind = $cat }
  })
}
function BtStatus {
  $r = BtRadio
  if (-not $r) { return @{ adapter = $false } }
  $on = $r.State -eq 'On'
  $dev = if ($on) { @(Find ([Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelectorFromPairingState($true))) + @(Find ([Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromPairingState($true))) } else { @() }
  $seen = @{}; $list = @(); foreach ($d in $dev) { if (-not $seen[$d.name]) { $seen[$d.name] = 1; $list += $d } }
  return @{ adapter = $true; on = $on; devices = $list }
}

try {
  switch ($cmd) {
    'audio-list'      { InitAudio; $l = [TvAudio]::List()
                        Out @{ devices = @($l | ForEach-Object { @{ id = $_[0]; name = $_[1]; def = ($_[2] -eq '1') } }) } }
    'audio-set'       { if ("$arg" -notmatch '^\{[0-9.]+\}\.\{[0-9a-fA-F-]{36}\}$') { Fail 'bad device' }
                        InitAudio; $h = [TvAudio]::Set($arg); Out @{ ok = ($h -eq 0) } }
    'wifi-status'     { Out (WifiStatus) }
    'wifi-scan'       { netsh wlan show networks 2>&1 | Out-Null; Out (WifiScan) }
    'wifi-connect'    { WifiConnect }
    'wifi-disconnect' { netsh wlan disconnect 2>&1 | Out-Null; Out @{ ok = $true } }
    'wifi-forget'     { netsh wlan delete profile name="$arg" 2>&1 | Out-Null; Out @{ ok = $true } }
    'bt-status'       { InitWinRT; Out (BtStatus) }
    'bt-power'        { InitWinRT; $r = BtRadio; if (-not $r) { Fail 'No Bluetooth adapter' }
                        $st = if ($arg -eq 'on') { [Windows.Devices.Radios.RadioState]::On } else { [Windows.Devices.Radios.RadioState]::Off }
                        $res = Await ($r.SetStateAsync($st)) ([Windows.Devices.Radios.RadioAccessStatus]); Out @{ ok = ("$res" -eq 'Allowed') } }
    'bt-scan'         { InitWinRT
                        $d = @(Find ([Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelectorFromPairingState($false))) + @(Find ([Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromPairingState($false)))
                        $seen = @{}; $list = @(); foreach ($x in $d) { if (-not $seen[$x.name] -and $x.canPair) { $seen[$x.name] = 1; $list += $x } }
                        Out @{ devices = $list } }
    'bt-pair'         { InitWinRT
                        $di = Await ([Windows.Devices.Enumeration.DeviceInformation]::CreateFromIdAsync($arg)) ([Windows.Devices.Enumeration.DeviceInformation])
                        $res = Await ($di.Pairing.PairAsync()) ([Windows.Devices.Enumeration.DevicePairingResult])
                        $s = "$($res.Status)"; Out @{ ok = ($s -eq 'Paired' -or $s -eq 'AlreadyPaired'); status = $s } }
    'bt-unpair'       { InitWinRT
                        $di = Await ([Windows.Devices.Enumeration.DeviceInformation]::CreateFromIdAsync($arg)) ([Windows.Devices.Enumeration.DeviceInformation])
                        $res = Await ($di.Pairing.UnpairAsync()) ([Windows.Devices.Enumeration.DeviceUnpairingResult])
                        Out @{ ok = ("$($res.Status)" -eq 'Unpaired' -or "$($res.Status)" -eq 'AlreadyUnpaired'); status = "$($res.Status)" } }
    default           { Fail 'unknown command' }
  }
} catch { Fail ($_.Exception.Message -split "`n")[0] }
