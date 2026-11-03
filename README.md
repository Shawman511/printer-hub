<p align="center">
  <img src="docs/logo.svg" alt="" width="88">
</p>

<h1 align="center">Printer Hub</h1>

<p align="center">
  <strong>One dashboard for all your 3D printers.</strong><br>
  Self-hosted, on your own network, no vendor cloud.
</p>

<p align="center">
  <a href="https://github.com/Shawman511/printer-hub/actions/workflows/ci.yml"><img src="https://github.com/Shawman511/printer-hub/actions/workflows/ci.yml/badge.svg" alt="Tests"></a>
  <a href="https://github.com/Shawman511/printer-hub/releases"><img src="https://img.shields.io/github/v/release/Shawman511/printer-hub?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#install-in-one-minute">Install</a> ·
  <a href="#supported-printers">Printers</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#documentation">Docs</a>
</p>

![Printer Hub dashboard with one printer printing and one preparing to print](docs/screenshots/dashboard.png)

Printer Hub connects straight to your **Klipper**, **OctoPrint**, **Prusa**,
**FlashForge** and **Anycubic** printers over your home network and puts them
on one page you can open from any browser or phone.

- **Live status and cameras:** progress, layers, time left, temperatures, and what a printer is getting ready to print. Crop each camera to just the build plate
- **Full control:** pause, resume, cancel, jog, home, temperatures, fans, speed and lights
- **Built-in slicer:** drop in an STL, 3MF or STEP file, slice it with OrcaSlicer's profile for your printer, and print. Sliced files carry a preview picture that shows on the printer's own screen
- **File library:** keep your G-code in one place, organized with folders and tags, and send it to any printer; files sliced for another printer are blocked
- **Filament tracking:** how much is left on each roll, from what each print used
- **Timelapses:** every print recorded from the camera as a short video, cropped to the build plate. Klipper and OctoPrint printers' own timelapses show up too
- **Job log:** every print recorded automatically, which printer made it, totals per item and CSV export
- **Accounts:** admin, operator and watch-only viewer roles

## Install in one minute

