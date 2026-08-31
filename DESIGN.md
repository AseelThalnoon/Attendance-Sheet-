---
name: Atrium
description: A bright, warm office floor — a near-black rail down one side, a greige canvas holding white and cream cards, and three pastel accents that are only ever fills.
colors:
  rail: "#111110"
  ink: "#111110"
  ink-950: "#0A0A09"
  ink-900: "#111110"
  ink-800: "#1C1C1A"
  ink-700: "#2A2A27"
  ink-600: "#3D3D38"
  wash: "#E4E2DC"
  wash-soft: "#EFEDE8"
  canvas: "#E9E7E2"
  card: "#FFFFFF"
  surface-cream: "#F0EADA"
  surface-gray: "#DFDDD9"
  lime: "#D6E85C"
  lime-deep: "#5C6B12"
  lime-light: "#E4F27A"
  mint: "#A9DCC6"
  blush: "#F0B9C9"
  muted: "#61605A"
  muted-2: "#57554F"
  line: "#D5D2CB"
  line-soft: "#E2DFD8"
  positive: "#1B6C4D"
  positive-bg: "#DCF0E6"
  info: "#3A3A36"
  info-bg: "#E4E2DC"
  negative: "#A83A55"
  negative-bg: "#FBE4EA"
  negative-solid: "#C0405E"
  negative-deep: "#8E2A42"
  excused: "#6B6410"
  excused-bg: "#F2EFD2"
  warn: "#7A5510"
  warn-bg: "#F7EFDA"
  input-bg: "#FFFFFF"
  iris-1: "#E8DCC8"
  iris-2: "#DCD9E8"
  iris-3: "#CFE4DC"
  iris-4: "#EFDCE2"
  ink-on-lime: "#1A1E05"
  muted-on-dark: "#A8A69E"
  positive-on-dark: "#A9DCC6"
  negative-on-dark: "#F0B9C9"
typography:
  display:
    fontFamily: "Switzer, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif"
    fontWeight: 700
    lineHeight: 1.05
  body:
    fontFamily: "Switzer, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif"
    fontWeight: 400
    lineHeight: 1.45
  numeral:
    fontFamily: "Switzer, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif"
    fontWeight: 900
    lineHeight: 1
rounded:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "22px"
  pill: "99px"
spacing:
  "0": "2px"
  "1": "4px"
  "1-5": "6px"
  "2": "8px"
  "2-5": "10px"
  "3": "12px"
  "3-5": "14px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "7": "28px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: "11px 20px"
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "11px 20px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "11px 20px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "20px 20px 18px"
---

# Design System: Atrium

## Overview

**Creative North Star: "The Atrium"**

A bright, warm office floor rendered as an interface. A near-black rail runs
down one side — the building's spine, carrying navigation, today's status, and
who you are. Everything else is a light-filled well: a warm greige canvas
holding white, cream and gray cards with generous corner radii and soft ambient
shadows. Three pastel accents (lime, mint, blush) carry all the meaning-bearing
colour, and they are **only ever fills** — a chart arc, a progress bar, a status
ring, the glow behind the active nav item. Text stays near-black. That single
rule is what lets the palette be pastel without being illegible.

Typography is one geometric grotesk doing every job: Switzer, self-hosted, at
four weights. Headings are heavy and tightly tracked; figures are heavier still;
labels are 10px uppercase with wide letter-spacing. There is no serif anywhere,
and no second family — where the previous system used three faces to separate
headings from numbers, Atrium separates them by weight and size alone.

**Key characteristics**
- One dark region only: the rail. Every other surface is light, and a second
  large dark mass anywhere on the page is a mistake.
- Accents are fills, never text and never a text colour on a light ground.
- Surfaces distinguish cards from each other — white, cream, gray — rather than
  borders, stripes or accent bars.
- Large radii (22px cards, 99px pills) and soft, neutral, ambient shadows.
- One typeface, four weights, no serif.

