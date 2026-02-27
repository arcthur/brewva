# Bento Paradigm Reference

Architecture and motion philosophy for modern SaaS dashboards and feature sections.
Enforces a "Vercel-core meets Dribbble-clean" aesthetic with perpetual physics.

## Core Design Philosophy

- **Aesthetic:** High-end, minimal, functional.
- **Palette:** Background `#f9fafb`. Cards pure white (`#ffffff`) with `border-slate-200/50`.
- **Surfaces:** `rounded-[2.5rem]` for major containers. Diffusion shadow: `shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05)]`.
- **Typography:** Strict `Geist`, `Satoshi`, or `Cabinet Grotesk`. Subtle `tracking-tight` for headers.
- **Labels:** Titles and descriptions placed outside and below cards — gallery-style.
- **Spacing:** Generous `p-8` or `p-10` inside cards.

## Animation Engine Specs (Perpetual Motion)

All cards must contain perpetual micro-interactions:

- **Spring physics:** No linear easing. `type: "spring", stiffness: 100, damping: 20`.
- **Layout transitions:** Use `layout` and `layoutId` for smooth re-ordering and shared element transitions.
- **Infinite loops:** Every card has an active state that loops (Pulse, Typewriter, Float, Carousel).
- **Performance:** Wrap dynamic lists in `<AnimatePresence>`. Any perpetual motion MUST be memoized (`React.memo`) and isolated in its own microscopic Client Component.

## The 5 Card Archetypes

Use these when constructing Bento grids (e.g., Row 1: 3 cols, Row 2: 2 cols 70/30):

### 1. The Intelligent List

Vertical stack with infinite auto-sorting loop. Items swap positions via `layoutId`, simulating AI prioritization in real-time.

### 2. The Command Input

Search/AI bar with multi-step Typewriter Effect. Cycles through prompts with blinking cursor and a "processing" state using a shimmer loading gradient.

### 3. The Live Status

Scheduling interface with "breathing" status indicators. Pop-up notification badge emerges with overshoot spring, stays 3 seconds, vanishes.

### 4. The Wide Data Stream

Horizontal infinite carousel of data cards/metrics. Seamless loop using `x: ["0%", "-100%"]` at effortless speed.

### 5. The Contextual UI (Focus Mode)

Document view that animates staggered text-block highlighting, followed by a float-in action toolbar with micro-icons.
