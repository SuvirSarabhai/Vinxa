---
name: "Vinxa — Offline Meeting Memory Design System"
description: "Calm, practical light-mode Windows desktop design system for Vinxa, an offline-first meeting transcription and meeting-memory application."
---

## Overview

Vinxa is a calm, polished, practical Windows desktop interface for offline-first meeting transcription and meeting memory. Inspired by Velloe's airy, low-glare aesthetic, it pairs warm off-white backgrounds (`#F5F5F0`) and crisp white surfaces (`#FFFFFF`) with soft mint accents (`#DFF6EE`), deep teal typography (`#113032`, `#1C3B3D`), and selective cyan (`#07D2E0`) reserved strictly for primary actions and active selection states.

The interface avoids visual clutter, decorative imagery near transcript reading areas, and heavy shadows—relying instead on an 8px spacing grid, thin neutral borders (`#E8E8E4`), generous whitespace, and clear semantic status indicators for recording, paused, and error states.

## Colors

The palette prioritizes reading comfort during long meetings while keeping primary controls and live status immediately scannable.

- **Primary Cyan (`#07D2E0`):** Reserved selectively for primary action buttons (such as Start and Confirm and Start), active tabs, and selection states, paired with deep teal (`#113032`) text for high contrast.
- **Teal Ink (`#113032`, `#1C3B3D`, `#4A7275`):** Deep teal for headings and icons, dark teal for body and transcript text, and muted teal-slate for secondary metadata and timestamps.
- **Warm & Mint Surfaces (`#F5F5F0`, `#FFFFFF`, `#F0FAF7`, `#DFF6EE`):** Warm off-white application canvas, pure white cards and transcript panels, soft mint-tinted navigation surfaces, and mint highlight containers.
- **Semantic Status:** Red for active recording and errors (always paired with explanatory text), amber for paused states and timeline gaps.

```yaml
colors:
  primary: "#07D2E0"
  on-primary: "#113032"
  primary-hover: "#06BAC7"
  primary-container: "#DFF6EE"
  on-primary-container: "#113032"
  secondary: "#113032"
  on-secondary: "#FFFFFF"
  background: "#F5F5F0"
  on-background: "#1C3B3D"
  surface: "#FFFFFF"
  on-surface: "#1C3B3D"
  surface-nav: "#F0FAF7"
  surface-mint: "#DFF6EE"
  surface-subtle: "#F5F5F0"
  heading-teal: "#113032"
  text-secondary: "#4A7275"
  border-neutral: "#E8E8E4"
  outline: "#4A7275"
  outline-variant: "#E8E8E4"
  recording: "#DC2626"
  on-recording: "#FFFFFF"
  recording-container: "#FEE2E2"
  on-recording-container: "#991B1B"
  paused: "#D97706"
  on-paused: "#2A2A2A"
  paused-container: "#FEF3C7"
  on-paused-container: "#92400E"
  error: "#DC2626"
  on-error: "#FFFFFF"
  error-container: "#FEE2E2"
  on-error-container: "#991B1B"
  success: "#0D9488"
  on-success: "#1D1D1D"
```

## Typography

**Inter** is used temporarily across headings, body copy, navigation, and controls because **Stack Sans Notch** (headings, weight 700) and **Stack Sans Headline** (body, weight 400) are not hosted on Google Fonts. **JetBrains Mono** is used for keyboard shortcut caps and tabular timestamps where monospaced clarity helps scanning.

- **Headings:** Weight `700` in `#113032`.
- **Body & Transcripts:** Weight `400` in `#1C3B3D`, `tabular-nums` for durations and timestamps.
- **Navigation & Labels:** Weight `500`.
- **Buttons:** Weight `600`.

