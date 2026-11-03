# Instructions for AI coding agents

For Claude Code, Codex, Cursor and any other agent asked to deploy Printer Hub.
You don't need to clone this repository to deploy it. People can follow this
too; the [installation guide](docs/installation.md) has more options.

Printer Hub is a self-hosted dashboard for 3D printers. It runs in Docker on a
machine on the same network as the printers.

## Rules

- **Don't start prints, move, home or heat a printer** unless the person asks
  for that specific action. These are real heaters and motors. Testing a
  connection and reading status are safe.
- **Don't guess printer details.** Ask for each printer's type and address, and
  for anything secret (check code, API key, password). If they'd rather not share
  a secret with you, leave that printer for them to add in the browser.
- **Keep passwords, keys and setup codes out of git** and out of files you
  create. Don't repeat them back except the setup code and any password you
  were asked to generate.
- **Don't open the hub to the internet.** Use a VPN for remote access.
- **Ask before** installing Docker, changing a firewall or deleting a volume.

## 1. Check the machine

```bash
docker compose version
docker info --format '{{.ServerVersion}} {{.Architecture}}'
```

Both must succeed. If Docker is missing, ask before installing it
([guide](https://docs.docker.com/engine/install/)). If the socket is denied, use
`sudo` or ask to add the user to the `docker` group. Needs 1 GB of RAM and the
free disk space in the [installation guide](docs/installation.md#before-you-start).
Slicing needs x86-64; on ARM the installer leaves the slicer out and everything
else works.

## 2. Install

Nothing here prompts for input. On Linux, macOS, a NAS or a Raspberry Pi:

```bash
curl -fsSL https://raw.githubusercontent.com/Shawman511/printer-hub/main/install.sh | sh
```

Optional settings go before `sh`: `PRINTER_HUB_DIR=/opt/printer-hub` (default
`~/printer-hub`) and `HUB_PORT=8080` (default 3000). Use another port if 3000 is
taken; check with `ss -ltn | grep :3000`. On Windows, or with Compose directly,
follow [Option 2](docs/installation.md#option-2-docker-compose). Run the rest of
these steps on the same machine, using your port if you changed it.

The installer ends by printing `Open:` and `Setup code:`. Keep the code for step 4.
A `Sign in with your existing account` line instead means the hub is already set
up: skip step 4 and ask the person to sign in.

## 3. Check it's running

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/api/auth/me
docker ps --filter name=printer-hub --format '{{.Names}}: {{.Status}}'
```

Expect `{"ok":true}`, then `"setup":true` on a new install, and containers that
are `healthy` or `Up`. If the code is lost:

```bash
docker logs printer-hub 2>&1 | grep "setup code" | tail -n 1
```

## 4. Create the admin account

**Usually this is the person's job, and it's the better choice.** Give them the
address and setup code and tell them to open it, create the account and click
**Add a printer**. The form guides them through it and tests the connection.
Find the address with `hostname -I`. Then you're done: report the URL and stop.

Only if they ask you to finish the setup yourself, ask for a username (3–32
characters) and a password (at least 8), or generate a password and show it to
them once. Keep the session cookie outside any repository and delete it at the
end:

```bash
HUB=http://127.0.0.1:3000
JAR=$(mktemp)
curl -fsS -c "$JAR" -H 'Content-Type: application/json' \
  -d '{"code":"ABCDE-12345","username":"admin","password":"THE-PASSWORD"}' "$HUB/api/auth/setup"
```

## 5. Add the printers

Continuing with `$HUB` and `$JAR`. Ask which printers they have, then list the
types and the fields each one takes:

```bash
curl -fsS -b "$JAR" "$HUB/api/printer-setup/types" | jq '.[] | {type, help, fields: [.fields[] | {key, required, help}]}'
```

| Type | For | You'll need |
| --- | --- | --- |
| `moonraker` | Klipper printers | Address; API key only if Moonraker requires one |
| `octoprint` | Anything on OctoPrint | Address, API key |
| `prusalink` | Prusa MK4, XL, MINI+, Core One | Address, username `maker`, password from the printer's screen |
| `flashforge` | Adventurer 5M / 5M Pro | Address, serial number, check code (LAN-only mode) |
| `anycubic` | Kobra X / Kobra 3 / S1 | Address (LAN Mode on) |
| `mock` | A simulated printer, for trying the hub | Nothing |

[docs/printers.md](docs/printers.md) says where the printer shows each value.
Test first, then save. `test` only connects and reads status, and the answer has
`ok`, `model` and `error`:

```bash
BODY='{"type":"moonraker","name":"Voron","host":"192.168.1.60"}'
curl -fsS -b "$JAR" -H 'Content-Type: application/json' -d "$BODY" "$HUB/api/printer-setup/test"
curl -fsS -b "$JAR" -H 'Content-Type: application/json' -d "$BODY" "$HUB/api/printer-setup"
```

The second call returns the printer's `id`. If `test` fails, the Docker machine
probably can't reach the printer: check with `ping`, and check the printer's LAN
mode. Don't save a printer that failed unless they want you to.

## 6. Ask about each printer's options

These are the person's choices, so ask rather than assume. All are per printer and
can be changed later under **Settings → Printers**:

- **Timelapses:** recorded by default if the printer has a camera. To turn off:
  ```bash
  curl -fsS -b "$JAR" -X PATCH -H 'Content-Type: application/json' -d '{"timelapse":false}' "$HUB/api/printer-setup/PRINTER_ID"
  ```
  How often it takes a frame and how long the video is are also theirs to choose.
  The default is every layer and an automatic length. To change them, `PATCH` with
  `{"timelapseEvery":{"layers":5}}` or `{"timelapseEvery":{"seconds":60}}`, and
  `{"timelapseLength":30}` in seconds (`0` for automatic).
- **Camera crop:** drawn on the picture in the browser, so leave it to them.
- **Slicer profile:** picked under **Slice with**. To set it, list the choices
  with `GET /api/printer-setup/machines`, then `PATCH` with
  `{"slicer":{"vendor":"…","machine":"…"}}`.

## 7. Confirm and finish

```bash
curl -fsS -b "$JAR" "$HUB/api/printers" | jq '.[] | {id, name, online, status, error}'
curl -fsS -b "$JAR" "$HUB/api/slicer" | jq '{available, step, printers}'
rm -f "$JAR"
```

**Done means:** every printer has `online: true`, and `available: true` for
slicing unless this is an ARM or single-container install. Printers can take a
few seconds to appear online. Tell the person the address and any password you
generated, and that they should change a generated password under their name in
the top right.

## Afterwards

Run these in the install folder:

| To | Do |
| --- | --- |
| Update | Run the installer again, or `docker compose pull && docker compose up -d` |
| Read the logs | `docker compose logs --tail 100 printer-hub` |
| Reset a password | See [Troubleshooting](docs/troubleshooting.md) |
| Back up or uninstall | See the [installation guide](docs/installation.md#backups) |

Anything else that goes wrong: [Troubleshooting](docs/troubleshooting.md).

## Changing the code

[docs/development.md](docs/development.md) covers running from source, `npm test`
and how to add a printer type. It's a Node server with no framework and plain
JavaScript in `public/`. Keep each page of the app focused on one task.
