# Telegram approval-bridge shortcut — append this to your PowerShell $PROFILE
function tg-code {
  param([Parameter(Position=0)][string]$cmd, [Parameter(Position=1)][string]$sub)
  switch ($cmd) {
    'mode' {
      switch ($sub) {
        {$_ -eq '' -or $_ -eq 'status'} { node "$env:USERPROFILE\.claude\hooks\set-mode.js" status }
        'local'  { node "$env:USERPROFILE\.claude\hooks\set-mode.js" local }
        'remote' { node "$env:USERPROFILE\.claude\hooks\set-mode.js" remote }
        default  { Write-Host "Usage: tg-code mode [status|local|remote]" }
      }
    }
    'listen' {
      switch ($sub) {
        'start'    { node "$env:USERPROFILE\.claude\hooks\set-mode.js" listen-start }
        'stop'     { node "$env:USERPROFILE\.claude\hooks\set-mode.js" listen-stop }
        '--status' { node "$env:USERPROFILE\.claude\hooks\set-mode.js" listener-status }
        default    { node "$env:USERPROFILE\.claude\hooks\telegram-listener.js" }
      }
    }
    default {
      Write-Host "tg-code commands:"
      Write-Host "  mode              Show current approval mode"
      Write-Host "  mode status       Show current approval mode"
      Write-Host "  mode local        Switch to local mode (normal terminal prompts)"
      Write-Host "  mode remote       Switch to remote mode (route to Telegram)"
      Write-Host "  listen            Start the listener in the foreground (Ctrl+C to stop)"
      Write-Host "  listen start      Start the listener in the background"
      Write-Host "  listen stop       Stop the background listener"
      Write-Host "  listen --status   Show whether the listener is running"
      Write-Host "  help              Show this help"
    }
  }
}
