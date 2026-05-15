# DoorDash Tablet — Bluetooth Printer Impersonation Investigation

**Status:** Parked — handshake reaches the app layer, but the DoorDash printer SDK rejects the Pi without sending any data bytes. See "Wall hit" at the end.

**Environment:**
- Pi 5 (BCM4345C0) on Debian 13 trixie, BlueZ 5.82, Python 3.13.5, `python3-bluez` system package
- DoorDash merchant tablet: Samsung (BT MAC `F4:F3:09:19:C3:2E`)
- Target mirror: Star TSP143IIIBI

## Goal

Make a Raspberry Pi 5 appear as a Star TSP143IIIBI Bluetooth printer so the DoorDash merchant tablet will pair with it and send print jobs over RFCOMM. The Pi then forwards the raw byte stream to a real TSP100III on the LAN (TCP:9100).

## Symptom

Every pairing attempt followed the same pattern, regardless of which identity fix we applied:

1. Tablet connects on BR/EDR.
2. SDP browse + service search — we respond.
3. Secure Simple Pairing (SSP) completes successfully (link key generated, AES-CCM encryption up).
4. Tablet opens L2CAP PSM 3 → RFCOMM session DLC 0 → DLC 2 (channel 1).
5. Both sides exchange RFCOMM MCC Modem Status Commands (DTE/DCE ready signals).
6. **~77 ms of silence** — no UIH data frames in either direction.
7. Tablet sends RFCOMM `DISC` on DLC 2 and DLC 0.
8. L2CAP channels torn down.
9. Tablet issues MGMT `Unpair Device` (because the pair was `No Bonding`, so the link key is discarded).

Zero bytes of app-layer data were exchanged in either direction during the entire lifetime of the RFCOMM channel. The tablet reached the point where it could send print data, paused briefly, and then closed the connection cleanly.

## What was tried (in order)

