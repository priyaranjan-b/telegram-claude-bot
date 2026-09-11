# Telegram approval-bridge shortcut — append this to ~/.bashrc
tg-code() {
  case "$1" in
    mode)
      case "$2" in
        ""|status) node ~/.claude/hooks/set-mode.js status ;;
        local)     node ~/.claude/hooks/set-mode.js local ;;
        remote)    node ~/.claude/hooks/set-mode.js remote ;;
        *) echo "Usage: tg-code mode [status|local|remote]" ;;
      esac
      ;;
    listen)
      case "$2" in
        start)    node ~/.claude/hooks/set-mode.js listen-start ;;
        stop)     node ~/.claude/hooks/set-mode.js listen-stop ;;
        --status) node ~/.claude/hooks/set-mode.js listener-status ;;
        *)        node ~/.claude/hooks/telegram-listener.js ;;
      esac
      ;;
    help|*)
      echo "tg-code commands:"
      echo "  mode              Show current approval mode"
      echo "  mode status       Show current approval mode"
      echo "  mode local        Switch to local mode (normal terminal prompts)"
      echo "  mode remote       Switch to remote mode (route to Telegram)"
      echo "  listen            Start the listener in the foreground (Ctrl+C to stop)"
      echo "  listen start      Start the listener in the background"
      echo "  listen stop       Stop the background listener"
      echo "  listen --status   Show whether the listener is running"
      echo "  help              Show this help"
      ;;
  esac
}
