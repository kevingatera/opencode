#!/bin/sh
# Installs the daily catalog-sync LaunchAgent for this machine. Resolves all
# paths from the tool's location and the local bun, so the same tracked copy
# works on any computer. Re-running replaces the previous agent.
set -eu

dir=$(cd "$(dirname "$0")" && pwd)
bun=${OPENCODE_SYNC_BUN:-$(command -v bun || true)}
[ -n "$bun" ] || bun="$HOME/.bun/bin/bun"
[ -x "$bun" ] || { echo "bun not found; set OPENCODE_SYNC_BUN" >&2; exit 1; }

label=dev.opencode.catalog-sync
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/opencode-catalog-sync.log"

# LaunchAgents do not inherit shell profiles, so the TLS trust config must be
# passed explicitly or every fetch fails cert verification behind a local CA.
tls_env=''
for var in SSL_CERT_FILE NODE_EXTRA_CA_CERTS SSL_CERT_DIR; do
  value=$(printenv "$var" || true)
  if [ -n "$value" ]; then
    tls_env="$tls_env    <key>$var</key>
    <string>$value</string>
"
  fi
done
if [ -z "$tls_env" ] && [ -f "$HOME/.certs/ca-bundle.pem" ]; then
  tls_env="    <key>SSL_CERT_FILE</key>
    <string>$HOME/.certs/ca-bundle.pem</string>
"

fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$bun</string>
    <string>$dir/catalog-sync.ts</string>
    <string>--apply</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>8</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$log</string>
  <key>StandardErrorPath</key>
  <string>$log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
$tls_env  </dict>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart "gui/$(id -u)/$label"
echo "installed: $plist (daily 08:00 + at login; log: $log)"
