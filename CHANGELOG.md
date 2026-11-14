# Changelog

What changed in each version. The running version is shown under the name in
the app's top bar.

## 0.22.3 — 2026-11-14

### Security
- **A crafted .3mf file can't exhaust the hub's memory.** Settings and pictures
  inside a .3mf are only unpacked up to 50 MB; a small file could claim gigabytes.
- **The job log's CSV export can't carry spreadsheet formulas.** Text starting
  with `=`, `+`, `-` or `@` gets a leading apostrophe.
- **Printer check codes, API keys and passwords** are saved readable by the hub's
  own user only, as accounts already were.
- **GitHub Actions are pinned to exact commits,** with Dependabot keeping them current.

## 0.22.2 — 2026-11-09

### Fixed
- **Two requests that stopped the hub.** A malformed cookie or a path of `//`
  made the hub exit, without signing in. A request that goes wrong now gets an
  error reply instead.
- **Printer settings stay admin-only.** A path written as `/api//printer-setup`
  let operators change printers and viewers read their settings.
- **Kobra X: pause, resume and cancel are confirmed.** The hub waits for the
  printer's status to show the change and says so if it doesn't, instead of
  reporting success straight away.
- **Kobra X: requests of one kind no longer take each other's answers,** and a
  printer edited or tested while connecting doesn't leave a connection behind.
- **Downloading a file missing from disk** gives an error instead of stopping the hub.
- **Settings → Storage no longer holds everything up** while it adds up the disk.
- **Sign-in lockouts are per address.** Wrong passwords could lock a known
  account out for everyone.
- **Uploads that break off** no longer leave a file open.

## 0.22.1 — 2026-11-03

### Added
- **Settings → Storage shows the whole disk:** space in use, free space and disk
  size, with how much of it is the hub's. The Library and Timelapses pages show
  the free space too.

## 0.22.0 — 2026-11-03

### Added
- **Timelapse settings per printer,** in Settings → Printers: take a frame every
  layer, every 2, 5 or 10 layers, or on a timer, and choose the video's length.
- **Size on disk:** the Library and Timelapses pages show their totals, and a new
  **Settings → Storage** page breaks down what the hub keeps and the free space.

### Changed
- **Longer prints get longer timelapses.** The automatic length is 10 seconds plus
  5 per hour printed, up to a minute, instead of about 10 seconds for everything.
  Finished videos don't change.
- A very long recording now thins out its frames and carries on, where it used to
  stop taking frames at 3000 and miss the end of the print.

## 0.21.0 — 2026-11-03

### Fixed
- **Slicer project .3mf files slice again.** They failed with
  `basic_ios::clear: iostream error` because of a temp folder the slicer couldn't
  write to.
- **Multicolor prints tell the printer every color used.** Before, a sliced file
  always reported one color, however many it printed with.

### Added
- **Project colors carry through slicing,** with each part keeping its color.
- **Color check when printing:** files with two or more colors list each color
  and its slot, warn about likely mismatches, and need a tick before starting.
- **Filament is charged per color** for files the hub sliced.
- **Clicking a file:** the picture opens a preview, and the name starts Print or Slice.

### Known limits
- Project files that keep their models in sub-files have no 3D preview, so their
  picture opens the saved plate image instead.

## 0.20.0 — 2026-11-02

### Added
- **Themes,** on the Account page: Graphite, Paper, Blueprint, Terminal and
  Original, or match your device. Saved per browser.
- **Update alerts in Dockhand,** using the published images. The installation
  guide has the steps. The published compose file can reuse an existing volume
  with `HUB_VOLUME`.
- **Requirements in the README:** what to install, what to set up on each printer
  and which ports it uses, and what the images contain. No drivers are needed.

### Changed
- **New default look and logo.** Plainer, with squarer corners and no orange. The
  old look is the Original theme.

## 0.19.0 — 2026-11-02

### Added
- **A picture for every file in the library.** Files without a preview now get
  one: G-code is drawn from its toolpaths, sliced .3mf files use the picture
  inside them, and models are drawn with the 3D preview. Existing files fill in
  by themselves after updating.
- **Browse printer files** shows the picture when the library has that file.

## 0.18.1 — 2026-11-02

### Fixed
- **Slicing a model again with different settings gets its own file name,**
  ending in `_v2`, `_v3` and so on. Before, both files had the same name and
  sending the second overwrote the first on the printer. Hover a file in the
  library to see what it was sliced with.

## 0.18.0 — 2026-11-02

### Added
- **More slicer settings,** on tabs in the Slice dialog. Anything left blank uses
  the Quality preset.
  - **Strength:** infill pattern, top and bottom layers.
  - **Surface:** seam position, ironing, fuzzy skin and vase mode.
  - **Support:** overhang angle, supports from the build plate only, brim width
    and skirt loops.

## 0.17.1 — 2026-11-01

### Changed
- **Filament rolls count down live** as a print runs, by its progress. Hover a
  roll to see how much is from the print running now.

### Fixed
- **Adjust** during a print no longer charges the roll again for what the print
  had already used.

## 0.17.0 — 2026-11-01

### Added
- **Rename library files.** The extension stays, and prints that use the old name
  keep working. The next send uploads the new name to the printer.
- **Folders in the library,** with subfolders. Drag a file onto a folder to move
  it, and uploads go into the folder you're viewing. Removing a folder keeps its
  files.
- **Tags on library files.** Click tags to filter, and search finds them too.
- Files sliced from a model start in its folder with its tags.

## 0.16.1 — 2026-11-01

### Fixed
- **Filament rolls now go down after prints the hub sliced.** The Kobra X reports
  0 g for these files, so the job log showed the weight but charged it to no
  slot. It now goes to the slot the print used. Prints that finished before this
  update aren't charged: use **Adjust** to correct a roll once.

