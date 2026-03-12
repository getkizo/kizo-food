# Changelog

All notable changes to BaanBaan Counter will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.0.0] — 2026-03-12

### Added

- Initial open-source release.
- WebSocket client connecting to any server implementing the [counter protocol](COUNTER_WS_SPEC.md).
- Auto-reconnect with exponential backoff (max 30 s) on disconnect.
- Runtime credential provisioning via `config` message — no credentials embedded in the APK.
- Payment flow: tip selection → signature capture → card present payment (tap/insert/swipe).
- Payment result reporting (`approved` / `declined` / `error` / `cancelled`) back to the server.
- Optional receipt email capture forwarded to the server via `receipt_request`.
- Finix D135 Bluetooth card reader integration via Finix PAX MPOS Android SDK 3.5.0.
- Landscape-locked, always-on display suitable for counter terminal deployment.
- Tested on Lenovo Tab One ZAF00008US (8", Android 13).
- Built with Kotlin, Jetpack Compose (Material 3), Hilt, OkHttp, and Kotlinx Serialization.
