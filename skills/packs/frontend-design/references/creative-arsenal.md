# Creative Arsenal Reference

High-end interaction concepts to pull from when building visually striking interfaces.
Do not default to generic UI — leverage these patterns when the design direction calls for it.

**Library boundary:** Default to Framer Motion for UI/Bento interactions. Use GSAP (ScrollTrigger/Parallax) or ThreeJS/WebGL EXCLUSIVELY for isolated full-page scrolltelling or canvas backgrounds, wrapped in strict `useEffect` cleanup blocks. Never mix GSAP/ThreeJS with Framer Motion in the same component tree.

## Navigation and Menus

- **Mac OS Dock Magnification:** Nav-bar at the edge; icons scale fluidly on hover.
- **Magnetic Button:** Buttons that physically pull toward the cursor using `useMotionValue`/`useTransform`.
- **Gooey Menu:** Sub-items detach from the main button like a viscous liquid.
- **Dynamic Island:** A pill-shaped component that morphs to show status/alerts.
- **Contextual Radial Menu:** Circular menu expanding at click coordinates.
- **Floating Speed Dial:** FAB that springs out into a curved line of secondary actions.
- **Mega Menu Reveal:** Full-screen dropdowns with stagger-faded content.

## Layout and Grids

- **Bento Grid:** Asymmetric tile-based grouping (Apple Control Center style).
- **Masonry Layout:** Staggered grid without fixed row heights (Pinterest style).
- **Chroma Grid:** Grid borders/tiles with continuously animating color gradients.
- **Split Screen Scroll:** Two halves sliding in opposite directions on scroll.
- **Curtain Reveal:** Hero section parting in the middle like a curtain on scroll.

## Cards and Containers

- **Parallax Tilt Card:** 3D-tilting card tracking mouse coordinates.
- **Spotlight Border Card:** Borders that illuminate dynamically under the cursor.
- **Glassmorphism Panel:** True frosted glass with inner refraction — beyond `backdrop-blur`, add `border-white/10` and `shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]`.
- **Holographic Foil Card:** Iridescent rainbow reflections shifting on hover.
- **Tinder Swipe Stack:** Physical stack of cards the user can swipe away.
- **Morphing Modal:** Button that seamlessly expands into its own full-screen dialog.

## Scroll Animations

- **Sticky Scroll Stack:** Cards stick to top and physically stack over each other.
- **Horizontal Scroll Hijack:** Vertical scroll translates into smooth horizontal pan.
- **Locomotive Scroll Sequence:** Video/3D frame rate tied to scrollbar position.
- **Zoom Parallax:** Central background zooming in/out as user scrolls.
- **Scroll Progress Path:** SVG lines that draw themselves as the user scrolls.
- **Liquid Swipe Transition:** Page transitions wiping like viscous liquid.

## Galleries and Media

- **Dome Gallery:** 3D gallery with panoramic dome feeling.
- **Coverflow Carousel:** 3D carousel with center focus, angled edges.
- **Drag-to-Pan Grid:** Boundless grid freely draggable in any direction.
- **Accordion Image Slider:** Narrow strips that expand fully on hover.
- **Hover Image Trail:** Mouse leaves a trail of popping/fading images.
- **Glitch Effect Image:** RGB-channel shifting distortion on hover.

## Typography and Text

- **Kinetic Marquee:** Endless text bands that reverse or accelerate on scroll.
- **Text Mask Reveal:** Large typography as transparent window to video background.
- **Text Scramble Effect:** Matrix-style character decoding on load or hover.
- **Circular Text Path:** Text curved along a spinning circular path.
- **Gradient Stroke Animation:** Outlined text with gradient running along the stroke.
- **Kinetic Typography Grid:** Letter grid dodging or rotating away from cursor.

## Micro-Interactions and Effects

- **Particle Explosion Button:** CTAs shattering into particles on success.
- **Liquid Pull-to-Refresh:** Reload indicator acting like detaching water droplets.
- **Skeleton Shimmer:** Shifting light reflections across placeholder boxes.
- **Directional Hover Aware Button:** Fill entering from the exact side the mouse entered.
- **Ripple Click Effect:** Waves rippling from click coordinates.
- **Animated SVG Line Drawing:** Vectors drawing their own contours in real-time.
- **Mesh Gradient Background:** Organic, lava-lamp-like animated color blobs.
- **Lens Blur Depth:** Dynamic focus blurring background layers to highlight foreground action.

## Hero Sections

Stop doing centered text over a dark image. Try:

- Asymmetric: text left/right-aligned, background with subtle stylistic fade into the background color.
- Split-screen: 50/50 content and asset.
- Full-bleed media with overlapping offset text panel.
