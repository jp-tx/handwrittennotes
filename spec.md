# HandwrittenNotes — Application Spec

## Overview

A single-user web app for creating and editing digital notebooks. Notebooks contain named pages that are either plain text (`.txt`) or bitmap images (`.bmp`). Text pages are editable inline; BMP pages are edited on an HTML5 canvas with MS Paint-style tools supporting stylus and multitouch input. All files live in a host-mounted Docker volume. Access is protected by a single password defined in `docker-compose.yml`.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | .NET 9 |
| Web framework | ASP.NET Core — Razor Pages (UI) + minimal Web API (data endpoints) |
| Frontend | Vanilla JS, plain CSS (no npm, no bundler) |
| Canvas painting | HTML5 Canvas + Pointer Events API |
| Auth | Cookie-based session (single user) |
| Storage | Local filesystem — one flat folder |
| Container | Docker, Docker Compose |

---

## Authentication

- Single user only. No registration flow.
- Password is set via the `APP_PASSWORD` environment variable in `docker-compose.yml`.
- On first request, unauthenticated users are redirected to `/login`.
- On successful login, a server-side session cookie is issued (HttpOnly, SameSite=Strict).
- Session lifetime: 30 days (sliding expiration).
- No username — password only.

**docker-compose.yml snippet:**
```yaml
environment:
  - APP_PASSWORD=changeme
  - DATA_PATH=/data
volumes:
  - ./notes:/data
```

---

## Storage

### Layout

All data lives in a single flat folder (`DATA_PATH`). No subdirectories.

```
/data/
  _index.json          ← metadata: notebook list, page names, order
  <uuid>.txt           ← text page content
  <uuid>.bmp           ← bitmap page content
```

### `_index.json` schema

```json
{
  "notebooks": [
    {
      "id": "uuid",
      "name": "My Notebook",
      "pages": [
        { "id": "uuid", "name": "Page 1", "type": "txt" },
        { "id": "uuid", "name": "Sketch", "type": "bmp" }
      ]
    }
  ]
}
```

- Notebook and page IDs are GUIDs generated on creation.
- Deleting a notebook deletes its pages' files and removes it from the index.
- Deleting a page deletes the file and removes it from the notebook's page list.
- Index is read/written on each mutating API call (no in-memory caching — single-user, low concurrency).

---

## API Endpoints

All endpoints require authentication (401 if not logged in).

### Auth
| Method | Path | Description |
|---|---|---|
| GET | `/login` | Login page (Razor Page) |
| POST | `/login` | Submit password, set session cookie |
| POST | `/logout` | Clear session cookie |

### Notebooks
| Method | Path | Description |
|---|---|---|
| GET | `/api/notebooks` | List all notebooks (id, name, page count) |
| POST | `/api/notebooks` | Create notebook `{ name }` |
| PATCH | `/api/notebooks/{id}` | Rename notebook `{ name }` |
| DELETE | `/api/notebooks/{id}` | Delete notebook and all its pages |

### Pages
| Method | Path | Description |
|---|---|---|
| GET | `/api/notebooks/{id}/pages` | List pages in notebook |
| POST | `/api/notebooks/{id}/pages` | Create page `{ name, type: "txt"|"bmp" }` |
| PATCH | `/api/notebooks/{id}/pages/{pageId}` | Rename page `{ name }` |
| DELETE | `/api/notebooks/{id}/pages/{pageId}` | Delete page |
| GET | `/api/pages/{pageId}/content` | Get raw file (txt or bmp) |
| PUT | `/api/pages/{pageId}/content` | Save raw file content |

### UI Routes (Razor Pages)
| Path | Description |
|---|---|
| `/` | Redirect to last-opened notebook, or notebook list if none |
| `/notebooks` | Notebook list (shown when no notebook open) |
| `/notebooks/{id}/pages/{pageId}` | View/edit a page |

---

## UI Layout

### Shell (all authenticated pages)