## 0.16.0 — 2026-11-01

### Changed
- **Job log and Totals are one page.** The job log has two tabs, **All prints**
  and **By item**, with the same filters and tiles. By item now shows which
  printers made each item, and clicking an item shows its prints.
- **New logo**, in the top bar, the browser tab and the sign-in page.

### Install
- **[AGENTS.md](AGENTS.md):** exact steps for an AI coding agent to deploy the
  hub and add printers, including what it must ask first.
- New **build from source** route in the installation guide.
- The published compose file names its volume `printer-hub-data`, so the backup
  and uninstall commands work whatever folder it's in.
- The setup code command shows only the newest code; a Windows version is added.
- Backup commands work on every install route, and restoring is now spelled out.
- A new `deploy-check` workflow runs the documented routes on clean machines.

## 0.15.1 — 2026-11-01

### Fixed
- **Finished prints logged as failed or cancelled.** If a printer reported an
  error or idle for a moment mid-print and then carried on, the job log closed
  the job and started a second one. It now reopens the same job when the
  printer resumes the same file at the same progress (within 30 minutes).
- Printers that report whole percents and go idle at 99% count as finished.
- A blip like that no longer ends a timelapse recording either.

### Added
- The job log shows **why** a print ended without finishing, e.g. "Printer
  reported an error (at 43%)", and writes it to the hub's log.

## 0.15.0 — 2026-10-31

### Added
- **Timelapses.** The hub records every print on printers with a camera: a
  frame per layer, turned into a short MP4 when the print ends, cropped like
  the camera. A new **Timelapses** page plays, downloads and deletes them, and
  a **● REC** badge shows while recording. On by default; turn it off per
  printer in Settings.
- Timelapses made by Klipper (moonraker-timelapse) and OctoPrint printers are
  listed on the same page and streamed through the hub.
- The Docker image now includes FFmpeg.

## 0.14.0 — 2026-10-31

### Added
- **Camera crop.** Admins can crop each printer's camera to the part that
  matters, such as the build plate: hover over the camera in the control
  panel, click **Crop**, drag a box and save. Every card and view shows the
  crop; **Full frame** removes it. Saving a crop doesn't reconnect the
  printer.

## 0.13.0 — 2026-10-31

### Added
- **Clear** button for printers that show a finished print: marks the plate
  as clear and the printer ready. On the Adventurer 5M it also dismisses the
  printer's own "clear the platform" prompt; Klipper printers get
  `SDCARD_RESET_FILE`. The job log keeps the finished print.

## 0.12.0 — 2026-10-31

### Added
- **Print previews on the printer's screen.** Files the hub slices now include
  preview images in the sizes and formats each printer's profile asks for
  (e.g. 140×110 on the Adventurer 5M, 230×110 on the Kobra X, QOI images on
  Prusa printers, 32×32 and 300×300 for Klipper). They're drawn from the
  sliced toolpaths, so they show exactly what will print: every copy on the
  plate, as arranged.
- Previews in the hub: next to each file in the library, and next to the job
  on printer cards and the control panel. Files sliced elsewhere show their
  own embedded previews.

### Fixed
- Library and totals tables: the action buttons' column no longer breaks the
  row lines.

## 0.11.0 — 2026-10-31

The first public release.

### Added
- **Any printer, set up in the browser.** Admins add, edit, test and remove
  printers under **Settings → Printers**. Each type shows its own fields, and
  **Test connection** says exactly what's wrong (wrong key, unreachable, …).
- **New printer types:** Klipper (Moonraker), OctoPrint and Prusa (PrusaLink).
- **Slice for any printer:** pick one of OrcaSlicer's ~1,000 printer profiles
  (64 brands), or a generic Klipper/Marlin profile.
- **One-line installer** (`install.sh`) and a ready-to-use
  `deploy/docker-compose.yml` with published images
  (`ghcr.io/shawman511/printer-hub`, `printer-hub-slicer`). The hub image also
  runs on ARM (Raspberry Pi), without slicing.
- `TRUST_PROXY` environment variable for running behind a reverse proxy.
- Documentation in `docs/`, issue forms, and automated tests (drivers against
  simulated printers, the setup API) on every push.

### Changed
- **Users** moved into **Settings**, next to **Printers**.
- Brands without filament profiles of their own (Voron, Custom, …) use
  OrcaSlicer's shared filament library instead of an empty list.
- Printers without a default build plate get the plate the filament has
  temperatures for, so the bed heats properly (e.g. 60 °C instead of 45 °C on
  a Prusa MK4).

### Fixed
- Removing or editing a printer while it was being polled left a background
  connection running.

### Upgrading from 0.10
Printers configured through `AD5M_HOST` / `KOBRAX_HOST` environment variables
are imported into Settings on the first start, keeping their job history and
filament rolls. After that the variables can be removed.

## 0.10.0 — 2026-10-31

### Added
- Printers getting ready to print (file check, leveling, heating) show
  **Preparing *file*** with the stage and the estimated print time, instead of
  looking idle.
- The light is an on/off **switch** that shows the light's actual state.
- MIT license, security policy, screenshots and a public README.

## 0.9.x — 2026-10-31

### Added
- **STEP files** can be sliced: they're converted to a mesh with OpenCASCADE
  first, since OrcaSlicer's command-line slicer can't read STEP.
- The running **version** is shown in the top bar.

## Before 0.9

Dashboard and cameras for FlashForge Adventurer 5M and Anycubic Kobra X,
control panel, file library, OrcaSlicer slicing with 3D preview, job log and
totals, filament roll tracking, blocking files sliced for another printer,
and sign-in with admin, operator and viewer accounts.
