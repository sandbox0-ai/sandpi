export const ENVIRONMENT_BROWSER_PROFILE_PATH =
  "/workspace/.sandpi/browser/profile";
export const ENVIRONMENT_BROWSER_HUMAN_LOCK_PATH =
  "/workspace/.sandpi/browser/human-owner";

export const PLAYWRIGHT_CLI_ENVIRONMENT = {
  HOME: "/workspace",
  PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright",
  PLAYWRIGHT_MCP_BROWSER: "chromium",
  PLAYWRIGHT_MCP_ISOLATED: "false",
  PLAYWRIGHT_MCP_SANDBOX: "false",
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  NO_UPDATE_NOTIFIER: "1",
} as const;

const DASHBOARD_READY_SCRIPT = String.raw`
const net = require("node:net");

const port = Number(process.argv[1]);
const deadline = Date.now() + 30_000;
const connect = () => {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.once("connect", () => {
    socket.end();
    process.exit(0);
  });
  socket.once("error", () => {
    socket.destroy();
    if (Date.now() >= deadline) process.exit(1);
    setTimeout(connect, 25);
  });
};
connect();
`;

const VNC_WEBSOCKET_BRIDGE_SCRIPT = String.raw`
const net = require("node:net");
const { WebSocketServer, WebSocket } = require("/opt/coding-agents/node_modules/ws");

const listenPort = Number(process.argv[1]);
const vncPort = Number(process.argv[2]);
const maximumBufferedBytes = 8 * 1024 * 1024;
const server = new WebSocketServer({
  host: "0.0.0.0",
  port: listenPort,
  perMessageDeflate: false,
});

server.on("connection", (socket, request) => {
  if (request.url !== "/vnc") {
    socket.close(1008, "Unknown browser transport");
    return;
  }

  const upstream = net.connect({ host: "127.0.0.1", port: vncPort });
  const close = () => {
    upstream.destroy();
    if (socket.readyState === WebSocket.OPEN) socket.close();
  };
  upstream.on("data", (data) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > maximumBufferedBytes) {
      socket.close(1009, "Browser transport queue exceeded");
      upstream.destroy();
      return;
    }
    socket.send(data, { binary: true }, (error) => {
      if (error) close();
    });
  });
  upstream.once("error", close);
  upstream.once("close", () => {
    if (socket.readyState === WebSocket.OPEN) socket.close();
  });
  socket.on("message", (data) => {
    if (!upstream.destroyed) upstream.write(data);
  });
  socket.once("error", close);
  socket.once("close", () => upstream.destroy());
});
`;

const encoded = (value: string) =>
  Buffer.from(value, "utf8").toString("base64");

export const PLAYWRIGHT_DASHBOARD_READY_SCRIPT_BASE64 = encoded(
  DASHBOARD_READY_SCRIPT,
);
export const VNC_WEBSOCKET_BRIDGE_SCRIPT_BASE64 = encoded(
  VNC_WEBSOCKET_BRIDGE_SCRIPT,
);

export function playwrightDashboardStartScript(port: number) {
  return String.raw`set -eu
profile=${ENVIRONMENT_BROWSER_PROFILE_PATH}
human_lock=${ENVIRONMENT_BROWSER_HUMAN_LOCK_PATH}
mkdir -p "$(dirname "$profile")"
rm -f "$human_lock"

recover_profile() {
  node -e 'eval(Buffer.from(process.env.SANDPI_PLAYWRIGHT_LOCK_RECOVERY_SCRIPT_BASE64, "base64").toString("utf8"))' "$1"
}

migrate_legacy_profile() {
  test -e "$profile" && return 0
  legacy="$(find /workspace/.cache/ms-playwright/daemon -mindepth 2 -maxdepth 2 -type d -name ud-default-chrome-for-testing 2>/dev/null | head -n 1)"
  test -n "$legacy" || return 0
  playwright-cli close >/dev/null 2>&1 || true
  attempts=0
  while :; do
    recovery_status=0
    recover_profile "$legacy" || recovery_status="$?"
    test "$recovery_status" -eq 12 || break
    test "$attempts" -lt 40
    sleep 0.25
    attempts=$((attempts + 1))
  done
  test "$recovery_status" -eq 0 || return 1
  mv "$legacy" "$profile"
}

ensure_browser() {
  playwright-cli tab-list >/dev/null 2>&1 && return 0
  if test -d "$profile"; then
    recovery_status=0
    recover_profile "$profile" || recovery_status="$?"
    test "$recovery_status" -eq 0 || return 1
  else
    test ! -e "$profile" || return 1
  fi
  browser_error="$(playwright-cli open about:blank --browser chromium --profile="$profile" 2>&1)" && return 0
  printf '%s\n' "$browser_error" >&2
  recovery_status=0
  recover_profile "$profile" || recovery_status="$?"
  test "$recovery_status" -eq 0 || return 1
  playwright-cli open about:blank --browser chromium --profile="$profile"
}

wait_for_dashboard() {
  node -e 'eval(Buffer.from(process.env.SANDPI_PLAYWRIGHT_DASHBOARD_READY_SCRIPT_BASE64, "base64").toString("utf8"))' "$1"
}

migrate_legacy_profile
prewarm_browser() {
  wait_for_dashboard ${port} || return 1
  until ensure_browser; do sleep 0.25; done
  while :; do
    sleep 15
    ensure_browser || true
  done
}
prewarm_browser &
exec playwright-cli show --host 0.0.0.0 --port ${port}`;
}

