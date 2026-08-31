---
name: PDF in Place
description: A calm, precise browser workbench for private PDF workflows.
colors:
  document-red: "#dc2635"
  document-red-deep: "#bd1726"
  document-red-soft: "#fff0f1"
  selection-blue: "#2563eb"
  workspace-mist: "#eef1f4"
  paper-white: "#ffffff"
  surface-subtle: "#f7f8fa"
  working-ink: "#20242c"
  muted-slate: "#596273"
  structural-line: "#dce1e8"
  structural-line-strong: "#c8d0da"
typography:
  headline:
    fontFamily: "Segoe UI Variable, Aptos, Segoe UI, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Segoe UI Variable, Aptos, Segoe UI, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Segoe UI Variable, Aptos, Segoe UI, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Segoe UI Variable, Aptos, Segoe UI, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.5
rounded:
  control: "0.625rem"
  medium: "0.75rem"
  surface: "1rem"
  modal: "1.125rem"
spacing:
  xs: "0.5rem"
  sm: "0.625rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.document-red}"
    textColor: "{colors.paper-white}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 0.875rem"
    height: "2.5rem"
  button-primary-hover:
    backgroundColor: "{colors.document-red-deep}"
    textColor: "{colors.paper-white}"
  button-toolbar:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.muted-slate}"
    rounded: "{rounded.control}"
    size: "2.5rem"
  field-default:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.working-ink}"
    rounded: "{rounded.control}"
    padding: "0 0.625rem"
    height: "2.5rem"
  document-card:
    backgroundColor: "{colors.paper-white}"
    rounded: "{rounded.medium}"
  dialog:
    backgroundColor: "{colors.paper-white}"
    rounded: "{rounded.surface}"
    padding: "1.25rem"
---

# Design System: PDF in Place

## Overview

**Creative North Star: "The Private Workbench"**

PDF in Place should feel like a well-kept document desk: calm enough for concentrated work, precise enough to inspire trust, and immediately understandable without specialist knowledge. The interface lets the document remain the main artifact while controls form a compact, dependable frame around it.

The system is layered and restrained rather than flat or ornamental. Color, depth, and motion communicate status and hierarchy; they do not decorate empty space. The visual language must avoid promotional, playful, or spectacle-driven patterns that would compete with the user's documents.

**Key Characteristics:**

- Calm, precise, and trustworthy.
- Compact controls surrounding a generous document workspace.
- Clear separation between primary actions, selection state, and destructive actions.
- Quietly tactile interaction with restrained depth and fast feedback.
- Responsive composition that preserves every workflow on narrow screens.

## Colors

The palette combines a restrained neutral workspace with two deliberately separate accents.

### Primary

- **Document Red:** Identifies the product and marks the single primary outcome in a control group, such as export, save, or start.
- **Document Red Deep:** Provides the hover and pressed expression for primary actions.
- **Document Red Soft:** Supports low-emphasis red states and contextual backgrounds without competing with the primary action.

### Secondary

- **Selection Blue:** Communicates selection, active editing tools, focus, and ordered page state. It is functional feedback, not a second brand color.

### Neutral

- **Workspace Mist:** Separates the workbench from white document pages and white control surfaces.
- **Paper White:** Represents documents, headers, dialogs, and controls that must read as physical working surfaces.
- **Surface Subtle:** Provides quiet hover, field, and grouped-control contrast.
- **Working Ink:** Carries headings and primary text.
- **Muted Slate:** Carries secondary text, metadata, and inactive icon color.
- **Structural Line / Structural Line Strong:** Define control boundaries, dividers, and dashed empty-state edges.

**The Two Accent Rule.** Document Red owns brand and primary outcomes; Selection Blue owns selection and focus. Never interchange those roles.

## Typography

**Display Font:** Segoe UI Variable, with Aptos, Segoe UI, and system sans-serif fallbacks

**Body Font:** Segoe UI Variable, with Aptos, Segoe UI, and system sans-serif fallbacks

**Character:** The type system is neutral, highly legible, and native to a productivity environment. Hierarchy comes from weight and a restrained size scale rather than decorative type choices.

### Hierarchy

- **Headline** (700, 1.5rem, 1.25 line height): Welcome titles and the largest task-level messages.
- **Title** (700, 1.125rem, 1.5 line height): Product identity, empty-state headings, and dialog titles.
- **Body** (400, 1rem, 1.5 line height): Instructions and explanatory copy, generally constrained to approximately 65 characters per line.
- **Label** (600, 0.75rem, 1.5 line height): Buttons, field labels, status chips, and compact tool descriptions.

**The Functional Hierarchy Rule.** Use size for task hierarchy and weight for control hierarchy; do not add display typography merely to make an operational screen feel branded.

## Layout

The application uses a full-height workbench. A persistent header contains product and session context above a three-part toolbar: document actions on the left, history in the center, and output actions on the right. The main area is a flexible workspace that either centers the empty state or lays out document pages in an auto-filling grid.