```yaml
typography:
  headline-lg:
    fontFamily: "Inter"
    fontSize: 24px
    fontWeight: 700
    lineHeight: 32px
    letterSpacing: -0.3px
  headline-md:
    fontFamily: "Inter"
    fontSize: 18px
    fontWeight: 700
    lineHeight: 24px
    letterSpacing: -0.2px
  headline-sm:
    fontFamily: "Inter"
    fontSize: 16px
    fontWeight: 700
    lineHeight: 22px
    letterSpacing: -0.1px
  title-md:
    fontFamily: "Inter"
    fontSize: 15px
    fontWeight: 600
    lineHeight: 22px
    letterSpacing: 0px
  body-lg:
    fontFamily: "Inter"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 24px
    letterSpacing: 0px
  body-md:
    fontFamily: "Inter"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 21px
    letterSpacing: 0px
  body-sm:
    fontFamily: "Inter"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 18px
    letterSpacing: 0px
  label-lg:
    fontFamily: "Inter"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px
    letterSpacing: 0px
  label-md:
    fontFamily: "Inter"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 18px
    letterSpacing: 0px
  label-sm:
    fontFamily: "Inter"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16px
    letterSpacing: 0.1px
  mono-sm:
    fontFamily: "JetBrains Mono"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16px
    letterSpacing: 0px
```

## Layout & Spacing

Vinxa uses a strict **8px spacing system** (with a 4px micro-step for compact badge padding and icon gaps). Desktop windows use clean CSS Grid and Flexbox layouts with generous breathing room and restrained density, keeping the primary session action immediately visible above the fold.

```yaml
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
```

## Elevation & Depth

Hierarchy relies on **tonal surface contrast** (`#F5F5F0` canvas, `#F0FAF7` navigation, `#FFFFFF` primary cards) paired with **thin 1px neutral borders (`#E8E8E4`)** and **subtle ambient shadows** (`0 2px 8px rgba(17, 48, 50, 0.04)` for cards, `0 12px 32px rgba(17, 48, 50, 0.10)` for floating overlays). The expanded and collapsed overlays use a translucent white surface (`rgba(255, 255, 255, 0.92)`) with a thin mint border (`#DFF6EE`).

## Shapes

Cards, panels, and modal windows use **12px to 16px corner radii** for a calm, approachable Windows desktop feel, while buttons, inputs, and status pills use **8px to full-pill radii**.

```yaml
rounded:
  xs: 4px
  sm: 8px
  DEFAULT: 12px
  md: 12px
  lg: 16px
  full: 9999px
```

## Motion & Micro-interaction

Interactions are crisp and understated—no decorative loops or layout-shifting animations. State transitions (hover, focus rings, status badge shifts) land within 120ms, while overlays and modal panels enter smoothly within 200ms.

```yaml
motion:
  state-change:
    duration: 120ms
    delay: 0ms
    timingFunction: ease-out
  surface-enter:
    duration: 200ms
    delay: 0ms
    timingFunction: cubic-bezier(0.2, 0, 0, 1)
  surface-exit:
    duration: 150ms
    delay: 0ms
    timingFunction: cubic-bezier(0.3, 0, 1, 1)
```

## Voice & Content Strategy

- **Tone:** Calm, transparent, and practical. Clearly distinguish current Phase 2 demo mode from future-phase capabilities.
- **Capitalisation:** Sentence case for headings, labels, and descriptions; concise action verbs for buttons (`Start Session`, `Confirm and Start`, `Save Shortcuts`, `Show Overlay`).
- **Boundaries:** Always keep the `Demo` badge visible on Phase 2 screens and state plainly that no live audio is captured. Label future-phase concepts explicitly as `Future phase`.
- **Timestamps & Unknowns:** Use `MM:SS` or `HH:MM:SS` tabular numerals for durations and transcript timestamps; display `Not specified` for unknown action-item owners or due dates.

## Components

Component implementations live as individual HTML sticker sheet files in
`components/`. Each file contains the canonical, styled HTML components with
`<!-- COMPONENT: name -->` comment markers. Read each file before use.

- **Badge** → `@components/badge.html` — `badge-numeric`, `badge-dot`
- **Button** → `@components/button.html` — `button-primary`, `button-icon`, `button-with-icon`
- **Card** → `@components/card.html` — `card-elevated`, `card-action`, `card-interactive`, `card-interactive-2`
- **Input Field** → `@components/input-field.html` — `input-field-text`, `input-field-icon`
- **Tabs** → `@components/tabs.html` — `tabs-horizontal`, `tabs-with-icon`
