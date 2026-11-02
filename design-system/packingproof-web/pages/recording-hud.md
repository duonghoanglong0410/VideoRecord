# Recording HUD & Cinema Player Overrides (`recording-hud.md`)

> **PROJECT:** PackingProof Web
> **Applies To:** `/record` (`RecordingPage.tsx`, `ScannerView.tsx`) and the Video Player theater surface inside `/videos/:id` (`VideoDetailPage.tsx`)
> **Overrides:** `design-system/packingproof-web/MASTER.md`

---

## 1. Dark Surface Tokens (High-Contrast Warehouse Viewfinder & Cinema)

| Role | Hex | Usage |
| :--- | :--- | :--- |
| **HUD / Cinema Stage** | `#09090B` (`zinc-950`) | Camera viewfinder surround & video player frame |
| **HUD Control Bar** | `#18181B` (`zinc-900`) | Top locked-tracking bar & bottom thumb action deck |
| **HUD Border** | `#27272A` (`zinc-800`) | Crisp non-distracting divider on dark surfaces |
| **HUD Primary Text** | `#FAFAFA` (`zinc-50`) | Locked tracking code, timer (`00:42`), byte counter |
| **REC Active Accent** | `#EF4444` (`red-500`) | Pulsing recording dot & stop/finish ring |

---

## 2. Mobile Warehouse Ergonomics (`/record`)

- **One-Task-At-A-Time Flow:**
  1. **Shop/Warehouse Compact Header Chip:** Auto-collapses into a compact top pill when the operator has a preselected Shop + Warehouse (tap to expand `<select>` controls only when switching).
  2. **Scan Stage:** Large barcode/QR viewfinder + `>= 48×48px` Torch toggle + secondary Manual Code button.
  3. **Confirm Tracking Sheet:** Large `JetBrains Mono` tracking number, carrier chip, duplicate warning banner, primary CTA (`Xác nhận mã & Tạo phiên quay`), and secondary file-import section when `canImportVideo` is granted.
  4. **Locked Recording HUD:** Sticky top bar (`locked-tracking-number` + `Đang quay` badge + `recording-timer` + `recording-bytes`), single-row pre-record toggles (`1080p/720p`, `Dọc/Ngang`, optional Audio) hidden once recording starts, and thumb-zone `>= 56px` primary Start/Finish CTA.

---

## 3. Hardware Compositor Invariant (CRITICAL — DO NOT REMOVE)

To prevent Chromium/Android 16/HyperOS LTPO `SurfaceControl` hardware overlay promotion bugs (black viewfinder or display Hz drop during recording):
- Parent wrapper around live camera `<video>` MUST preserve `border-radius: 12px; overflow: hidden; contain: layout paint;`.
- `.camera-video` MUST preserve `border-radius: 12px; transform: translateZ(0) rotate(0.01deg); backface-visibility: hidden;`.
- **Forbidden on active camera `<video>`:** Never apply `backdrop-filter: blur(...)`, animated `box-shadow`, or CSS filter effects over the live `<video>` stream.
