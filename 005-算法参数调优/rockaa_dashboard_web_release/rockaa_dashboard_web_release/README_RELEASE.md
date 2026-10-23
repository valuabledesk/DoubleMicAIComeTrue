# RockAA Dashboard (HTML Release)

## Prerequisites

- **Node.js** >= 16 (https://nodejs.org)
- **ADB** in PATH (on Windows the bundled `adb/adb.exe` is used automatically)
- **Python 3** with pip — only needed for the Evaluation Test feature:
  ```
  pip3 install -r evaluation/requirements.txt
  ```

## Quick Start

**Linux / macOS:**
```bash
./rockaa_dashboard_web_start.sh
```

The launcher runs the Bridge in the background, prints the serving URL and
exits, so the terminal stays free. Logs go to `rockaa_dashboard.log`; the
background PID is kept in `rockaa_dashboard.pid`. Starting again while an
instance is running just prints its URL. Run with `--foreground` to keep the
Bridge attached to the terminal (Ctrl+C stops it).

**Windows:**
```cmd
rockaa_dashboard_web_start.cmd
```

The Windows launcher starts the Bridge minimized and logs to
`rockaa_dashboard.log`; pass `--foreground` to run it in the current console.

If port 8900 is already in use, the Bridge automatically tries the next free
port and the URL reflects it, for example `http://127.0.0.1:8901/`.

To require a fixed port, set `ROCKAA_BRIDGE_PORT` explicitly:

```bash
ROCKAA_BRIDGE_PORT=8900 ./rockaa_dashboard_web_start.sh
```

## Remote Browser Recording

RX online `Host Record` captures the microphone on the computer running the
current browser. Its detected channel count is applied to RX input/output
before the board session starts. The PCM travels through the online WebSocket,
including an SSH tunnel, to the Bridge and then the board. Imported WAV/raw
PCM sources likewise synchronize RX input/output channels and upload in
acknowledged chunks after the source stream is ready, so remote SSH/WAN clients
do not rely on one large startup request. Allow microphone access in the
browser; for SSH forwarding, open the dashboard through its local
`http://127.0.0.1:<port>/` URL.

## Directory Layout

| Path | Purpose |
|------|---------|
| `bridge/` | Node.js HTTP + WebSocket bridge server |
| `js/`, `css/`, `index.html` | Frontend dashboard |
| `evaluation/` | Python audio analysis module |
| `platforms/` | Device-side RockAA runtime binaries, incl. `sed/` (sound-event-detect runtime set and rknn models, pushed on demand) |
| `output/` | Evaluation reports (generated at runtime) |

## Stop the Server

The background launcher prints the exact stop command on start. Generic
forms:

```bash
kill $(cat rockaa_dashboard.pid)          # background start on Linux/macOS
ROCKAA_BRIDGE_PORT=<port> node bridge/adb-bridge.js --stop
```

For a `--foreground` start, press `Ctrl+C` in the terminal.