### Phase 1 — Initial deployment
- Scaffolded the bridge from `scripts/install.sh` on a fresh Pi.
- Fixed `pybluez2` build failure on Python 3.13 by switching to the system-packaged `python3-bluez` with a `--system-site-packages` venv.
- Added `--compat` flag to `bluetoothd` (BlueZ 5.82 does not expose the legacy SDP socket otherwise, so `bluetooth.advertise_service()` would fail with `ENOENT`).
- Corrected the adapter-setup script (`bluetoothctl pairable-timeout` isn't a command in bluez 5.82; `agent on` conflicts with the dedicated `btprint-agent` service).
- **Outcome:** listener up, SPP record advertised on RFCOMM channel 1.

### Phase 2 — Discoverability
- Set friendly name via `hciconfig name` + `bluetoothctl system-alias`.
- Cycled the adapter to flush EIR.
- Observed that the tablet cached the adapter under its pre-setup name (`cosa`) and the original Audio class (`0x6c0000`). Forget/rescan on the tablet fixed this.
- **Outcome:** device visible in scan lists as the configured name.

### Phase 3 — Class of Device
- Original `setup-adapter.sh` set CoD to `0x060480`. That value decodes as **Major = Audio/Video (0x04)**, not Imaging. Phone saw the Pi as "headphones" because the minor bits made no sense for A/V.
- Fixed to `0x000680` (Major = Imaging 0x06, Minor = Printer bit 7).
- **Outcome:** correctly classified as "Imaging, Printer".

### Phase 4 — SDP record hygiene
- BlueZ by default registered audio/phone profiles (A2DP Source/Sink, AVRCP CT/TG, Handsfree AG/HF, SIM Access) with the Serial Port record — any client doing a full SDP browse saw us as an audio device.
- Disabled `a2dp,avrcp,sap,network,input,hog,bap,mcp` via `bluetoothd --noplugin` in a systemd drop-in.
- Hands-Free AG/HF records persisted (registered by WirePlumber / PipeWire's `libspa-0.2-bluetooth` plugin, not BlueZ).
- Suppressed WirePlumber's `monitor.bluez` profile via `/etc/wireplumber/wireplumber.conf.d/51-disable-bluetooth.conf`.
- **Outcome:** SDP now lists only Generic Access/Attribute/Device Information (BLE GATT essentials) plus our SPP on channel 1.

### Phase 5 — Device Identification (PnP) record
- Added `DeviceID = usb:0519:0003:0100` to `/etc/bluetooth/main.conf` ([General] section) to advertise Star Micronics vendor ID over SDP.
- Initial attempt used `usb:0x0519:...`; BlueZ silently dropped the config because its parser rejects the `0x` prefix (confirmed from the sdp XML dump still showing Linux Foundation VID `0x1d6b`).
- **Outcome:** `Modalias: usb:v0519p0003d0100` published correctly.

### Phase 6 — BT MAC spoofing
- The Pi's hardware MAC starts with `88:A2:9E` (Raspberry Pi Trading). Suspected the DoorDash app whitelisted Star Micronics OUIs.
- Used Broadcom's vendor HCI command `ogf=0x3F ocf=0x001` to rewrite BDADDR to `00:11:62:12:34:56` (Star Micronics OUI + synthetic tail).
- Not persistent — the BCM4345C0 firmware reloads the original MAC on every reset. `setup-adapter.sh` now reapplies it on each boot before BlueZ starts registering SDP records.
- Re-applied `Class = 0x000680` in `main.conf` so BlueZ doesn't overwrite it when re-registering profiles.
- **Outcome:** pairing with the new MAC works end-to-end (phone test completed: link key, AES-CCM, persistent bond). Tablet still disconnects at the same point.

### Phase 7 — ASB on connect (speculative)
- Hypothesized that a real Star TSP143IIIBI pushes a 9-byte "Automatic Status Back" packet immediately on RFCOMM open and the app times out waiting for it.
- Modified the listener to `sendall()` `0x23 0x41 0x00 0x00 0x00 0x00 0x00 0x00 0x00` on accept.
- `btmon` confirmed the bytes went on the air. Tablet received them and **disconnected *faster*** (41 ms vs the prior 77 ms baseline) — the bytes were actively rejected, not the missing-bytes timeout.
- Connecting to the real TSP100III on TCP:9100 and reading for 2 s returned **zero bytes** — real Star printers don't auto-push on connect, so this hypothesis was wrong.
- Reverted the change.

## What definitively doesn't matter

Controlled against the baseline (Pi's hardware MAC, generic CoD, Linux Foundation PnP):

| Knob | Changed from → to | Effect on DoorDash handshake |
|---|---|---|
| BT MAC OUI | `88:A2:9E` → `00:11:62` | None (same DISC at same point) |
| Device name | `TSP100-D7504` → `TSP100-123456` | None |
| CoD | `0x060480` → `0x000680` | Changed what the app *showed* in its UI but not the handshake |
| PnP Vendor ID | default Broadcom → `0x0519` (Star) | None |
| SDP pollution | default + AVRCP/HFP/A2DP → SPP-only | None |
| Initial data bytes | none → 9-byte ASB | Made it worse |

Pairing layer is fine. The filter is at the app layer, after RFCOMM is established, using a signal we can't see in `btmon`.

## Phase 8 — second-opinion follow-ups (2026-04-17 afternoon)

A review of this report suggested three more experiments. Results:

1. **CoD service bits** — changed from `0x000680` (no service bits, correct major) to `0x140680` (Imaging/Printer + **Rendering** + **Object Transfer**). Confirmed via `hciconfig -a`: `Service Classes: Rendering, Object Transfer`. **No change to handshake.**
2. **SPP Service Name / Provider Name** — changed the `advertise_service()` call from `"Star TSP100"` (no provider) to `"TSP100"` + `provider="STAR MICRONICS"`. Confirmed in `sdptool browse local`: `Service Name: TSP100 / Service Provider: STAR MICRONICS`. **No change to handshake.**
3. **BLE disabled** — set `ControllerMode = bredr` in `main.conf` so the Pi stops advertising Generic Access/Attribute/Device Information over ATT PSM 31. Hypothesis: a real BR/EDR-only Star printer shouldn't show BLE GATT services in its SDP browse; the app might reject dual-mode devices. Confirmed via `sdptool browse local`: only `Service Name: TSP100 Channel: 1` remains, no BLE records. **No change to handshake.**

Also verified against the **SDP-fetch-in-silent-window** hypothesis: captured `btmon` shows **zero SDP queries between `Encryption Change` and `RFCOMM: Disconnect`**. The reject decision is made from state the app already has in hand from the three pre-pair SDP queries (PnP → our Star record; L2CAP-UUID browse; Serial Port). No encrypted post-pair SDP fetch happens.

Side fixes applied during this phase (separate issues that surfaced):

- Added `hostname` to the `bluetoothd --noplugin` list — the plugin was overwriting our HCI Name with the Pi's hostname (`cosa`) after our adapter-setup ran, so phones briefly saw the device as "cosa" with a printer icon.
- Persisted `Class = 0x140680` in `/etc/bluetooth/main.conf` because BlueZ re-applies `main.conf` class at its own lifecycle events and would otherwise stomp our `hciconfig class` setting.

## Wall hit — what we don't know

The DoorDash app's StarIO-derived printer SDK decides to reject within ~77 ms of RFCOMM opening, *before either side sends any app-layer data*. The decision is being made from something already-on-the-wire that we have not been able to identify:

- Possibly a vendor-specific SDP attribute on a record type we're not publishing (`0x010X` in Star records, model name string, firmware version, supported-command bitmap).
- Possibly a specific L2CAP PSM the app probes (vendor-reserved printer PSM) whose absence flags us as non-Star.
- Possibly L2CAP extended feature bits (the BCM4345C0 advertises slightly different EFS from a Broadcom chip in a Star printer).
- Possibly RFCOMM modem-status flag values — both sides currently send `fc=0 rtc=1 rtr=1 ic=0 dv=1`, which is textbook correct, but a real Star might set `fc=1` or some vendor-extension bit.

## Paths forward (if anyone picks this up)

Ranked by ROI:

1. **Capture a real Star printer + DoorDash tablet handshake.** Requires a hardware sniffer near both devices (Ellisys, Sniffle on nRF52840 ~$50, or Ubertooth One). Once you have the ground-truth byte pattern on the wire, impersonation becomes deterministic.
2. **`adb logcat` on the merchant tablet during the failed connect.** The StarIO SDK logs its rejection reason at WARN or INFO level by default. Blocked here because the DoorDash tablet is locked down to the app with no access to Android system settings or developer mode.
3. **Reverse-engineer the DoorDash APK's printer module.** Time-intensive but definitive. The Star validation logic lives in a small number of classes inside the bundled `StarIO_Android` JAR.
4. **Pivot to Epson TM-m30II / UberEats.** Started this swap (MAC `00:26:AB`, PnP `usb:04B8:0E15`, name `TM-m30II-012345`) but stopped before testing. The Epson ePOS-Print SDK is reported to be less strict. Note: even if it pairs, the byte stream arriving is ESC/POS; forwarding to a Star TSP100III requires either (a) flashing the TSP100III's ESC/POS firmware, (b) building an ESC/POS → Star Line transpiler, or (c) parsing ESC/POS and re-rendering via the existing `receiptline` raster pipeline used elsewhere in the Merchant project.

## Files changed during the session

All in `v2/tools/tsp-bridge/`:

- `requirements.txt` — removed `pybluez2` (replaced by system `python3-bluez`).
- `scripts/install.sh` — installs `python3-bluez`; venv now uses `--system-site-packages`.
- `bin/setup-adapter.sh` — sets MAC via BCM vendor HCI, sets name + CoD, drops broken `pairable-timeout` and `agent on`; currently configured for Epson TM-m30II (see Phase 4-6 for Star-profile values).
- `systemd/btprint-forwarder.service` — printer IP `192.168.1.100`.
- `config/config.toml.example` — matching printer IP.

Pi-side system changes (not in the checkout — reapply manually on a fresh Pi):

- `/etc/systemd/system/bluetooth.service.d/10-compat.conf` — `bluetoothd --compat --noplugin=a2dp,avrcp,sap,hfp,hog,hid,input,network,bap,mcp,mcs,gmap`.
- `/etc/bluetooth/main.conf` — `Class = 0x000680`, `DeviceID = usb:04b8:0e15:0100` (or `usb:0519:0003:0100` for Star).
- `/etc/wireplumber/wireplumber.conf.d/51-disable-bluetooth.conf` — disables PipeWire's BlueZ monitor.
