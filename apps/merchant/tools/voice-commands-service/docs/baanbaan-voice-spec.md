# Kizo Voice Command Service

**Functional & Technical Specification**
Version 0.1 — Draft
Author: JJ Dubray / Cognitive Fab LLC
Target: Kizo POS, Kirkland deployment

---

## 1. Overview

Kizo currently requires physical interaction with the Android tablet running the POS UI. This spec defines a **voice command module** — an Android foreground service packaged inside the existing Kizo APK that lets staff trigger common POS actions hands-free via a Bluetooth push-to-talk (PTT) mic worn on the person.

The service does not replace the UI. It is a thin voice-to-HTTP bridge that calls the same Kizo server APIs the UI already uses. No new server endpoints, no duplicated business logic, no changes to the Pi backend beyond an optional device-token auth flow.

**Packaging decision:** Voice functionality ships as a `<service>` component inside the existing Kizo APK, not a separate app. Single install, single update cycle, direct access to the UI app's auth state and API client code, no cross-process IPC or `sharedUserId` gymnastics. The service runs in its own process (`android:process=":voice"`) so a crash in voice doesn't touch the UI, but both live in the same APK signed with the same key.

### 1.1 Goals

- Hands-free execution of a closed set of high-frequency POS actions (print bill, start payment, etc.) from anywhere in the restaurant.
- Fully on-device speech recognition. No cloud STT dependency.
- Zero changes to Kizo server logic. The voice service is indistinguishable from the UI on the wire.
- Survives tablet reboots, backgrounding, and memory pressure without staff intervention.

### 1.2 Non-goals

- Open-vocabulary dictation or natural conversation.
- Replacing the touch UI.
- Multi-user voice profiles or speaker identification.
- Voice-driven menu editing, reporting, or admin functions.
- Guest-facing voice interaction.

---

## 2. Functional Specification

### 2.1 User flow

1. Staff member wears a paired Bluetooth earpiece with a hardware PTT button.
2. Presses and holds the PTT button.
3. Speaks a command: *"Print bill table four."*
4. Releases the button.
5. Within ~1 second, the service executes the action and speaks a confirmation back through the earpiece: *"Bill printed, table four."*
6. On ambiguous or failed recognition, service responds *"Say again"* or a specific error: *"Table four has no open order."*

Press-and-hold is the only trigger. No wake word. No continuous listening.

### 2.2 Command vocabulary (v1)

Closed grammar. Unrecognized phrases are rejected, not interpreted.

| Intent | Example utterances | API action |
|---|---|---|
| `PRINT_BILL` | "print bill table N", "bill table N", "print the bill for table N" | `POST /api/orders/{id}/print-bill` |
| `START_CARD_PAYMENT` | "start card payment table N", "card payment table N", "charge table N" | Stage bill amount on Finix terminal for open order on table N. Customer taps card to complete. |
| `PRINT_KITCHEN_TICKET` | "print kitchen table N", "fire table N" | `POST /api/orders/{id}/print-kitchen` |
| `OPEN_TABLE` | "open table N", "new table N" | `POST /api/tables/{N}/open` |
| `CLOSE_TABLE` | "close table N" | `POST /api/tables/{N}/close` |
| `STATUS` | "status table N", "table N status" | Read-only lookup, TTS summary |
| `CANCEL` | "cancel", "never mind" | Abort any in-flight confirmation prompt |

Table numbers accepted: 1–99, spoken as cardinals ("four", "twenty-two"). Grammar must accept both "table four" and "table number four."

### 2.3 Confirmation policy

**No voice-side confirmation for any command.** All intents execute immediately on recognition, and the TTS confirms after the fact.

