# UDP echo server. Bind to a port, echo every received datagram back to sender.
# Runs until Ctrl+C.
param(
    [int]$Port = 40000
)

$udp = New-Object System.Net.Sockets.UdpClient($Port)
$endpoint = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
Write-Host "[echo] listening on udp/$Port" -ForegroundColor Cyan

try {
    while ($true) {
        $bytes = $udp.Receive([ref]$endpoint)
        # echo back
        [void]$udp.Send($bytes, $bytes.Length, $endpoint)
    }
} finally {
    $udp.Close()
}
