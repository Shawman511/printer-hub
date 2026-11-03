# Printers

[← Back to the README](../README.md)

## What's supported

| Type in Settings | Printers | Status | Control | Start prints | Camera |
| --- | --- | --- | --- | --- | --- |
| **Klipper (Moonraker)** | Voron, Creality K1 / Sonic Pad, Elegoo Neptune 4, Sovol, Qidi, RatRig and other Klipper printers with Mainsail or Fluidd | ✓ | ✓ | ✓ | ✓ (Moonraker webcams) |
| **OctoPrint** | Any printer connected to OctoPrint / OctoPi (Creality Ender, Prusa MK3, most Marlin printers) | ✓ | ✓ | ✓ | ✓ (OctoPrint webcam) |
| **Prusa (PrusaLink)** | Prusa MK4/S, MK3.9, XL, MINI+, Core One | ✓ | pause / resume / cancel | ✓ | stream URL only |
| **FlashForge Adventurer 5M / 5M Pro** | Stock firmware, LAN-only mode | ✓ | ✓ | ✓ | ✓ |
| **Anycubic Kobra X / Kobra 3 / S1** | Stock firmware, LAN Mode (incl. ACE multi-color) | ✓ | ✓ | ✓ | ✓ |
| **Elegoo Centauri Carbon 2** | Stock firmware, LAN Only mode (incl. CANVAS multi-color) | ✓ | ✓ | ✓ | ✓ |
| **Simulator** | A pretend printer for trying the hub | ✓ | ✓ | ✓ | ✓ |

The FlashForge and Anycubic drivers are used daily on real printers. The
Klipper, OctoPrint and PrusaLink drivers follow those projects' documented
APIs, and the Elegoo driver follows the community's reverse-engineered
protocol. They are tested against simulated servers in [`test/`](../test/), but
haven't been run against every model. If something doesn't work with yours,
please [open an issue](https://github.com/Shawman511/printer-hub/issues).

Not supported yet: Bambu Lab, the original Elegoo Centauri Carbon (SDCP) and
Creality printers on stock (non-Klipper) firmware. Adding a printer type is one file in
[`drivers/`](../drivers/); see [Development](development.md#how-it-works).

## Adding a printer

Admins add printers under **Settings → Printers → Add printer**:

1. **Type:** pick how the printer is reached (see [What's supported](#whats-supported)).
2. **Name** and **Address:** the printer's IP address or host name. Give it a
   DHCP reservation in your router so the address doesn't change.
3. The type's own settings (below).
4. **Slice with:** the OrcaSlicer profile used when you slice models for this
   printer: its brand, then the model and nozzle. For a printer that isn't
   listed, **Custom** has generic Klipper and Marlin profiles.
5. **Test connection**, then **Save**. The printer shows up on the dashboard
   right away.

Passwords and keys are stored on the server (`data/printers.json` in the data
volume) and never sent back to the browser. Removing a printer keeps its job
history.

## Settings for each type

### Klipper (Moonraker)

Use Moonraker's address; port 7125 is assumed unless
you give one (e.g. `voron.local` or `192.168.1.60:7125`). An API key is only
needed if Moonraker doesn't trust your hub's network (`[authorization]`
`trusted_clients`). The camera comes from Moonraker's webcam settings. For a
light switch, enter the name of the `[output_pin]` that drives your light.

### OctoPrint

Use OctoPrint's address (e.g. `octopi.local`, or a full URL such
as `http://192.168.1.70:5000`), and an API key from OctoPrint's
*Settings → Application Keys*. The camera comes from OctoPrint's webcam
settings. OctoPrint must be connected to the printer.

### Prusa (PrusaLink)

Turn on PrusaLink on the printer. The address and
password are on its screen under *Settings → Network*; the username is `maker`.
Older firmware shows an API key instead of a password. Prusa printers have no
local camera stream, but you can enter one (e.g. a webcam on a Pi).

### FlashForge Adventurer 5M / 5M Pro

On the printer's screen, turn on
**LAN-only mode** in the network settings; it then shows a **check code**. The
serial number is under About / device info. With both you get everything
(status, light, files, starting prints). Without them, status, progress, temps
and pause/resume/cancel still work over the older TCP API, which allows one
client at a time, so it can clash with FlashPrint or Orca. The camera is
`http://<ip>:8080/?action=stream` (standard on the 5M Pro; an add-on for the
5M).

### Anycubic Kobra X / Kobra 3 / S1

Turn on **LAN Mode** (Settings →
Network). There are no credentials to enter: the hub gets them from the
printer. In cloud mode the hub reports "Printer is in cloud mode". The Kobra X
only has WiFi; once LAN Mode is on you can block its internet access in your
router. The camera is the printer's FLV stream, with still snapshots as a
fallback.

### Elegoo Centauri Carbon 2

On the printer, turn on **LAN Only Mode** (Settings → Network); without it the
printer accepts the connection but never answers. Enter the **access code**
shown on the same screen. If the printer has no access code set, leave it
empty: the hub then uses `123456`, as Elegoo's own app and slicer do. The
printer allows two LAN connections at a time, shared with the Elegoo app and
slicer; if both are taken the hub says so and reconnects once one is free. The
camera is `http://<ip>:8080/?action=stream`.

**CANVAS multi-color:** when you start a print, the hub suggests a loaded tray
for each color (same material, closest color), you can change it, and the hub
tells the printer which trays to use. The job log charges the rolls in those
trays. The printer doesn't report how much of each color a file uses: a
one-color print charges the file's total to its tray, and a multi-color file
the hub sliced charges each color's grams from the hub's own copy (matched by
filament number, which is the printer's tool number `t`). Other multi-color
files record their total without charging a roll, unless every color uses the
same tray. If the printer doesn't list a file's colors at all, the hub won't
start it while CANVAS is attached, since it can't pick a tray; start it on the
printer's screen instead. If the printer switches trays by itself mid-print
(auto-refill), the charge stays on the tray the print started from.

**Pause, resume and cancel** count as done when the printer answers or its
status changes to match. If neither happens within 15 seconds, the hub says the
command wasn't confirmed instead of reporting success. The Pause button is
hidden while the printer heats up for a print, because the printer holds such a
pause and carries it out minutes later. Cancel works at any time.

Uploads use the access code too; with a wrong one the printer refuses them.

### Network

The machine running the hub has to reach the printers' addresses. If they're
on another VLAN, your router or firewall has to allow it.