Rationale: no command triggers irreversible action purely from voice. `START_CARD_PAYMENT` only stages the bill amount on the Finix terminal — the customer must still physically tap or insert a card for anything to happen. `CLOSE_TABLE` is gated server-side by existing business rules (can't close an unpaid order); the server rejects invalid closes regardless of how they're triggered. Printing is cheap to redo.

Confirmation-style prompts (`"say yes to confirm"`) add latency and friction for no safety benefit here, so they're out of v1.

The only voice-side fallback is **misrecognition**: if Vosk returns `[unk]` or the intent parser can't match, TTS replies *"Didn't catch that, say again."* No API call is made.

### 2.4 Audio feedback

All responses are synthesized by on-device Android TTS and played back through the same BT earpiece used for capture. Responses are kept short (under 3 seconds). Format:

- Success: *"[Action] table [N]."* e.g., *"Bill printed table four."*
- Confirmation request: *"[Action] table [N], [amount]? Say yes to confirm."*
- Error: Specific reason. *"Table four has no open order."* / *"No internet connection."* / *"Didn't catch that, say again."*

### 2.5 Out-of-band feedback

In addition to TTS, each command produces a toast-style notification on the Kizo tablet UI itself, so a second staff member watching the tablet can see what was triggered remotely. Tap the toast to see full command detail (transcript, intent, result).

### 2.6 Error handling (functional)

| Situation | Behavior |
|---|---|
| Unrecognized phrase | TTS: "Didn't catch that, say again." No API call. |
| Recognized intent, invalid table number | TTS: "Table [N] doesn't exist." |
| Valid command but server unreachable | TTS: "Server offline. Command not executed." Log to retry queue (no automatic retry in v1). |
| Valid command but business rule violation (e.g., closing unpaid table) | TTS relays the server's error message. |
| BT mic disconnected | Service enters degraded state. Persistent notification updated: "Voice: mic disconnected." |
| PTT pressed but no audio captured (mic muted/failed) | TTS: "No audio received." |

### 2.7 Non-functional requirements

- **Latency target:** ≤1.5 seconds from PTT release to TTS confirmation for local actions (print). ≤2.5 seconds for payment initiation.
- **Recognition accuracy target:** ≥95% intent accuracy on the closed grammar in typical restaurant ambient noise (60–70 dB).
- **Uptime:** Service must auto-recover from crashes and survive ≥7 days continuous operation without manual restart.
- **Privacy:** No audio leaves the tablet. No transcripts leave the tablet except as part of an API call that would have happened from the UI anyway.

---

## 3. Technical Specification

### 3.1 Architecture

```
┌─────────────────────────── Android Tablet ────────────────────────────┐
│                                                                        │
│  ┌─────────────────────── Kizo APK ────────────────────────────┐  │
│  │                                                                  │  │
│  │  Process: default                  Process: :voice              │  │
│  │  ┌───────────────────┐             ┌─────────────────────────┐  │  │
│  │  │ UI Activity       │             │ VoiceCommandService     │  │  │
│  │  │ (existing)        │             │ (foreground service)    │  │  │
│  │  │                   │             │                         │  │  │
│  │  │ - touch UI        │             │ - MediaSession (PTT)    │  │  │
│  │  │ - voice admin UI  │             │ - AudioRecord (BT SCO)  │  │  │
│  │  │ - receives voice  │             │ - Vosk (offline STT)    │  │  │
│  │  │   toasts          │◄── local ──►│ - CommandRouter         │  │  │
│  │  │ - watchdog ping   │  broadcast  │ - TextToSpeech          │  │  │
│  │  │                   │             │ - SQLite command log    │  │  │
│  │  └─────────┬─────────┘             └────────────┬────────────┘  │  │
│  │            │                                    │               │  │
│  │            │        shared: ApiClient,          │               │  │
│  │            │        Models, utilities           │               │  │
│  │            └────────────────┬───────────────────┘               │  │
│  └─────────────────────────────┼───────────────────────────────────┘  │
│                                │                                      │
└────────────────────────────────┼──────────────────────────────────────┘
                                 │
                                 ▼
                       ┌──────────────────────┐
                       │ Kizo Pi Server   │
                       │ (Bun + SQLite)       │
                       │                      │
                       │ /api/orders/*        │
                       │ /api/tables/*        │
                       │ /api/payments/*      │
                       └──────────────────────┘

        Bluetooth:
            ├─ HID profile → PTT button → MediaSession key events
            └─ HFP/SCO profile → mic audio + TTS playback
```

### 3.2 Module breakdown

| Module | Responsibility | ~LOC |
|---|---|---|
| `VoiceCommandService.kt` | Foreground service lifecycle, wiring | 150 |
| `BluetoothAudioManager.kt` | SCO setup, device selection, routing | 120 |
| `PttButtonHandler.kt` | MediaSession, key event → press/release callbacks | 80 |
| `VoskRecognizer.kt` | Model load, stream capture → final transcript | 100 |
| `GrammarBuilder.kt` | Build Vosk JSON grammar from command definitions | 60 |
| `IntentParser.kt` | Transcript → `Intent` object (enum + args) | 100 |
| `CommandRouter.kt` | `Intent` → HTTP calls via existing Kizo client | 200 |
| `ApiClient.kt` | OkHttp wrapper, shared with UI process | 80 |
| `TtsPlayer.kt` | TextToSpeech init, queue, route to SCO sink | 60 |
| `CommandLog.kt` | SQLite (Room) for command history | 80 |
| `BootReceiver.kt` | Restart service after device boot | 20 |
| `BatteryOptChecker.kt` | First-run battery whitelist check + prompt | 40 |
| **Total** | | **~1100** |

### 3.3 Packaging and process model

**Single APK.** The voice service is declared in the existing Kizo `AndroidManifest.xml`:

```xml
<service
    android:name=".voice.VoiceCommandService"
    android:process=":voice"
    android:foregroundServiceType="microphone"
    android:exported="false" />

<receiver
    android:name=".voice.BootReceiver"
    android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED" />
        <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
    </intent-filter>
</receiver>
```

**Separate process (`:voice`).** The service runs in its own OS process within the same APK. This gives us:

- Crash isolation — a Vosk segfault or audio driver issue takes down voice, not the POS UI. Android auto-restarts the `:voice` process without user-visible impact to the UI.
- Independent memory budget — Vosk model (~40 MB) lives in its own heap, doesn't fragment the UI process.
- Lifecycle decoupling — the UI can be swiped away from recents without killing voice, and vice versa.

**Trade-off:** Code in different processes can't share live objects. UI ↔ service communication uses one of:
- `LocalBroadcastManager` / `Intent` (fine for fire-and-forget events like "voice command triggered, show toast").
- `AIDL` or `Messenger` (needed if UI wants to query service state synchronously; overkill for v1).
- Shared on-disk state (auth token in `EncryptedSharedPreferences`, readable by both processes since same UID).

v1 uses broadcasts and shared prefs only. No AIDL.

**Shared code.** Both processes link the same code in the APK — `ApiClient`, data models, `AuthStore`, any utility classes. No duplication. When you fix a bug in the API client, both the UI and the voice service get the fix in the same APK build.

### 3.4 Service lifecycle

```kotlin
class VoiceCommandService : Service() {
    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, buildPersistentNotification())
        bluetoothAudio.initialize()
        vosk.loadModelAsync()              // ~1-2 sec warm-up
        pttHandler.register(::onPtt)
        tts.initialize()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY                // restart if killed
    }

    private fun onPtt(event: PttEvent) = when (event) {
        is PttEvent.Press   -> startCapture()
        is PttEvent.Release -> stopCaptureAndProcess()
    }

    private fun startCapture() {
        audioRecord.startRecording()
        vosk.reset()
        scope.launch { streamAudioToVosk() }
    }

    private fun stopCaptureAndProcess() {
        audioRecord.stop()
        val transcript = vosk.finalResult()
        val intent = intentParser.parse(transcript)
        val result = commandRouter.execute(intent)
        tts.speak(result.spokenResponse)
        commandLog.record(transcript, intent, result)
    }
}
```

Key points:
- `START_STICKY`: Android restarts the service if killed under memory pressure.
- Vosk model loaded once at service start, kept resident. Reset per command (fast).
- Capture is synchronous with PTT events — no wake word, no VAD needed.
- All processing after `stopCaptureAndProcess` happens on a background dispatcher; the PTT handler returns immediately.

### 3.5 Bluetooth audio (SCO)

Android 12+ API (`setCommunicationDevice`) is preferred. Fallback to `startBluetoothSco` for older devices if needed, but target tablet should be Android 12+.

```kotlin
fun routeToBluetoothEarpiece(): Boolean {
    val am = getSystemService(AudioManager::class.java)
    val bt = am.availableCommunicationDevices
        .firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        ?: return false
    return am.setCommunicationDevice(bt)
}
```

Both capture (AudioRecord with `VOICE_COMMUNICATION` source) and TTS playback automatically route to the SCO device once `setCommunicationDevice` succeeds. SCO is mono, 16 kHz — matches Vosk's expected sample rate.

**Known constraint:** While SCO is active, A2DP music on the tablet is suspended. Not relevant for POS use.

### 3.6 PTT button handling

The BT button is captured as media key events via `MediaSession`. This is the most reliable path on Android and works whether the button presents as Play/Pause, Voice Assistant, or a raw keycode.

```kotlin
mediaSession = MediaSession(this, "KizoVoice").apply {
    setCallback(object : MediaSession.Callback() {
        override fun onMediaButtonEvent(intent: Intent): Boolean {
            val key = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return false
            when (key.action) {
                KeyEvent.ACTION_DOWN -> pttCallback(PttEvent.Press)
                KeyEvent.ACTION_UP   -> pttCallback(PttEvent.Release)
            }
            return true
        }
    })
    isActive = true
}
```

**Hardware compatibility note:** Tested devices must be certified to emit standard HID media key events. Shokz OpenComm and most Jabra/Poly business headsets qualify. Some consumer BT buttons use proprietary companion-app protocols and will not emit media keys — these are **not supported**. A pre-purchase compatibility checklist should be maintained.

### 3.7 Speech recognition: Vosk

**Why Vosk over `SpeechRecognizer` / Whisper:**

- `SpeechRecognizer.createOnDeviceSpeechRecognizer()` (Android 13+) works but the API is less configurable and model behavior varies across OEMs.
- Whisper.cpp on Android is feasible but heavier and slower than needed for a closed grammar.
- Vosk accepts a **JSON grammar constraint** at recognition start. The recognizer literally cannot produce output outside the grammar, which eliminates an entire class of misrecognitions (e.g., "bring the bill" being heard as "print the bill").

**Model:** `vosk-model-small-en-us-0.15` (~40 MB, bundled in APK assets).

**Grammar example (generated at startup):**

```json
[
  "print bill table [one, two, three, ..., ninety nine]",
  "bill table [one, two, ..., ninety nine]",
  "start card payment table [...]",
  "charge table [...]",
  "print kitchen table [...]",
  "fire table [...]",
  "status table [...]",
  "yes", "no", "confirm", "cancel",
  "[unk]"
]
```

The `[unk]` token is what Vosk returns when the user says something outside the grammar — this is the signal for "didn't catch that."

### 3.8 Intent parsing

Post-Vosk, the transcript is already within the grammar, so parsing is a small regex table:

```kotlin
private val patterns = listOf(
    Regex("""(print )?bill table (?:number )?(\w+)""") to Intent.Type.PRINT_BILL,
    Regex("""(start card payment|charge|card payment) table (\w+)""") to Intent.Type.START_CARD_PAYMENT,
    Regex("""(print kitchen|fire) table (\w+)""") to Intent.Type.PRINT_KITCHEN_TICKET,
    // ...
)

fun parse(transcript: String): Intent {
    val normalized = transcript.lowercase().trim()
    for ((re, type) in patterns) {
        val m = re.matchEntire(normalized) ?: continue
        val tableNum = wordsToNumber(m.groupValues.last())
        return Intent(type, table = tableNum)
    }
    return Intent(Intent.Type.UNRECOGNIZED)
}
```

`wordsToNumber` handles "four" → 4, "twenty two" → 22, etc. Table range clamped to 1–99; out-of-range returns `UNRECOGNIZED`.

### 3.9 Command router and API client

`CommandRouter.execute(intent)` is the one place where voice logic meets Kizo's API. One function per intent. Example:

```kotlin
fun executePrintBill(table: Int): CommandResult {
    val order = api.getOpenOrderForTable(table)
        ?: return CommandResult.error("Table $table has no open order.")
    api.printBill(order.id)
    return CommandResult.success("Bill printed, table $table.")
}

fun executeStartCardPayment(table: Int): CommandResult {
    val order = api.getOpenOrderForTable(table)
        ?: return CommandResult.error("Table $table has no open order.")
    api.stageFinixPayment(order.id, order.totalCents)
    return CommandResult.success("Terminal ready, table $table, ${order.totalSpoken}.")
}
```

`api` is the **same `ApiClient` singleton** the UI uses, instantiated per-process. Both processes read the auth token from the shared `AuthStore` (an `EncryptedSharedPreferences` wrapper). The UI process writes on login; the voice process reads on each API call. Since both processes run under the same UID (same APK), they share the encrypted prefs file natively — no `sharedUserId` configuration needed.

**Token refresh:** If the API returns 401, the service re-reads the token from `AuthStore` (UI may have refreshed it in the other process). If still 401, the service surfaces a notification: "Voice: not logged in."

### 3.10 Authentication

The voice service uses whatever mechanism the Kizo UI already uses to reach the Pi server — nothing more. Concretely:

- Kizo currently runs on a local LAN behind a Cloudflare Tunnel. The API is not publicly exposed. Voice adds no new attack surface.
- The voice service reuses the existing `ApiClient` instance and whatever headers/cookies it already sends. If the UI doesn't authenticate, voice doesn't either.
- No device token provisioning, no separate voice-service credentials, no new server endpoints for auth.

If Kizo's auth model evolves later (e.g., per-staff login for audit trails), the voice service inherits it for free because it shares the `ApiClient`.

### 3.11 Local command log

SQLite via Room. One table:

```kotlin
@Entity(tableName = "command_log")
data class LoggedCommand(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val timestamp: Long,             // epoch millis
    val rawTranscript: String,       // what Vosk returned
    val intentType: String,          // enum name, or "UNRECOGNIZED"
    val intentArgs: String,          // JSON
    val apiEndpoint: String?,        // null if no API call made
    val apiStatus: Int?,             // HTTP status or null
    val apiResponseSnippet: String?, // first 500 chars of response body
    val spokenResponse: String,      // what TTS said back
    val latencyMs: Int               // press-release to TTS start
)
```

Retention: rolling 30 days, purged on service start. Log viewable from the Kizo UI admin screen (simple list + filters).

### 3.12 Boot and battery

**Boot receiver** (requires `RECEIVE_BOOT_COMPLETED` permission):

```kotlin
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            ContextCompat.startForegroundService(
                ctx, Intent(ctx, VoiceCommandService::class.java)
            )
        }
    }
}
```

**Battery optimization:** On first run (and after each OS update), check `PowerManager.isIgnoringBatteryOptimizations(packageName)`. If false, show a one-time setup screen in the UI app that walks the user through:
Settings → Apps → Kizo → Battery → Unrestricted.

On Samsung OEM Android, also need to disable "Put unused apps to sleep" for Kizo — an additional OEM-specific setting. Detection is imperfect; surface a reminder if the service is being killed repeatedly.

### 3.12 Permissions (AndroidManifest)

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

### 3.13 Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| Vosk Android | 0.3.47+ | On-device STT |
| OkHttp | 4.x | HTTP client for Kizo API |
| Room | 2.x | SQLite command log |
| AndroidX MediaSession | latest | PTT button events |
| Kotlin Coroutines | 1.7+ | Async |

No third-party cloud SDKs. No Firebase.

---

## 4. Hardware

### 4.1 Tablet

- Android 12+ required (for `setCommunicationDevice`).
- Minimum 3 GB RAM.
- Must support simultaneous BT HFP + WiFi (effectively any tablet made after 2020).
- Tested: [fill in once confirmed].

### 4.2 Bluetooth headset / earpiece

Requirements:
- Standard BT HID for button (emits media-key events).
- HFP support (not just A2DP).
- Physical PTT-usable button (the play/pause button works fine).
- All-day battery preferred (8+ hours).

Tested and recommended:
- Shokz OpenComm / OpenComm2 (bone conduction, leaves ears open — good for restaurant).
- Jabra Engage / Evolve series.

Not supported:
- AirPods (no standard HID button events on non-Apple hosts).
- Cheap no-name BT mics with companion-app-only buttons.

---

## 5. Integration points with existing Kizo

### 5.1 Server-side (Pi)

- **Required:** None. Voice uses existing endpoints as-is.
- **Optional:** `X-Client-Kind: voice` header from voice service, logged server-side for analytics.

### 5.2 UI process (same APK)

- Receives `LocalBroadcastManager` events from the voice service and shows toast notifications for triggered commands.
- Admin screen additions: voice command log viewer, BT mic status, test-recognition button.
- Optional: watchdog that pings the voice service periodically and restarts it if gone (covers OEM battery-killer edge cases).

### 5.3 Existing Kizo APIs

All voice-triggered actions map 1:1 to existing UI-triggered endpoints. No new endpoints required for v1.

---

## 6. Testing

### 6.1 Unit tests

- `IntentParser`: table of (transcript, expected intent) pairs, ~50 cases, including edge cases ("table zero", "table one hundred", malformed phrases).
- `GrammarBuilder`: verify generated JSON grammar is valid and includes all commands × table numbers.
- `CommandRouter`: mock `ApiClient`, verify correct endpoint called per intent, verify error path responses.

### 6.2 Integration tests

- Recorded audio samples of each command at 3 noise levels (quiet, ambient restaurant, loud peak). Feed through full pipeline, measure recognition accuracy.
- API integration against a staging Pi, full round-trip.

### 6.3 Field test plan

Before full deployment at Kirkland:
1. Single staff member, off-hours, 50 commands across the vocabulary.
2. Two staff members, lunch shift, observed session.
3. Full shift soak test with command log review.

Acceptance gates:
- ≥95% recognition accuracy on the command vocabulary in ambient noise.
- Zero unintended API calls (no command executed that the user didn't actually speak).
- Service uptime ≥7 days without manual intervention.

---

## 7. Risks & open questions

| Risk | Mitigation |
|---|---|
| BT headset button doesn't emit media keys on target hardware | Validate with specific SKU before ordering in quantity. Maintain compatibility list. |
| SCO audio codec produces poor recognition in loud restaurant | Test at target site under peak noise. Consider bone-conduction headset (ears open, less feedback). |
| Samsung/OEM battery killer terminates service | Battery exemption setup flow + periodic watchdog ping from UI process to restart service if gone. |
| Accidental button press triggers unintended command | No voice command is irreversible (printing is cheap; card payment still requires customer card tap). Worst case: one misprinted ticket. |
| Two staff both speak commands simultaneously | v1: last-write-wins at server; log timestamps will show conflicts. v2 could add per-device command queueing. |

Open questions for JJ:

1. Scope of v1 vocabulary — is the table in §2.2 the right set, or should additional commands ship in v1 (adding items to orders, calling server, etc.)?
2. TTS voice — default system voice, or invest time in a more natural one? Default is fine for v1 in my view.
3. Do we want a server-side broadcast so the voice command also shows up on other Kizo clients (e.g., kitchen display) as a toast? Useful for coordination but adds surface area.

---

## 8. Rollout plan

**Phase 0 — Prototype (1 week)**
Bare-bones service, hardcoded one command (print bill), proof of E2E flow with target hardware. Validates BT compatibility and latency targets.

**Phase 1 — v1 Feature-complete (2–3 weeks)**
Full vocabulary, intent parser, command router covering all intents in §2.2, command log, boot receiver, battery exemption flow, admin UI additions.

**Phase 2 — Field test at Kirkland (1 week)**
Single-device deployment, daily review of command log, tuning of grammar and intent patterns.

**Phase 3 — Production**
Rollout to full floor staff at Kirkland. Performance metrics: commands/shift, recognition accuracy, user-reported errors.

**Phase 4 — Kizō packaging**
Extract as a reusable module (`kizo-voice`) in the Kizō monorepo. Document integration pattern for other Kizō verticals (retail, services) where voice-triggered POS actions could apply.

---

## 9. Appendix

### 9.1 Glossary

- **PTT** — Push-to-talk.
- **HFP** — Hands-Free Profile, the BT profile used for bidirectional voice audio.
- **SCO** — Synchronous Connection-Oriented link, the underlying BT link used by HFP.
- **A2DP** — Advanced Audio Distribution Profile, stereo music playback. Not used here.
- **HID** — Human Interface Device, the BT profile used for the PTT button events.
- **STT** — Speech to Text.
- **TTS** — Text to Speech.
- **Vosk** — Open-source offline speech recognition toolkit.

### 9.2 Reference links

- Vosk Android: https://alphacephei.com/vosk/android
- Android MediaSession: https://developer.android.com/reference/android/media/session/MediaSession
- `setCommunicationDevice`: https://developer.android.com/reference/android/media/AudioManager#setCommunicationDevice(android.media.AudioDeviceInfo)
