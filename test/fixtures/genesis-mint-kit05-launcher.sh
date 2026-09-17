#!/usr/bin/env bash
set -euo pipefail
umask 077
ulimit -c 0
usage() { echo 'Usage: vinos-genesis-mint [setup|start|preflight|recover] [1..100] | attach | reset' >&2; exit 2; }
[ "$#" -le 2 ] || usage
action=${1:-setup}
quantity=${2:-10}
if [[ "$action" =~ ^([1-9]|[1-9][0-9]|100)$ ]]; then
 [ "$#" -eq 1 ] || usage
 quantity=$action
 action=setup
fi
case "$action" in setup|start|preflight|recover) ;; attach|reset) [ "$#" -eq 1 ] || usage ;; *) usage ;; esac
[[ "$quantity" =~ ^([1-9]|[1-9][0-9]|100)$ ]] || usage
if [ "$(id -un)" != ssm-user ]; then echo 'Run as ssm-user in an interactive SSM session' >&2; exit 1; fi
if [ ! -t 0 ] || [ ! -t 1 ]; then echo 'An interactive terminal is required; enter the key only at the hidden prompt' >&2; exit 1; fi
if [ -L /var/lib/vinos-genesis ] || [ "$(stat -c '%a:%U' /var/lib/vinos-genesis)" != '700:ssm-user' ]; then echo 'Unsafe state directory' >&2; exit 1; fi
clean=(env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 TERM=xterm-256color)
mux=("${clean[@]}" /usr/bin/tmux -S /var/lib/vinos-genesis/public-mint.tmux -f /dev/null)
case "$action" in
 preflight|recover)
  exec "${clean[@]}" /opt/vinos-genesis/d6a907bfd6b8e8838d0a85bef8ed465ce7578a6c510e8bbd038e2aa5eac262b7/bin/vinos-genesis "$action" --quantity "$quantity" --config /opt/vinos-genesis/d6a907bfd6b8e8838d0a85bef8ed465ce7578a6c510e8bbd038e2aa5eac262b7/genesis-mint.config.json --state-dir /var/lib/vinos-genesis ;;
 attach)
  exec "${mux[@]}" attach-session -t genesis-mint ;;
 reset)
  panes=$("${mux[@]}" list-panes -s -t genesis-mint -F '#{pane_dead}') || exit 1
  if [ "$panes" != '1' ]; then echo 'Refusing reset: the mint process is running or the session has multiple panes' >&2; exit 1; fi
  # Recheck inside the tmux command queue: a concurrent reset/start must not kill a new live process.
  "${mux[@]}" if-shell -F -t genesis-mint '#{&&:#{==:#{session_windows},1},#{&&:#{==:#{window_panes},1},#{pane_dead}}}' 'kill-session -t genesis-mint' 'display-message -p "Refusing reset: session changed and is no longer a single finished pane"'
  echo 'Reset request completed. No new mint was started.'
  exit 0 ;;
esac
if "${mux[@]}" has-session -t genesis-mint 2>/dev/null; then
 echo 'Attaching to the existing mint session; action and quantity from this invocation are not applied.'
else
 echo "Starting public $action: up to $quantity NFT; minimum 1; maximum wait 48 hours."
fi
echo 'Detach with Ctrl+B, then D. Reconnect with vinos-genesis-mint attach.'
echo 'A finished pane stays visible; use vinos-genesis-mint reset before an intentional new run. No automatic restart.'
# Both interpolated values were strictly allowlisted above. The key is read by Rust inside tmux.
job="/usr/bin/tmux -S /var/lib/vinos-genesis/public-mint.tmux set-option -w -t genesis-mint remain-on-exit on && exec env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 /opt/vinos-genesis/d6a907bfd6b8e8838d0a85bef8ed465ce7578a6c510e8bbd038e2aa5eac262b7/bin/vinos-genesis $action --send --quantity $quantity --config /opt/vinos-genesis/d6a907bfd6b8e8838d0a85bef8ed465ce7578a6c510e8bbd038e2aa5eac262b7/genesis-mint.config.json --state-dir /var/lib/vinos-genesis"
exec "${mux[@]}" new-session -A -s genesis-mint "$job"
