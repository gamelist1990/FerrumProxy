# UDP bench client. Sends N packets to a target host:port, times the round
# trip for each, prints percentile latency and total wall clock time.
#
# Usage:
#   .\udp_bench.ps1 -Host 127.0.0.1 -Port 40000 -Count 500 -SizeBytes 512
param(
    [string]$RemoteHost = '127.0.0.1',
    [int]$Port = 40000,
    [int]$Count = 500,
    [int]$SizeBytes = 512,
    [int]$TimeoutMs = 2000
)

$udp = New-Object System.Net.Sockets.UdpClient
$udp.Client.ReceiveTimeout = $TimeoutMs

# Ensure the client has a stable source port so PROXY-header-per-session code
# treats us as ONE peer -- this is what a real Bedrock client does too.
$udp.Client.Bind((New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)))
$targetAddr = [System.Net.Dns]::GetHostAddresses($RemoteHost)[0]
$targetEp = New-Object System.Net.IPEndPoint($targetAddr, $Port)

$payload = New-Object byte[] $SizeBytes
(New-Object System.Random).NextBytes($payload)

$latencies = New-Object System.Collections.Generic.List[double]
$lost = 0

# Warm-up: 3 packets to prime the DNS cache / socket table / etc. Not timed.
for ($i = 0; $i -lt 3; $i++) {
    try {
        [void]$udp.Send($payload, $payload.Length, $targetEp)
        $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
        [void]$udp.Receive([ref]$ep)
    } catch {}
}

$totalSw = [System.Diagnostics.Stopwatch]::StartNew()

for ($i = 0; $i -lt $Count; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        [void]$udp.Send($payload, $payload.Length, $targetEp)
        $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
        [void]$udp.Receive([ref]$ep)
        $sw.Stop()
        $latencies.Add($sw.Elapsed.TotalMilliseconds)
    } catch {
        $sw.Stop()
        $lost++
    }
}

$totalSw.Stop()
$udp.Close()

if ($latencies.Count -eq 0) {
    Write-Host 'ALL PACKETS LOST' -ForegroundColor Red
    exit 1
}

$sorted = @($latencies | Sort-Object)
function Pct($p) {
    $idx = [Math]::Floor(($sorted.Count - 1) * $p)
    return $sorted[$idx]
}

$mean = ($sorted | Measure-Object -Average).Average

# Machine-readable line at the end so the harness can parse it.
[pscustomobject]@{
    Target = "$RemoteHost`:$Port"
    Count = $Count
    Lost = $lost
    TotalMs = [Math]::Round($totalSw.Elapsed.TotalMilliseconds, 2)
    MeanMs = [Math]::Round($mean, 3)
    P50Ms = [Math]::Round((Pct 0.50), 3)
    P90Ms = [Math]::Round((Pct 0.90), 3)
    P99Ms = [Math]::Round((Pct 0.99), 3)
    MaxMs = [Math]::Round(($sorted[-1]), 3)
} | Format-List