You need a computer that's always on and on the same network as your printers
(home server, NAS, mini PC or Raspberry Pi) with
[Docker](https://docs.docker.com/engine/install/) installed. Then run:

```bash
curl -fsSL https://raw.githubusercontent.com/Shawman511/printer-hub/main/install.sh | sh
```

The installer starts Printer Hub and prints its address and a one-time setup
code. Open the address, enter the code to create your admin account, and click
**Add a printer**. The form asks for what your type of printer needs and tests
the connection before you save. Timelapses and the camera crop are per printer,
under **Settings → Printers**.

<details>
<summary><strong>Prefer Docker Compose?</strong></summary>

```bash
mkdir printer-hub && cd printer-hub
curl -fsSLO https://raw.githubusercontent.com/Shawman511/printer-hub/main/deploy/docker-compose.yml
docker compose up -d
docker logs printer-hub 2>&1 | grep "setup code" | tail -n 1
```

Then open `http://<this machine's IP>:3000`.
</details>

<details>
<summary><strong>Just one container (no slicer)?</strong></summary>

```bash
docker run -d --name printer-hub --restart unless-stopped -p 3000:3000 -v printer-hub-data:/data ghcr.io/shawman511/printer-hub:latest
```
</details>

<details>
<summary><strong>Build from source?</strong></summary>

```bash
git clone https://github.com/Shawman511/printer-hub.git
cd printer-hub
docker compose up -d --build
docker logs printer-hub 2>&1 | grep "setup code" | tail -n 1
```

The first build takes about 3 minutes on a fast machine, and longer on a small one.
</details>

<details>
<summary><strong>Windows, Portainer, Unraid, TrueNAS, Raspberry Pi…</strong></summary>

See the [installation guide](docs/installation.md): Docker Desktop on Windows,
stacks in Docker UIs, ARM machines (everything but slicing works), updates,
backups, HTTPS and all settings.
</details>

<details>
<summary><strong>Setting it up with an AI coding agent?</strong></summary>

Give Claude Code, or any agent that can run commands on the machine, this prompt:

> Install Printer Hub on this machine by following
> https://github.com/Shawman511/printer-hub/blob/main/AGENTS.md

[AGENTS.md](AGENTS.md) has the exact commands, how to check each step, and what
the agent has to ask you before doing.
</details>

**Update** by running the installer again (or `docker compose pull && docker compose up -d`).
Your printers, accounts and history are kept.

## Supported printers

| Add it as | Works with | Live status & control | Start prints | Camera |
| --- | --- | :---: | :---: | :---: |
| **Klipper (Moonraker)** | Voron, Creality K1 / Sonic Pad, Elegoo Neptune 4, Sovol, Qidi, RatRig and other Klipper printers | ✓ | ✓ | ✓ |
| **OctoPrint** | Any printer running through OctoPrint / OctoPi: Creality Ender, Prusa MK3, most Marlin printers | ✓ | ✓ | ✓ |
| **Prusa (PrusaLink)** | Prusa MK4/S, MK3.9, XL, MINI+, Core One | ✓ ¹ | ✓ | ² |
| **FlashForge** | Adventurer 5M / 5M Pro (LAN-only mode) | ✓ | ✓ | ✓ |
| **Anycubic** | Kobra X / Kobra 3 / S1 (LAN Mode, incl. ACE multi-color) | ✓ | ✓ | ✓ |
| **Elegoo** | Centauri Carbon 2 (LAN Only mode, incl. CANVAS multi-color) ³ | ✓ | ✓ | ✓ |

¹ Pause, resume and cancel; PrusaLink has no manual-control API. ² Prusa
printers have no local camera stream, but you can add any MJPEG camera URL.
³ Tested on a real printer (firmware 02.01.01.07): status, files, light,
camera stream, uploads, starting and cancelling a print, and the part fan.
Pausing and resuming mid-print, a print running to the end, multi-color tray
choice and the other manual controls are tested against a simulated printer
only.

Slicing covers about **1,000 printer profiles from 64 brands** (everything
OrcaSlicer ships), and generic Klipper/Marlin profiles for anything else.
[What to enter for each printer type →](docs/printers.md)

> **Tested how?** FlashForge and Anycubic printers run on it daily. The
> Klipper, OctoPrint and PrusaLink drivers follow those projects' published
> APIs, and the Elegoo driver the community's reverse-engineered protocol; they
> are tested against simulated printers, but not yet on every real model. Tried it on yours? Please
> [say how it went](https://github.com/Shawman511/printer-hub/issues/new/choose).
> Bambu Lab support isn't there yet.

## Requirements

**To run it, you only need Docker.** You don't install any drivers on your
computer: there's no USB or serial connection, and everything talks to the
printers over your network. The Docker images already contain everything else.

| You need | Details |
| --- | --- |
| [Docker Engine](https://docs.docker.com/engine/install/) with the Compose plugin | Docker Desktop on Windows or macOS |
| 1 GB of RAM and about 5 GB of free disk | The images take 1.6 GB; the rest is for print files and timelapses |
| x86-64 or 64-bit ARM | Slicing needs x86-64. On ARM everything else works |
| A network route to each printer | Same network, with a fixed address for each printer |

**On each printer.** Nothing gets installed on the printer, apart from what its
type already needs:

| Printer type | Set up on the printer | How the hub connects |
| --- | --- | --- |
| Klipper | Moonraker running, which most Klipper setups already have | HTTP, port 7125 |
| OctoPrint | OctoPrint running, and an API key | HTTP, port 80 unless you give another |
| Prusa | PrusaLink on, and its password | HTTP, port 80 unless you give another |
| FlashForge | LAN-only mode on, with the serial number and check code | HTTP on port 8898; TCP on port 8899 with no check code |
| Anycubic | LAN Mode on | HTTP on port 18910, then MQTT over TLS on port 9883 |
| Elegoo | LAN Only Mode on, and its access code | MQTT on port 1883; HTTP on port 80 (serial number, uploads); camera on port 8080 |

A firewall between the hub and a printer has to allow these ports. The drivers
are part of the hub, in [`drivers/`](drivers).

<details>
<summary><strong>What's inside the images</strong></summary>

You don't install any of this unless you run from source.

| Image | Includes |
| --- | --- |
| `printer-hub` | Node.js 22 on Alpine, FFmpeg for timelapses, and three npm packages: [mqtt](https://www.npmjs.com/package/mqtt) for Anycubic and Elegoo printers, [mpegts.js](https://www.npmjs.com/package/mpegts.js) for live video, [three](https://www.npmjs.com/package/three) for the 3D preview |
| `printer-hub-slicer` | Ubuntu 24.04, [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer) 2.4.2 and the libraries it needs, and OpenCASCADE for STEP files |

**Running from source without Docker** needs Node.js 22, `npm install`, and
FFmpeg for timelapses. Slicing needs OrcaSlicer as well. See the
[development guide](docs/development.md).
</details>

## Screenshots

| | |
| --- | --- |
| ![Control panel](docs/screenshots/control.png) | ![Slice dialog](docs/screenshots/slice.png) |
| **Control panel:** camera, motion, temperatures, fans, filament | **Slicing:** OrcaSlicer profiles, copies, infill, supports |
| ![Library](docs/screenshots/library.png) | ![3D preview](docs/screenshots/preview.png) |
| **Library:** print files with the printer they were sliced for | **3D preview** with dimensions |
| ![Job log](docs/screenshots/jobs.png) | ![Totals](docs/screenshots/totals.png) |
| **Job log:** every print, outcome, items and filament | **By item:** totals per model, and which printers made them |
| ![Settings](docs/screenshots/settings.png) | ![Add a printer](docs/screenshots/add-printer.png) |
| **Settings:** your printers at a glance | **Add a printer** with a connection test |

<p align="center"><img src="docs/screenshots/mobile.png" alt="Printer Hub on a phone" width="280"><br><em>Works on your phone too.</em></p>

## Documentation

| | |
| --- | --- |
| [Installation](docs/installation.md) | All install options, Raspberry Pi, updating, backups, HTTPS, settings |
| [Printers](docs/printers.md) | What to enter for each printer type, and what each supports |
| [Using Printer Hub](docs/using.md) | Control panel, filament rolls, library, slicing, job log |
| [Users and security](docs/users-and-security.md) | Accounts and roles, sessions, password reset |
| [Troubleshooting](docs/troubleshooting.md) | Printers that won't connect, cameras, slicing, Docker |
| [Development](docs/development.md) | Running from source, tests, adding a printer type, releases |

## Contributing

Bug reports, printer reports and pull requests are welcome; see
[Development](docs/development.md) to get started. Adding support for a new
printer type is a single file. Security problems:
[SECURITY.md](SECURITY.md). Changes per version: [CHANGELOG.md](CHANGELOG.md).

## Disclaimer

Printer Hub controls real heaters and motors. Don't leave printers
unattended because the hub says a print is going well, and stay within
your printer's own limits. It talks to the printers' local APIs, some of which
their makers don't document, so a firmware update can change or break things.

This is an independent project. It isn't affiliated with or endorsed by
Klipper, OctoPrint, Prusa Research, FlashForge, Anycubic or the OrcaSlicer
project. Product names are trademarks of their owners.

## License

[MIT](LICENSE). The slicer image downloads [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer)
(AGPL-3.0) and installs [Open CASCADE Technology](https://dev.opencascade.org/)
(LGPL-2.1) from Ubuntu at build time; neither is included in this repository.