**Confirmed rejection:** the previous "Gilt Ledger" world (teal ink, antique
gold trim, wax-seal ornament, ruled-paper texture, a serif display face) is the
explicit anti-reference. So is its multi-theme machinery.

## Colors

### Structure
- **Rail / Ink** (`#111110`, `--rail`, `--ink`): the sidebar, primary text,
  event bars, filled check circles, the primary button. One token, because in
  Atrium the darkest surface and the darkest text are the same value.
- **The ink ramp** (`--ink-950` … `--ink-50`): the neutral steps between that
  near-black and the two page washes. This file described the ramp as `--ink-*`
  from the start and the stylesheet spelled it `--teal-*` — names inherited from
  Gilt Ledger, whose ramp really was teal — for 69 references, so the colour
  contract named steps a grep could not find. The stylesheet now uses the names
  this file declares.
- **Canvas** (`#E9E7E2`, `--paper`): the warm greige page ground. Cards sit on
  it; it is never used for a card or for text.
- **Card** (`#FFFFFF`, `--card`): the default card surface.
- **Cream** (`#F0EADA`) and **Gray** (`#DFDDD9`): the two alternate card
  surfaces, used to separate tiles in a row without drawing a border.

### Accents (fills only)
- **Lime** (`#D6E85C`, `--gold`): the active-nav glow and bar, progress fills,
  the clock-in button. Retains the `--gold` token name because ~40 component
  rules refer to it as "the accent".
- **Lime Deep** (`#5C6B12`, `--gold-deep`): the one lime dark enough to set text
  or a meaningful line in. Chart target-reference lines use this.
- **Mint** (`#A9DCC6`) / **Blush** (`#F0B9C9`): met-target and under-target
  rings on week-timeline bars and the rail's status card.

### The iridescent tile
`--gradient-iris` (`#E8DCC8 → #DCD9E8 → #CFE4DC → #EFDCE2`): the system's one
decorative gradient, reserved for a single highlight surface — currently the
hero stat — so it stays an event rather than a texture. Ink text sits on it at
15:1; it is a *surface*, which is why it is exempt from the fill-only rule that
governs lime, mint and blush.

### Text
- **Muted** (`#61605A`) and **Muted Deep** (`#57554F`): the two secondary-text
  steps. Both clear 4.5:1 on all six surfaces the app paints text on.
- **Muted on Dark** (`#A8A69E`): secondary text on the rail.

### Status (semantic, not decorative)
`--positive` `#1B6C4D` on `#DCF0E6` · `--negative` `#A83A55` on `#FBE4EA` ·
`--excused` `#6B6410` on `#F2EFD2` · `--warn` `#7A5510` on `#F7EFDA` ·
`--info` `#3A3A36` on `#E4E2DC`. Each foreground clears 4.5:1 both on its own
tint and on the plain card/canvas/wash surfaces, because these colours land on
both.

### Named Rules