```
┌─────────────────────────────────────────────────────────────┐
│  [≡ HandwrittenNotes]                         [Logout]      │  ← header bar (5% height)
├──────────────┬──────────────────────────────────────────────┤
│              │                                              │
│   Sidebar    │              Page Editor                     │
│   (18% w)    │              (82% w)                        │
│              │                                              │
│              │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

All widths and heights are percentage-based. Sidebar collapses to an icon strip on narrow viewports (< 768px wide).

### Sidebar

- "New Notebook" button at top.
- Notebooks listed as collapsible sections.
- Each notebook header shows: collapse toggle, notebook name (editable inline on double-click), delete button.
- Inside each notebook: list of pages with name (editable inline on double-click), delete button.
- Clicking a page name navigates to that page (pushes URL via History API, no full reload for txt pages; full nav for bmp).
- "Add Page" button at the bottom of each open notebook section — opens a small inline form: name field, then two type-toggle buttons **BMP** (default, selected on open) and **TXT**. Only one can be active at a time; clicking switches the selection. No dropdown.
- Active page is highlighted.

### Page Editor — Text (`.txt`)

- Fills the editor area.
- Plain `<textarea>` styled to fill the space, monospace font, no decoration.
- Auto-saves on a 1-second debounce after any change (PUT to `/api/pages/{pageId}/content`).
- Save indicator ("Saved" / "Saving…") in top-right of editor area.

### Page Editor — BMP (`.bmp`)

- Canvas centered in editor area, scaling to fit available space while preserving the configured aspect ratio.
- Canvas logical resolution is set per the user's **Default Canvas Size** setting (see Settings page).
- Uses CSS `transform: scale()` to fit viewport — no resolution loss.
- Pointer Events API for all input (mouse, pen, touch), with `touch-action: none` on canvas.
- Canvas size is chosen at page creation time from the current default; it cannot be changed after a page is created.

#### Tool Palette

Floats above the canvas in a compact collapsible strip. Organized into groups, each group collapsible independently.

**Group: Draw**
- Pen — freehand line
- Eraser — erase to white

**Group: Shape**
- Line — straight line (click-drag)
- Rectangle — hollow rect (click-drag)
- Filled Rectangle — filled rect (click-drag)
- Ellipse — hollow ellipse (click-drag)
- Filled Ellipse — filled ellipse (click-drag)

**Group: Fill**
- Flood Fill — fill contiguous region with foreground color (bucket)
- Spray Paint — airbrush scatter effect

**Tool Options** (context-sensitive, shown below the group strip):
- Brush size: 1 / 2 / 4 / 8 / 16 px (button row)
- Spray radius and density (shown only for Spray Paint)

**Color Palette**:
- 16-color fixed palette (MS Paint classic palette)
- Foreground and background color swatches (click palette to set foreground, right-click to set background)
- Custom color button → opens `<input type="color">` picker

**Palette collapsed state**: shows only the active tool icon, active foreground/background swatches, and active brush size. Click to expand.

#### Canvas Interactions
- `pointerdown` → start stroke/shape
- `pointermove` → continue stroke/shape (preview for shapes)
- `pointerup` / `pointercancel` → commit stroke/shape
- Pen pressure (`event.pressure`) modulates opacity for pen tool (0.3–1.0 range)
- Two-finger pinch-to-zoom on the canvas viewport (CSS transform, does not affect BMP resolution)
- Two-finger pan when zoomed
- Right-click drag → pan (desktop fallback)

#### Saving BMP
- "Save" button in editor toolbar (or Ctrl+S) serializes canvas to BMP format and PUTs to the API.
- BMP encoding done in JS (no external library — hand-rolled 24-bit uncompressed BMP writer, ~50 lines).
- Dirty indicator shown when unsaved changes exist.

---

## Responsive Behavior

| Viewport | Behavior |
|---|---|
| ≥ 1024px | Full sidebar (18% width) + editor |
| 768–1023px | Sidebar collapses to icon strip (48px), expands on hover/tap |
| < 768px | Sidebar hidden behind hamburger menu overlay |

- All font sizes, padding, and button sizes use `clamp()` or `vw`/`vh` units.
- Canvas scales via CSS transform to always fit the editor area without overflow.
- Tool palette is always accessible — floats and scrolls if needed on small screens.

---

## Docker Compose

```yaml
services:
  handwrittennotes:
    build:
      context: ./HandwrittenNotes
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    environment:
      - ASPNETCORE_ENVIRONMENT=Production
      - APP_PASSWORD=changeme
      - DATA_PATH=/data
    volumes:
      - ./notes:/data
```

The `./notes` folder on the host stores all notebooks. It is created automatically by Docker if absent.

---

## Settings Page

Route: `/settings`

Accessible via a gear icon in the header. Single page, no sub-sections.

### Options

**Default Canvas Size** (applied to all newly created BMP pages)

| Label | Resolution | Notes |
|---|---|---|
| Full HD Landscape | 1920 × 1080 | Default |
| Full HD Portrait | 1080 × 1920 | |
| A4 @ 200 DPI | 1654 × 2339 | Good for handwritten notes |
| A4 @ 300 DPI | 2480 × 3508 | High fidelity, larger files |
| Square HD | 1080 × 1080 | |
| 4K Landscape | 3840 × 2160 | Heavy on memory |

Displayed as a radio button group or segmented control.

**Session Timeout**

- Dropdown: 1 day / 7 days / 30 days / Never
- Default: 30 days

Settings are stored in `_index.json` under a top-level `"settings"` key:

```json
{
  "settings": {
    "defaultCanvasWidth": 1920,
    "defaultCanvasHeight": 1080,
    "sessionDays": 30
  },
  "notebooks": [ ... ]
}
```

### API
| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Get current settings |
| PUT | `/api/settings` | Save settings |

---

## Out of Scope

- Multi-user / accounts
- Cloud sync
- PDF export
- Image import / paste from clipboard
- Undo/redo (nice-to-have but not in v1)
- Mobile app

---

## Open Questions (resolved)

- **Frontend**: Razor Pages + vanilla JS ✓
- **Canvas size**: 1920 × 1080 px ✓
- **Auth**: Password-only, cookie session ✓
- **Storage**: Flat folder, JSON index ✓
