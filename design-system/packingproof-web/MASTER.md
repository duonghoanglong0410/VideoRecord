# Design System Master File — PackingProof Web

> **LOGIC:** When building or reviewing a specific page, first check `design-system/packingproof-web/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> Otherwise, strictly follow the rules below.

---

- **Project:** PackingProof Web
- **Date:** 2026-10-31
- **Style:** Modern Flat SaaS + Focused Dark Camera/Cinema Surfaces (Hybrid Thực chiến)
- **Stack:** React 19 + TypeScript + Tailwind CSS v4 (`@tailwindcss/vite`) + `lucide-react` + Internal Shadcn-style Primitives
- **Accessibility Target:** WCAG AAA text contrast (`>= 7:1` body/muted text), `>= 44×44px` mobile touch targets, zero emoji icons, non-tech-friendly plain Vietnamese UI copy

---

## 1. Global Color Tokens

### Light SaaS Workspace (Default across Management, Search, Queue & Auth)

| Role | Hex | Tailwind / Token | Usage |
| :--- | :--- | :--- | :--- |
| **App Background** | `#F8FAFC` | `slate-50` | Page canvas background |
| **Surface Card** | `#FFFFFF` | `white` | Primary cards, tables, modals, sidebar |
| **Subtle Surface** | `#F1F5F9` | `slate-100` | Table headers, secondary chips, filter pills |
| **Border Default** | `#E2E8F0` | `slate-200` | Crisp 1px card & table dividers |
| **Text Primary** | `#0F172A` | `slate-900` | Headings, primary data, tracking codes (>15:1 contrast) |
| **Text Muted** | `#475569` | `slate-600` | Secondary labels, captions (>7:1 contrast; never `slate-400`) |
| **Brand Primary** | `#2563EB` | `blue-600` | Primary actions, active nav, focus rings |
| **Brand Hover** | `#1D4ED8` | `blue-700` | Primary button hover |

### Semantic Status Tokens (Always paired with a `lucide-react` SVG icon)

| Meaning | Text / Icon Hex | Surface Hex | Border Hex | Required Icon | Plain Vietnamese Copy Example |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Success / Stored** | `#15803D` | `#DCFCE7` | `#86EFAC` | `CheckCircle2` | *Đã lưu NAS* / *Đã lưu cục bộ (Local)* / *Hoàn chỉnh* |
| **Warning / In Progress / Interrupted** | `#B45309` | `#FEF3C7` | `#FCD34D` | `Clock` / `AlertTriangle` | *Đang tải lên* / *Bị gián đoạn* / *Chế độ thử nghiệm — lưu local* |
| **Danger / Active REC / Error** | `#B91C1C` | `#FEE2E2` | `#FCA5A5` | `CircleDot` / `XCircle` | *Đang quay* / *Cần xử lý lỗi* |
| **Evidence Hold** | `#4338CA` | `#E0E7FF` | `#A5B4FC` | `ShieldCheck` | *Đang giữ (Hold)* / *Khóa giữ bằng chứng* |
| **Info / Imported** | `#0369A1` | `#E0F2FE` | `#7DD3FC` | `FileVideo` / `Info` | *Tệp nhập (Imported)* |

---

## 2. Typography (100% Vietnamese Diacritic Support & LAN Offline Ready)

- **UI Sans Font:** `'Be Vietnam Pro', 'Inter', system-ui, -apple-system, sans-serif` (bundled locally via `@fontsource/be-vietnam-pro` so warehouse LAN environments without external internet render crisp Vietnamese diacritics immediately).
- **Data & Tracking Mono Font:** `'JetBrains Mono', ui-monospace, SFMono-Regular, monospace` with `font-variant-numeric: tabular-nums` (bundled via `@fontsource/jetbrains-mono`) — mandatory for Tracking Numbers (preserving leading `0`s and distinguishing `0`/`O`, `1`/`I`), Recording Timers (`00:42`), Byte Counters, and 2FA Recovery Codes.

---

## 3. Navigation & Responsive Breakpoints

- **Breakpoints:** Verify at `375px` (Mobile), `768px` (Tablet), `1024px` (Desktop Sidebar threshold), `1440px` (Wide Management).
- **Desktop (`>= 1024px`):** Left fixed `240px` Sidebar (`Vận hành` & `Quản trị` groups, hiding unauthorized links cleanly) + main content workspace (`max-w-7xl`).
- **Mobile (`< 1024px`):** Compact top bar + fixed 4-item Bottom Navigation Bar (`min-h-[56px]` + `env(safe-area-inset-bottom)`), auto-hidden while `recorderState.phase === 'recording'` to prevent accidental tap interruption.
- **Tables vs. Cards:** Semantic `<Table>` inside `.desktop-table-wrap` on `>= 768px`; clean stacked cards inside `.mobile-card-list` on `< 768px`.

---

## 4. Non-Negotiable UX & Anti-Pattern Rules

- **Zero Jargon on Primary Surfaces:** Never expose raw developer jargon (`tus`, `IndexedDB`, `chunks`, `Append-Only`, `Grant Ceiling`, `RFC 6238`, `HTTP Range 206`, `Asia/Ho_Chi_Minh`, raw `video.hold_updated` codes, or raw JSON) in primary views. Translate to plain Vietnamese via `frontend/src/shared/labels/`.
- **Progressive Disclosure (3-Layer Priority):**
  1. *Layer 1:* Primary action / visual status summary.
  2. *Layer 2:* Complete business data with icons, badges, and progress bars.
  3. *Layer 3:* Technical diagnostics (`MIME/codec`, `SHA-256`, raw Audit JSON) tucked inside `<details>` or `(i)` drawers.
- **No Emoji Icons:** Use `lucide-react` SVGs exclusively (`w-4 h-4` / `w-5 h-5`, `strokeWidth={2}`).
- **Stable Interactions:** `cursor-pointer` on all interactive controls, `transition-colors duration-150`, visible `focus-visible:ring-2 focus-visible:ring-blue-600`, zero layout-shifting hover scale transforms.