**The Fill-Only Rule.** Lime, mint and blush are fills: bars, arcs, rings, dots,
progress tracks, nav glows. The moment one of them becomes a text colour on a
light ground, it fails contrast — lime measures 1.35:1 on white. Where a
lime-family *line* has to carry meaning (a chart's target reference), use
`--gold-deep` at 5.89:1, never `--gold`.

**The Measured Floor.** Every text/background pairing carrying real information
is measured against WCAG AA 4.5:1 for its rendered size, and every meaningful
graphical object against 1.4.11's 3:1, before it ships. This is not decorative
rigour: the first pass of this palette put `--muted` at `#6E6C66`, which cleared
the floor on white and failed on canvas, cream and gray (3.87–4.49:1), and put
`--positive` at `#1F7A57`, which failed on its own tint. Both were darkened.

**The graphical half of that rule went unenforced for a while.** Text was
measured; the non-text objects were not, and 1.4.11 applies to anything you have
to *see* to read the interface. The calendar's entry dot, the format ring's edge
and the "today" cell's border were all drawn in a light accent on the canvas, so
the three marks that say *there is an entry here*, *this is the split* and *this
is today* were each under 3:1. The dot moved to `--muted-2`, the ring edge to
ink at 55%, and today's cell now carries an ink border with a second ink ring
and a 900-weight day number. A mark that is the only carrier of a fact is held
to the same floor as the sentence that would have said it.

**One Dark Region.** The rail is the only large dark surface. The quick-clock
panel is the single deliberate exception, because clocking in is the primary
action and it earns the emphasis. A third would flatten both.

## Typography

**One family:** Switzer (self-hosted woff2, weights 400/500/700/900), falling
back to the system UI stack.

Switzer ships **no `tnum` feature**, but its digits are natively uniform-width
(576/1000 em at every weight), so figures align in a column without one.
`font-variant-numeric: tabular-nums` stays on `.num` cells regardless: it is a
no-op in Switzer and a real fix if the stack ever falls back to a system face.

### Hierarchy
- **Hero value** (900, 56px, `-.04em`): the single largest figure on screen.
- **Stat value** (900, 24px, `-.035em`): the figure inside a stat card. One
  size, every tab, every width — there is no per-panel exception left.

  It took two passes to get here. The declared size was 34px, which nothing
  rendered: Overview had already dropped to 20px and every width below the
  frame to 24px, so 34px survived only on Shortfall, Team and Admin, where it
  made the same component read as a louder one in cards that were no wider —
  262px on Shortfall and 207px on Team, against Overview's 272px. The largest
  figure in the app was living in its smallest cards. Bringing those three to
  24px then left Overview as the outlier in the other direction: the first row
  a user sees, a step under the same four components one tab over. Overview's
  own step-down went too.

  The pixels that step-down was buying are real — Overview's row shares its
  screen with the portrait, day-types and roster panels — but a one-screen
  budget is a **grid** problem. Paying for it by shrinking one tab's type is
  how a scale stops being a scale.
- **Page greeting** (700, 40px, `-.03em`): "Hello {name}" — 20px inside the
  desktop frame, where the header is one compact line and the pixels belong to
  the tab underneath it.
- **Card heading** (700, 21px, `-.025em`): no rule beneath, no bullet.
- **Body** (400, 13–14px).
- **Label / kicker** (500, 9.5–10px, uppercase, `.08–.14em`): every stat label,
  field label, nav item, meta line and status caption.

### Named Rule
**The Weight Rule.** Hierarchy comes from weight, size and letter-spacing, not
from a second family. A heading is 700 and tight; a figure is 900 and tighter; a
label is 10px uppercase and wide. Introducing a display face to mark a heading
means the scale stopped doing its job.

**Four weights, and only the four that are loaded.** Switzer is served at
400/500/700/900. Anything else in a stylesheet is a weight the browser resolves
to one of those four, so the declaration says one thing and the screen shows
another. There were 34 uses of 600 — resolving to 700 — and one of 800,
resolving to 900; a designer reading the CSS would have counted six weights in a
four-weight system. Every one of them now names the weight it actually renders.

## Layout

A fixed 236px rail on the left above 760px, with content in a `.shell` offset by
the same amount and capped at 1280px. Below 760px the rail is replaced by the
existing bottom navigation — with its centred clock button, which is the primary
moment on a phone and does not move — and cards stack to one column.

The rail and the bottom nav hand over at **the same** breakpoint. An earlier
draft hid the rail at 900px while the bottom nav appeared at 760px, leaving a
140px band with neither.

**The compact chrome hands over at that same 760px too**, not at the frame's
1100px. Gated on 1100 it produced a cliff: at 1100px wide the chrome above the
Log was 148px and at 1099px it was 364px — 46% of an 800px window, first row at
y=544, 653px of page scroll. One pixel of width, 216px of chrome. It was the
140px-orphan mistake again, 340px wide.

Only the chrome moves down. The frame itself — fixed height, panels that scroll,
the pointer-sized control module — stays at 1100px: below that there is no room
for it, and a tablet in that band is as likely to be touched as clicked. The
notice strip's `flex-wrap:nowrap` stays at 1100 as well; forced onto a narrower
column it wrapped the sentence to five lines and cost *more* than the stacked
layout it replaced.

The tab strip still exists in the DOM but is never shown: it is the single
activation path both nav surfaces click through to, so every render, filter and
admin rule stays in one place. Because that removes the visible tablist, the
rail carries `aria-current="page"` on the active destination.

### Named Rule
**One Screen Per Tab.** Above 1100px the shell is a fixed frame the height of
the viewport. The page never scrolls and neither does the frame around the
panels; a tab whose content outgrows it scrolls inside its own panel, with the
table headings pinned.

Density is how a tab earns that, not pagination. A tab is made to fit by making
its rows thin — a Log row is 32px, and the touch targets inside it shrink to
pointer size in the frame — never by hiding two thirds of the month behind a
page number. An earlier draft measured what fit and paged the remainder: a month
of entries arrived as "1 of 3", and the same machinery split the Settings form
and the Admin sections across pages too. Reading a month should not be a
navigation task.

A tab with room left over spends it on its own content, not on canvas. Trends
and Shortfall each kept their real numbers — the weekly, monthly and shortfall
tables — behind a collapsed accordion, and ended in 234px and 165px of empty
canvas at 1440x900 with nothing saying a click was owed. Those three open on
arrival now. The chart above each still leads; the table is the same month in the
form you can read one row out of. Closing one is still a click. An empty third of
the frame is the opposite of the density this rule exists to produce.

Scrolling is the fallback, in that order: shrink the chrome, thin the rows,
and only then let the panel scroll. `tests/regression/one-screen.js` holds all
three — the page and frame must not scroll, rows must stay under 34px, and the
header plus its notices must stay under 155px.

155 and not the 130 this file used to claim: a notice is a title, a sentence and
its buttons, and below about 1400px that sentence needs a second line. 130 is
reachable at 1440 and above and unreachable at 1280 without truncating away the
part that says what to do. The ceiling is the one that holds at every width in
`SIZES`, not the one that holds at the widest.

The tab card hugs its content and shrinks to the frame when content exceeds it,
rather than always stretching. Stretching turned every short tab into a white
rectangle with its content huddled at the top. The exception is the Calendar,
whose cells are drawn to the height they are given; `activateTab()` puts it in
`CARD_FILLS_FRAME` and the card takes the whole frame there.

### Flex-shrink protection has to reach every level
The direct-child rule that stops a panel's children from being flex-shrunk
into clipping (`#tabContentCard > .tab-panel.active > *{flex-shrink:0;}`,
above) only reaches direct children. Trends nests one level deeper than every
other tab — its children are the two `.sub-tab-panel`s, not the period-card
and accordion-section that actually hold height — so opening "Weekly totals"
in a short window shrank the table's own box instead of the panel scrolling:
`.accordion-section{overflow:hidden}` gives it an automatic minimum size of
zero per the flexbox spec, so it clipped rows off the bottom rather than
refusing to shrink. The same shortage, denied an outlet there, just moved one
sibling over: the chart card's own `min-height:0` (needed so a locked-height
chart doesn't get paged away on Punctuality, see One Module below) let it
shrink past what its own head and chart-holder need, and with `overflow:
visible` the excess doesn't clip — it renders past the card's own bottom edge
and over whatever sits underneath it. Fixed by extending the flex-shrink
guard to the sub-tab-panel's children too, and dropping the chart card's
`min-height:0` override so its automatic minimum — which already respects
chart-holder's own 76px floor — does the job instead. `checkSections()` in
`tests/regression/one-screen.js` asserts both shapes of this: a section's
own box has to match its head-plus-body, and no sibling's children may render
past that sibling's own edge.

### Named Rule
**One Module.** Above 1100px the frame is a pointer surface, and everything in
it is measured against the 32px Log row: controls are 34px, small buttons 30px,
section heads 36px. Below 1100px every one of those keeps its 44px touch floor
untouched — the module is a property of the input device, not of the component.

The frame had drifted to four heights in one vertical stack — a 44px select
above a 44px search box above a 36px button above a 32px row — which made the
toolbar read as heavier than the data it filters.

**The floor under the module is 24px** — WCAG 2.2 SC 2.5.8 at AA, which applies
to a mouse as much as to a finger. Shrinking a control for the pointer is a
density decision; taking it below 24px is an accessibility one, and the row buys
its height back from cell padding instead. A pass once took Edit and Delete to
21px and cited that same standard as the justification.
`tests/regression/one-screen.js` asserts it rather than trusting the comment.

**The 44px half of this rule was prose for a long time.** Twelve controls
carried their *pointer* size as their base — a 30px sign-out disc, a 32px
sub-tab, 36px row actions, a 30px "Back Up Now" — so the shrink applied at every
width and a tablet at 1024px got the frame's density with none of the frame.
The base is the touch size now and the frame is what steps it down. Two of the
twelve were already written correctly inside the frame's step-down block and
still rendered small, because the component's own base rule appears later in the
stylesheet and wins at equal specificity: a step-down belongs next to the
component it steps down, not gathered in a block above it. Reading the CSS said
fixed, which is why `tests/mobile/touch-floor.js` measures it in a browser at
393, 768, 1024 and 1099px, with real rows behind it — half the controls that
drifted only exist once there is data, and a fixture without data passes
vacuously. It asserts the step-down above 1100 too, or the rule could be
"satisfied" by never shrinking anything.

**One documented exception: the month grid.** Seven columns in a 393px viewport
leave 41.6px of width per cell after the card, the grid padding and six gaps —
320px leaves 33px — and the only routes to a 44px square are a horizontal
scrollbar on a month or a week that does not fit on one line. Height is not
constrained the same way, so below 480px the cell drops its square aspect and
takes the full 44 vertically: 41.6x44 rather than 41.6x41.6. Comfortably past
2.5.8's 24px AA floor, short of 2.5.5's AAA square on width alone, recorded here
rather than rounded away.

### Named Rule
**Spacing Is A Scale.** Base 4 with the even half-steps, from the `--space-*`
tokens: 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32. Tight (6) inside a group
that reads as one object, standard (12) between siblings, generous (16–24)
between regions.

10, 14 and 28 are on the scale because the stylesheet was already using them —
10px is the single most common spacing value in the file, in 59 declarations —
and a step 59 declarations need is a step, not a violation. What is banned is
the value between the steps: every 7, 9, 11, 13, 15, 17 and 18 has been snapped
to a neighbour, because those were the ones that carried no relationship to
anything. None survive. A scale that half the file ignores is not enforcement,
it is a second, undeclared scale.

This file used to declare three steps and the stylesheet used thirty — every
integer from 1 to 18 plus a dozen more. That is why nothing grouped: when the
gap inside a control cluster equals the gap between two unrelated bars, and
nearly equals the gap between whole regions, proximity stops carrying meaning
and every group needs a container or a border to be legible instead. Base 4 and
not 8, because the useful middle steps (6, 12, 20) are where this app's rhythm
actually lives.

### Absolute positioning inside the frame
Anything `position:absolute` inside a scrolling panel needs a positioned
ancestor inside that panel. Without one its containing block is the initial one,
no scroll container between it and `<html>` can clip it, and it silently
stretches the document — the visually-hidden `.cell-label` in every table cell
put 107px of phantom page scroll on a 1280x720 window this way. `.table-wrap`
carries `position:relative` for exactly this reason.

## Elevation & Depth

Shadows are ambient and neutral, never structural: `--shadow-sm` at rest,
`--shadow-md` on hover, `--shadow-lg` for modals. Cards have **no border** —
separation comes from surface colour and shadow. Dark-mode shadow variants no
longer exist; there is one theme.

## Components

### The Rail
Wordmark, uppercase nav items with icons, today's status card, and a user block
(avatar, name, role). The active item turns lime and grows a lime bar pinned to
the left edge with a soft glow — the rail's one flash of colour.

### The sticky clock bar
Fixed to the bottom of the viewport, but starting after the rail
(`left: calc(236px + 12px)` above 760px) — the rail owns the left 236px. Anchored
at 12px it ran underneath the rail and put the user block behind a dark panel on
every tab but the Overview, which is also a second dark mass laid across the one
dark region this system allows.

Every panel reserves clearance for it, not only the Overview. That reservation
used to be 12px topped up by about 5px of luck — the tab card's bottom padding
and the footer happened to cover the rest — and the luck ran out the first time
something moved: snapping the footer's bottom padding from 18px to 16px put four
tabs behind the bar at four widths, for 2px that were never the footer's to
spend. The reservation is 20px now and carries itself, so the footer is free to
change. The Overview sits 12px lower and still takes its own step (32px).

### Today's status
A small dark card in the rail's foot: an uppercase label and one large figure.
It replaces the old wax-seal badge, keeping the job (one glanceable number for
today) and dropping the skeuomorphism. Over/under status shows as a coloured
left edge, never a tinted panel.

### The notice stack
The reminder banners live in one `.notice-stack` wrapper rather than loose in
`main`. On a pointer that changes nothing — it is the same row of the page. On a
phone the second and further notices fold behind a counted button ("2 more
notices"): two open notices were 282px of an 852px screen, and neither of them
was what the person opened the app to do. Nothing is dismissed on their behalf;
the count states exactly what is waiting and one tap brings it back.

Wrapping them had a cost worth recording. Twelve rules were scoped
`main > .reminder` and the wrapper orphaned every one of them, which put the
chrome at 313px. A thirteenth — `main > .reminder.show:last-of-type` — had
*never* matched, because main's last element child is a tab panel, so rescoping
it woke a rule that had been dead since it was written and pushed 1280px windows
to 160px against a 155px ceiling. A wrapper element is a selector change to
everything that named the old parent.

### Today's status line
The same fact as the rail's status card, for the widths where the rail is not on
screen: a dark line at the top of the content column with an uppercase label and
one large figure, hidden above 760px so it is never the same number twice. It
exists because the top of a phone screen was a greeting and two notices — the
one figure the person opened the app for was below the fold on every tab, at
`firstContentTop: 438` on an 852px screen.

### The Overview grid
Four figures across the top; the portrait, the month's shape and who is in today
across the middle; the clock as a band along the bottom. Above 1100px it is a
named-area grid whose middle row takes whatever the frame has left; below that
the same sections stack in source order.

**The person card stays on your own record.** Photos are device-local, so on
your own Overview it is your photograph — the one image in the app, and the
reason the card is a portrait rather than a header. A pass that judged it from a
test fixture saw the monogram fallback instead, mistook the card for decoration,
and cut it; it is here because what it renders for the person who owns the record
is not a monogram.

**The roster spans the middle row and the clock's**, so the clock is a band under
the portrait and Day Types rather than the full width of the tab. A pass tried it
the other way — roster in its row, clock full width — on the grounds that a card
should be as tall as its content; it was rejected, and the tall roster is the
committed shape. Which makes its empty state load-bearing:

**The roster's empty state holds its card.** It is a card in a filled row, so
"nobody yet" has to occupy the row the way a list of names would; one sentence
pinned to the top read as something that had failed to load. Its error state
takes the same shape and names both the problem and the way back, so a failure
cannot be mistaken for an empty morning.

### Cards
22px radius, no border, `--shadow-sm` at rest. Headings are 700/21px with no
underline rule. In a stat row, the second and third cards take the cream and
gray surfaces so a four-tile row reads as four tiles.

### Buttons
Primary is solid ink with white text; secondary is a white card surface;
ghost is transparent with a line border. Danger-solid uses its own fixed
`--negative-solid`/`--negative-deep` pair, because `--negative` is tuned as a
*text* colour and is too muted to carry white text as a fill. Pills (99px) for
segmented controls and header actions.

### The Settings identity strip
Avatar, display name, photo — the block that names who every section below it is
scoped to. Two controls with opposite answers to the same question, so each
carries its own caption directly beneath it: the display name is shared with the
team, the photo never leaves the device. A single caption above both said the
wrong thing about one of them.

**Display name is editable here and nowhere else.** It used to be settable only
at sign-up, so an account created without one showed its email address in every
place a name belongs — the portrait plate, the rail, the roster, the greeting.
`profiles.full_name` is the one column the API grants an authenticated user on
their own row (migration `20260815012052`; role, id and email are revoked at the
grant and blocked again by a trigger), so the save is a one-column write that
needs no client-side guard around the rest. Own profile only: the RLS policy
would let an admin rename anyone, and this screen does not offer it.

### Avatar
One component everywhere a person appears. A photo when there is one, initials
on an ink tile when there is not — same size and shape either way, so a mixed
roster still lines up.

**Photos are shared, in a private Supabase Storage bucket** (migration
`20260830153418`), not device-local. Earlier this was a deliberate localStorage
choice — no upload, no storage quota, a teammate always rendered as initials —
until the deliberate choice turned out to be the wrong one to have made: a
picture nobody but you can ever see is not really a profile photo. Read is any
signed-in user, matching the RLS-is-the-authority rule everywhere else in this
app rather than a public URL; write is owner-only, enforced by the object's
path rather than by the client's promise. `profiles.avatar_updated_at` is NULL
for no photo and otherwise doubles as a cache key, so a replaced photo
invalidates without any explicit cache-clearing logic.

**Rendered in two passes, not one.** `avatarSlotHtml()` draws the initials box
synchronously — nothing waits on the network — carrying lookup attributes only
when the profile has a photo; `hydrateAvatars()` downloads and swaps in the
`<img>` once it lands, deduplicated per id+version within a single pass so a
30-person roster costs one request per distinct photo, not one per row. A
photo you just uploaded skips the download entirely: the blob is already in
hand, so it's seeded into the cache directly and appears without a round trip.

**Existing localStorage photos migrate themselves once.** They cannot follow
their owner to Storage on their own — the server has no way to learn about
bytes that only ever lived in one browser — so the first sign-in after this
shipped uploads whatever this browser was holding, silently, and clears the
old key. Best-effort and non-blocking: a failure here just leaves the local
copy in place for next time, it never holds up sign-in.

### The crop modal
Choosing a photo used to go straight to an automatic centred square — the one
part of the picture nobody chose. A group shot, a face that isn't centred, a
landscape photo pressed into service as a portrait: the app picked a crop for
you and you never saw it before it uploaded. `showAvatarCropper()` opens on
every photo choice: drag to reposition, a slider to zoom, a live circular
preview that is the actual `.avatar` shape the photo will render into — not a
square hint that leaves the final crop to the imagination.

**The default framing on open is the old behaviour exactly** — a centred
cover-fit square, zoom at its minimum. Choosing a photo and immediately
confirming with no drag and no zoom reproduces the same result the automatic
crop used to produce, so an unattended upload does not change; only a person
who wants control over it now has some.

**Zooming keeps the stage's centre fixed in image space**, not the image's own
top-left corner — the standard "zoom toward what you're looking at" feel.
Panning is clamped so the image can never be dragged to reveal empty space
around itself: at 1×, a square source cover-fit to the square stage has zero
slack to pan in either dimension by definition (both edges land flush), which
is a property of the geometry, not a bug — zooming in is what creates room to
reposition.

**Confirm computes the exact inverse of the on-screen transform** — the source
rectangle, in the original photo's own pixel coordinates, that the visible
circle currently frames — and draws that through the same `AVATAR_PX` output
canvas the old automatic crop used. Nothing about the upload, RLS, or the
hydrate path changed; only how the source rectangle gets chosen did.

Built on the same dialog chrome `showConfirm()` already established (focus
trap, Escape, and a `history.pushState` so the phone/browser back gesture
closes the dialog instead of backgrounding the app) rather than a new modal
system — including the same fallback timer against `history.back()` never
firing a `popstate`, whose absence in an early draft of this modal would have
left an awaited crop hang forever with nothing on screen to explain why.

### Team roster
A roster grid beside a narrow activity aside. The aside is 220–240px, not
260–300: it holds a short list — "Recent activity" is about 46px of content on a
real roster — and the wider figure was taking exactly the width the roster
needed for a third column. Thirty people ran as two columns of fifteen, three
screens of scrolling, next to a 300px column that was empty for 2,500 of them.

The grid's `minmax` floor is 240px, which is not the width a card ends up at:
with the narrowed aside, three land at 268px, the width they are designed for.
Left at a 268px floor, the same width the cards want was the reason they could
not have it. Dropping the floor without narrowing the aside gives three columns
at 248px, where the name and status line start truncating — both halves are
needed.

Addresses in a card get one line and an ellipsis, with the full value in
`title`. Wrapped, they split mid-domain, which reads as two broken strings
rather than one truncated address.

### Week timeline
An hour axis and seven day columns; each entry is an ink bar spanning its real
clock-in to clock-out, ringed mint or blush for met/under, hatched while a shift
is still open. All-day entries with no clock times become a chip pinned to the
top of the column rather than a bar at an arbitrary hour. The frame adapts to
the week's data — a fixed 6am–10pm window clamps an overnight shift into an
unreadable sliver.

### Trend charts
A line over a labelled y-axis with light gridlines, each point's own target
drawn as a gold dashed step behind it, and dots coloured met/under.

**The baseline is earned, not assumed.** Zero stays on the axis when the data
reaches toward it — the Shortfall chart runs 1h to 4h and needs zero in frame
to mean anything. When the data lives in a band far above zero it does not:
hours-per-day sits at 8h against an 8h target, and a zero baseline put every
point at 87% of the height, turned the week-to-week differences that are the
whole point into a 0.2% wobble, and hid the target line under the data. Above
35% of the maximum, the domain windows to the data instead.

Two rules keep that honest. A **minimum span** (12% of scale) stops windowing
from inflating a one-minute difference into a visible swing. And the **area
fill only exists on a zero baseline** — a fill reads as "how much", which is
only true when the bottom of the plot is zero; the windowed chart is a plain
line.

### Badges / Pills, Inputs, Tables, Modals
Unchanged in structure from the previous system and inherited via the token
layer; only their palette, radii and type moved.

## Do's and Don'ts

### Do
- **Do** keep accents as fills, and reach for `--gold-deep` when a lime-family
  element must carry meaning against a light surface.
- **Do** measure any new text/background pair against 4.5:1 on all six surfaces
  before shipping it.
- **Do** separate cards by surface colour rather than by adding a border or an
  accent stripe.
- **Do** let weight and size carry hierarchy.

### Don't
- **Don't** add a second large dark region. The rail is the dark; the
  quick-clock panel is the one exception.
- **Don't** set text in lime, mint or blush on a light ground.
- **Don't** reintroduce a second typeface to distinguish headings or numerals.
- **Don't** add a theme switch or a dark-mode toggle. Both were deliberately
  retired, along with `app_settings.theme`; one committed look is the point.
- **Don't** give a control the `.sub-tab-btn` class for its looks — that class
  carries the Trends sub-tab click handler and will throw on a button with no
  `data-subtab`.