Spacing follows a compact 0.5rem to 1.5rem rhythm. Controls within a task group stay close together, while the workspace receives progressively more padding at wider viewports. Floating zoom and editing tools sit at the canvas edge, keeping the central document area unobstructed.

At widths below 640px, preferences move to their own row and the toolbar changes from three columns to an auto-plus-flexible two-column composition. Selection actions become one horizontally scrollable band instead of wrapping into multiple rows. Document pages form a single centered column when their minimum width no longer fits side by side.

## Elevation & Depth

The system uses layered and restrained elevation. Borders establish most boundaries; shadows are reserved for interactive lift, floating tools, dialogs, and document pages against the workspace.

### Shadow Vocabulary

- **Low Ambient** (`0 1px 2px rgb(15 23 42 / 0.06), 0 2px 6px rgb(15 23 42 / 0.03)`): Headers and resting controls that need slight separation.
- **Working Surface** (`0 6px 18px -8px rgb(15 23 42 / 0.18), 0 2px 5px rgb(15 23 42 / 0.05)`): Document cards, floating zoom controls, and tactile empty-state details.
- **Protected Focus** (`0 24px 60px -24px rgb(15 23 42 / 0.32), 0 8px 20px -12px rgb(15 23 42 / 0.18)`): Dialogs, welcome surfaces, and elevated document hover states.

**The Earned Elevation Rule.** A surface receives a stronger shadow only when it floats above the workspace, protects focus, or responds to interaction.

## Shapes

Controls use gently curved 0.625rem corners, document cards and common containers use 0.75rem corners, and focused surfaces use 1rem to 1.125rem corners. Small status counters may be pill-shaped, but operational buttons remain rounded rectangles rather than capsules.

Borders are one pixel and cool neutral. Dashed borders are reserved for the import drop zone. Document identity may use a stronger colored outline, while dialogs rely on depth rather than combining a prominent border with a strong shadow.

## Components

### Buttons

- **Shape:** Compact rounded rectangles with 0.625rem corners and a 2.5rem default height.
- **Primary:** Document Red with white text, strong label weight, and restrained red-tinted depth. Use once per immediate action group.
- **Hover / Focus:** Primary actions deepen in red; all controls use a visible blue focus outline with offset.
- **Toolbar:** White surface, cool neutral border, Muted Slate icon, and subtle lift on hover. Disabled tools become quieter without disappearing.
- **Destructive:** Remain neutral at rest when icon-only, then introduce red text or a soft red background on hover; explicit destructive confirmations may use solid red.

### Chips

- **Style:** Compact bordered labels with tabular numerals for selection counts.
- **State:** Selected or count-bearing chips use pale blue with blue text; unavailable actions remain visible at reduced contrast.

### Cards / Containers

- **Corner Style:** Gently curved 0.75rem corners for document cards and 1rem corners for grouped surfaces.
- **Background:** Paper White over Workspace Mist.
- **Shadow Strategy:** Working Surface at rest and Protected Focus only for hover or modal priority.
- **Border:** Use a one-pixel neutral boundary when the surface needs structural separation; avoid pairing a visible border with heavy elevation.
- **Internal Padding:** Compact controls use 0.5rem to 0.75rem; dialogs and onboarding surfaces use 1.25rem to 2rem depending on viewport.

### Inputs / Fields

- **Style:** Subtle neutral surface, one-pixel border, 0.625rem to 0.75rem corners, and compact horizontal padding.
- **Focus:** A visible blue outline or border shift, never color alone.
- **Error / Disabled:** Errors use red text and restrained red surfaces; disabled fields and actions stay legible with reduced contrast and no elevation.

### Navigation

The workspace header combines product identity, session status, legal access, persistence controls, and locale selection. On mobile, controls reflow into complete rows rather than shrinking labels below legibility or leaving content off-screen.

### Document Workspace

White document pages sit on Workspace Mist and carry realistic, soft elevation. Page selection uses a blue outline and ordered blue badge; document-source color remains a separate thin identity cue. Floating tool groups use white surfaces and compact icon buttons so the document stays visually dominant.

## Do's and Don'ts

### Do:

- **Do** reserve Document Red for product identity and the primary outcome in each action group.
- **Do** use Selection Blue consistently for focus, active tools, selected pages, and ordered selection.
- **Do** keep controls compact and grouped while leaving generous uninterrupted space around documents.
- **Do** preserve complete workflows on mobile through reflow and horizontal tool bands.
- **Do** use depth only to clarify working layers, interaction, or protected focus.

### Don't:

- **Don't** interchange Document Red and Selection Blue or use both as competing calls to action.
- **Don't** introduce promotional hero patterns, playful decoration, or spectacle-driven motion into operational screens.
- **Don't** place white document pages on an undifferentiated white workspace.
- **Don't** hide essential actions on narrow screens; reflow or provide a clear horizontal scroll affordance.
- **Don't** combine heavy shadows, strong borders, and decorative blur on the same surface.
