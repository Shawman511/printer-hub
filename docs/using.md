# Using Printer Hub

[← Back to the README](../README.md)

A tour of each part of the app: [themes](#themes), the [control panel](#control-panel), [filament rolls](#filament-rolls), the [library and starting prints](#files-library-uploads-and-starting-prints), [slicing](#models-and-slicing), [timelapses](#timelapses) and the [job log](#job-log).

## Themes

Pick one under your name in the top right, on the **Account** page: Graphite,
Paper, Blueprint, Terminal or Original, or **Match device** to follow your light or
dark setting. It's saved in that browser, so each device can have its own.

## Control panel

**Controls** on a printer card opens `#control/<printer>`, a full-page view of
that printer:

- **Files:** upload only, or upload & print (models go to the slicer).
  Browse printer files.
- **Camera** at full size, with a fullscreen button.
- **Crop** (admins; hover over the camera): show only part of the camera
  image, e.g. just the build plate. Drag a box over the full frame and
  **Save**; **Full frame** removes the crop. The crop is applied in the
  browser, on every card and view, and saved with the printer's settings.
- **Status:** progress, layer, time remaining, and the clock time it will
  finish. Pause, resume, cancel, light, and motors off.
- **Clear:** after a print finishes, the printer shows **Done** until you take
  the part off. **Clear** (on the card or here) marks the plate as clear and
  the printer as ready. The Adventurer 5M also dismisses its own "clear the
  platform" prompt (needs the serial number and check code), and Klipper
  printers reset like Mainsail's clear button. Other printers are shown as
  ready by the hub until they start something new.
- **Move:** XY jog pad, Z up/down, step size 0.1 / 1 / 10 / 50 mm, and home XY,
  Z or all.
- **Temperatures:** nozzle and bed targets (slider or number), plus PLA, PETG
  and ABS preheat presets and Cool down. Max 280/110 °C on the AD5M and
  300/120 °C on the Kobra X.
- **Fans & speed:** part fan %. During a print: AD5M speed 50–150%, or the
  Kobra X's Silent / Standard / Sport modes.
- **Filament:** each Kobra X ACE slot, or the AD5M's single spool, shows a
  hub-tracked roll. See below.

### Filament rolls

The printers don't really measure what's left (the Kobra X reports 100% for
every slot), so the hub tracks rolls itself:

- **New roll** on a slot records a roll's size (1 kg by default), material and
  color. For a part-used roll, enter how many grams are left.
- Each print's filament is charged to the slot(s) it used:
  - Kobra X prints started from the hub: the file's per-color grams and the
    slot mapping you chose.
  - Kobra X prints started elsewhere: the file's per-color grams, with the
    slots guessed the same way the print dialog suggests them.
  - AD5M: the file's weight from the library, or the printer's own estimate.

  Cancelled or failed prints are charged by how far they got.
- Remaining = the roll's starting weight minus the filament charged since. It's
  recalculated from the job log, so fixing a job's outcome corrects the roll. A
  running print counts live, by its progress, so the number is an estimate until
  the print ends. **Adjust** during a print counts only what it uses from then on.
- **Adjust** sets the remaining grams after weighing a roll (subtract the empty
  spool, usually 200–250 g). Rolls are stored in `data/spools.json`.
- The job log gains a Filament column, and the CSV gets `filament_g`.

Safety: jog, home and motors off are refused while a print is running. The
server enforces every limit, not just the UI.

Protocols: the AD5M takes G-code over its TCP API (`G91`/`G1` jog, `G28`,
`M104`/`M140`, `M106`, `M18`) and `printerCtl_cmd` for speed. The Kobra X takes
MQTT `axis/move`, `axis/turnOff`, `tempature/set`, `fan/setSpeed` and
`print/update`.

## Files: library, uploads and starting prints

- **Library tab:** drop `.gcode`, `.gx`, `.3mf` or `.bgcode` files (up to 512 MB)
  to store them on the hub, in `data/library/` (the `printer-hub-data` volume in
  Docker). The hub reads the slicer header to show which printer and material
  each file was sliced for, and suggests a matching printer. **Send** copies the
  file to a printer. **Print…** sends it if needed, then opens the print dialog.
- **Pictures:** each file shows a small picture, in the library and under
  **Browse printer files** when the library has that file. It's the preview the
  slicer put in the file, or else the hub draws one: from the toolpaths for G-code
  up to 150 MB, and with the 3D preview in your browser for STL, OBJ and 3MF models
  up to 100 MB. A STEP model uses the picture of its latest slice. Anything else
  shows its file type.
- **Clicking a file:** the picture opens a preview, and the name starts the job:
  **Print…** for a print file, **Slice…** for a model.
- **Rename, tag and move:** the ✎ button on a file changes its name, folder and
  tags. The extension stays. A printer keeps any copy it already has under the
  old name, and the next **Send** or **Print…** uploads the new name. Prints
  already running or logged keep working, and past job log entries keep the old
  name, so **By item** lists the new name separately.
- **Folders:** the list beside the table. **New** makes a folder inside the one
  you're viewing, and new uploads go into the one you're viewing. Drag a file
  onto a folder to move it. A folder shows the files in its subfolders too.
  Removing a folder never deletes files: they move up a level. Files sliced from
  a model start in the model's folder with its tags. Folders go 5 levels deep.
- **Tags:** click a tag to show only files that have it, and click more to narrow
  it down. Search also finds tags and folder names.
- **Start print… → Upload from computer:** uploads straight to that printer
  and keeps a copy in the library. With **Print after upload** on, the print
  dialog opens right after.
- **Print dialog:** on the Kobra X, each color in the file is mapped to an ACE
  slot. The default is the loaded slot with the same material and the closest
  color, and you can change it. Both printers have an auto-level option.
- **Reprint** in the job log opens the same dialog. If the file is gone from
  the printer but still in the library, it offers to send it again.

Kobra X uploads and starts follow the format validated on firmware 2.0.2.2
by [kobra-lan-cli](https://github.com/eduardobittencourt/kobra-lan-cli). The
printer must be idle to receive files.

## Models and slicing

- **Library → Models:** drop `.stl`, `.obj`, `.step`/`.stp`, `.amf` or a
  `.3mf` project. A `.3mf` that already contains sliced plates goes to Print
  files instead. STL, OBJ and 3MF models get a 3D **Preview** with dimensions.
- **Slice…** runs [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer)
  (2.4.2 by default) in the `slicer` container, with the printer's profile from
  Settings (FlashForge and Anycubic printers have one preset):
  - Quality and filament lists are Orca's presets for that printer. Brands
    without their own filaments (Voron, Custom, …) get Orca's generic filament
    library.
  - The build plate defaults to the printer's own, or else the plate the
    filament has temperatures for (e.g. smooth PEI on Prusa), so beds heat
    properly.
  - STEP files are meshed to STL first with OpenCASCADE (`slicer/step2stl.cpp`,
    same tolerances as Orca's desktop app), since Orca's CLI can't read STEP.

  **Basics** has copies on the plate (they're auto-arranged), infill, walls,
  supports (off, normal or tree), brim and auto-orient. More settings are on
  their own tabs, and a number on a tab shows how many you've changed. Anything
  left blank uses what the Quality preset says, and **Reset to preset** clears
  them all:
  - **Strength:** infill pattern, top and bottom layers.
  - **Surface:** seam position, ironing, fuzzy skin and vase mode. Vase mode
    needs one solid part and one copy, and it's off again next time.
  - **Support:** the overhang angle that gets supports, whether supports can
    start on the model or only from the build plate, brim width and skirt loops.

  The dialog remembers your last choices, except vase mode.
- The result lands in Print files, linked to its model. Slicing a model again with
  different settings adds a new file ending in `_v2`, `_v3` and so on, and the
  earlier ones stay. Hover a file to see what it was sliced with. All versions
  count as one item in the job log. The copy count becomes
  the job's **items per plate**, so 4 copies counts as 4 items.
  **Send & print…** goes straight to the print dialog.
- **Previews:** sliced files include preview pictures in the sizes and formats
  the printer's profile asks for, so the printer's own screen shows what's
  printing (instead of a generic file icon). OrcaSlicer's command-line slicer
  doesn't make them, so the hub draws them from the sliced toolpaths: every
  copy on the plate, in the filament colour. The same preview appears in the
  library and next to the job on printer cards; files sliced elsewhere show the
  previews they already contain. Files sliced before v0.12 have none: slice
  them again to get one.
- Kobra X slices get a `; paint_info` header line (Anycubic Slicer Next writes
  one; Orca doesn't), so the printer can report the file's color for slot mapping.
- The slicer flattens Orca's `inherits` chains into standalone presets and fixes
  one Kobra X profile value the command-line tool rejects (cut retraction 0,
  while that feature is off). When building from source, set a different Orca
  version with the `ORCA_VERSION` build argument.
- **Slicer projects:** a `.3mf` saved by Anycubic Slicer Next, Bambu Studio or
  Orca keeps its colors and which part uses which. The dialog shows them instead
  of a filament choice, and each uses the same material's profile for this printer.
  Copies stay at 1, as the plate prints as it was saved.
- **Checking colors:** when a file uses two or more colors, the print dialog lists
  each with the slot it'll print from, warns if a slot looks wrong, and needs a
  tick before printing. Filament is charged to the slots you choose.
- Painting colors onto a model and placing parts by hand still need a desktop slicer.

## Timelapses

The hub records a timelapse of every print on printers with a camera, and the
**Timelapses** page lists them.

- **How:** camera frames during the print, plus one at the end. When the print
  finishes they become an MP4, cropped like the printer's camera (see **Crop**
  in the control panel). A **● REC** badge on the camera shows a recording in
  progress.
- **Settings,** per printer in Settings → Printers:
  - **Take a frame:** every layer (the default), every 2, 5 or 10 layers, or on
    a timer. More frames make a smoother, longer video. Printers that don't
    report layers use the timer, or every 20 seconds if you chose layers.
  - **Video length:** Automatic is 10 seconds plus 5 per hour printed, up to a
    minute, so a 4-hour print gets about 30 seconds. Or pick a set length.
  - A video can only be as long as its frames allow, as it never plays slower
    than 4 frames a second. A flat part with 15 layers has 16 frames, or about
    5 seconds, so use a timer for those: every minute on a 3-hour print gives
    about 180 frames.
  - Changes apply from the next frame, and to the video when the print ends.
    Finished videos stay as they are.
- **Size on disk:** the Timelapses page shows the total and each video's size,
  and Settings → Storage breaks down what the hub keeps.
- **Watch, download or delete** them on the Timelapses page. Cancelled prints
  get a video too, marked as such.
- **Turn it off** with the same setting (Record a timelapse of every print).
- **Printers' own timelapses:** Klipper printers with moonraker-timelapse and
  OctoPrint printers list their videos under **On your printers**, played and
  downloaded through the hub.
- The Kobra X and Adventurer 5M Pro keep their own timelapses on the printer
  (USB export) or in the maker's cloud app, with no local way to fetch them, so
  the hub records its own.
- Frames are taken from the camera's snapshot address, or else grabbed from
  the live stream with FFmpeg (included in the Docker image). Running without
  Docker needs FFmpeg installed for the videos.

## Job log

While the hub is running, it logs every print by itself: start, finish and
outcome (completed, cancelled or failed), the file name, and print time. Jobs
are saved in `data/jobs.json`.

- **Items per plate:** type how many items a plate makes into any of its jobs
  (e.g. `4`). That number becomes the default for the model, so every
  later reprint counts 4. Earlier jobs of that model that never got a
  count are filled in too.
- **Grouping:** re-slices of the same model count together. The slicer's date
  prefix, filament, layer height and time suffix are stripped, so
  `1024-1448-Bracket_plate(01)_PLA_0.2_11h0m.gcode` and
  `1021-0900-Bracket_plate(01)_PLA_0.2_11h2m.gcode` both count as **Bracket**.
- **All prints** lists every job. **By item** adds them up per model: which
  printers made it, items, plates, print hours and failures. Click an item to
  see its prints. Both follow the filters for period (today, 7 days, 30 days,
  month, year), printer, and the search box.
- **Reprint** starts the same file on the same printer. The button is
  enabled when that printer is idle.
- **Add past prints…** back-fills prints made before the hub was logging
  (plates × items per plate, hours per plate, date).
- **Export CSV** downloads the whole log.
- Prints made while the hub isn't running aren't seen. If the hub restarts
  mid-print, the job is still logged when the print finishes; if the print
  ended while the hub was down, the job shows as **Unknown** and you can set
  its outcome by hand.