export function humanBrowserStartScript(port: number) {
  return String.raw`set -eu
profile=${ENVIRONMENT_BROWSER_PROFILE_PATH}
human_lock=${ENVIRONMENT_BROWSER_HUMAN_LOCK_PATH}
browser_user="${"${SANDPI_BROWSER_USER:-sandbox-browser}"}"
display=:99
vnc_port=5900
pids=""

stop_process() {
  pid="$1"
  kill "$pid" 2>/dev/null || true
  attempts=0
  while kill -0 "$pid" 2>/dev/null && test "$attempts" -lt 50; do
    state="$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true)"
    test "$state" != Z || break
    sleep 0.1
    attempts=$((attempts + 1))
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM HUP
  for pid in $pids; do stop_process "$pid"; done
  sync -f /workspace 2>/dev/null || sync
}
trap cleanup EXIT INT TERM HUP

mkdir -p "$(dirname "$profile")"
chmod 711 "$(dirname "$(dirname "$profile")")" "$(dirname "$profile")"
install -m 600 /dev/null "$human_lock"
playwright-cli close >/dev/null 2>&1 || true
mkdir -p "$profile"
test ! -L "$profile"
attempts=0
while :; do
  recovery_status=0
  node -e 'eval(Buffer.from(process.env.SANDPI_PLAYWRIGHT_LOCK_RECOVERY_SCRIPT_BASE64, "base64").toString("utf8"))' "$profile" || recovery_status="$?"
  test "$recovery_status" -eq 12 || break
  test "$attempts" -lt 40
  sleep 0.25
  attempts=$((attempts + 1))
done
test "$recovery_status" -eq 0
chown -R "$browser_user:$browser_user" "$profile"

browser="$(command -v google-chrome-stable || command -v google-chrome || true)"
if test -z "$browser"; then
  browser="$(find /opt/ms-playwright -type f -path '*/chrome-linux*/chrome' -perm -111 2>/dev/null | sort | tail -n 1)"
fi
test -n "$browser"

mkdir -p /tmp/sandpi-browser-openbox
using_tigervnc=false
if command -v Xtigervnc >/dev/null; then
  using_tigervnc=true
  HOME=/tmp/sandpi-browser-openbox Xtigervnc "$display" \
    -geometry 1440x900 \
    -depth 24 \
    -rfbport "$vnc_port" \
    -localhost \
    -SecurityTypes None \
    -AlwaysShared \
    -AcceptSetDesktopSize \
    -ac \
    -nolisten tcp >/tmp/sandpi-browser-tigervnc.log 2>&1 &
  display_pid="$!"
else
  HOME=/tmp/sandpi-browser-openbox Xvfb "$display" -screen 0 1440x900x24 -nolisten tcp -ac +extension RANDR >/tmp/sandpi-browser-xvfb.log 2>&1 &
  display_pid="$!"
fi
pids="$display_pid $pids"
attempts=0
while test ! -S /tmp/.X11-unix/X99; do
  kill -0 "$display_pid"
  test "$attempts" -lt 100
  sleep 0.05
  attempts=$((attempts + 1))
done
DISPLAY="$display" HOME=/tmp/sandpi-browser-openbox openbox >/tmp/sandpi-browser-openbox.log 2>&1 &
pids="$! $pids"
if test "$using_tigervnc" = false; then
  DISPLAY="$display" x11vnc -display "$display" -rfbport "$vnc_port" -localhost -forever -shared -nopw -noxdamage -repeat -quiet >/tmp/sandpi-browser-x11vnc.log 2>&1 &
  pids="$! $pids"
fi

setpriv --reuid="$browser_user" --regid="$browser_user" --init-groups env DISPLAY="$display" HOME="/home/$browser_user" "$browser" \
  --user-data-dir="$profile" \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --disable-dev-shm-usage \
  --start-maximized \
  --restore-last-session >/tmp/sandpi-browser-chrome.log 2>&1 &
pids="$! $pids"

node -e 'eval(Buffer.from(process.env.SANDPI_PLAYWRIGHT_DASHBOARD_READY_SCRIPT_BASE64, "base64").toString("utf8"))' "$vnc_port"
node -e 'eval(Buffer.from(process.env.SANDPI_VNC_WEBSOCKET_BRIDGE_SCRIPT_BASE64, "base64").toString("utf8"))' ${port} "$vnc_port" &
bridge_pid="$!"
pids="$bridge_pid $pids"
wait "$bridge_pid"`;
}

export const HUMAN_BROWSER_PREFLIGHT_SCRIPT = String.raw`set -eu
command -v openbox >/dev/null
if ! command -v Xtigervnc >/dev/null; then
  command -v Xvfb >/dev/null
  command -v x11vnc >/dev/null
fi
command -v node >/dev/null
command -v setpriv >/dev/null
browser_user="${"${SANDPI_BROWSER_USER:-sandbox-browser}"}"
id "$browser_user" >/dev/null
node -e 'require("/opt/coding-agents/node_modules/ws")'
browser="$(command -v google-chrome-stable || command -v google-chrome || true)"
if test -z "$browser"; then
  browser="$(find /opt/ms-playwright -type f -path '*/chrome-linux*/chrome' -perm -111 2>/dev/null | sort | tail -n 1)"
fi
test -n "$browser"`;

export const PLAYWRIGHT_CLI_GUARD_SCRIPT = String.raw`#!/bin/sh
if test -e ${ENVIRONMENT_BROWSER_HUMAN_LOCK_PATH}; then
  printf '%s\n' 'The Environment browser is under human control. Return it to the agent before using Playwright.' >&2
  exit 75
fi
exec /usr/local/bin/playwright-cli "$@"
`;
