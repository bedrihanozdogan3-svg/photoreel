Of course. As a code architect, I have analyzed your `app.html` file. Here is the comprehensive SPLIT PLAN to modularize the Fenix AI application.

### Fenix AI: Architectural Split Plan

This plan outlines the deconstruction of the single-file `app.html` into a modular, maintainable, and scalable structure.

---

### 1. Main Sections/Components

The application is composed of three primary "screens" and several global/shared components.

*   **Screen 1: Authentication (`#s-auth`, lines 1024-1065)**
    *   Purpose: User login/registration via phone or email.
    *   Key Elements: Phoenix logo animation, input fields, and the "DEVAM" button.

*   **Screen 2: Card Selection (`#s-cards`, lines 1068-1153)**
    *   Purpose: Main menu where users choose an editing mode.
    *   Key Elements: Header with quota display, and a grid of `mode-card` elements for `free`, `reels`, `pro`, `360`, `ses`, and `otonom`.

*   **Screen 3: Workspace (`#s-work`, lines 1165-1634)**
    *   Purpose: The main video editor interface. This is the most complex component.
    *   **Sub-components:**
        *   **Header (`#w-hdr`):** "Geri" button, mode badge, category selector.
        *   **Toolbar (`#w-toolbar`):** Top toolbar with tools like crop, rotate, text, draw.
        *   **Left Asset Panel (`#w-left`):** File upload zone and asset grid.
        *   **Main Canvas Area (`#w-main`):** The central area displaying the image/video, powered by Fabric.js. Includes overlays for histogram, tools, etc.
        *   **Right Parameter Panel (`#w-panel`):** **This is the critical component that changes based on the selected mode.** It contains the accordion-style settings for each card.
        *   **Timeline (`#w-timeline`):** Video and audio track display at the bottom.
        *   **Action Bar (`#w-act`):** Bottom bar with "Önizle" and "ÜRETİME BAŞLA" buttons.

*   **Global/Overlay Components:**
    *   **Upgrade Modal (`#upg-modal`, lines 1156-1162):** A modal that appears when a locked card is clicked.
    *   **Category Modal (`#cat-modal`, lines 1637-1646):** A modal for selecting the product category.
    *   **Toast Notifications (`#toast`, line 1648):** For user feedback.
    *   **Background Animation (`#fc`, line 1023):** The animated particle background on the auth screen.

---

### 2. CSS Blocks Belonging to Each Card

The card-specific CSS primarily styles the right-hand parameter panel (`#w-panel`) and any associated toolbars or overlays.

*   **Shared Panel CSS (Core):**
    *   `.pnl`, `.pnl-sec`, `.pnl-hd`, `.pnl-body`: Base styles for the accordion panels (lines 752-777).
    *   `.f-lbl`, `.f-sel`, `.f-slider`, `.tog`, `.chip-g`, `.f-slider-fill`: Generic form control styles used across all panels (lines 800-911).

*   **Card-Specific CSS:**

    *   **Reels Card (`reels`):**
        *   `#pnl-reels` and its contents (lines 1350-1498).
        *   Controls: `#r-exp`, `#adj-bright`, `#hsl-color-sel`, `#eb-filters`.
        *   Related Tools: Crop (`#crop-overlay`, lines 943-960), Draw (`#draw-canvas`, `#draw-toolbar`, lines 962-981). These are also used by other modes but are core to Reels/Free editing.

    *   **Pro Card (`pro`):**
        *   `#pnl-pro` and its contents (lines 1499-1634).
        *   Controls: `#pro-brand`, `#pro-merge-btn`, `#trend-trans-pro`.
        *   **Figür Boyama (Pro Exclusive):**
            *   `#fb-canvas`: The overlay canvas for painting (line 983).
            *   `#fb-toolbar`: The floating toolbar for painting tools (lines 985-1013). These styles are unique to the Pro card.

    *   **360 Card (`360`):**
        *   `#pnl-360` and its contents (lines 1547-1582).
        *   Controls: `#s360-speed`, `#trend-trans-360`.

    *   **Ses Card (`ses`):**
        *   `#pnl-ses` and its contents (lines 1584-1607).
        *   Controls: `#ses-pitch`, `#ses-rate`, `#trend-music-ses`.

    *   **Free Card (`free`):**
        *   `#pnl-free` and its contents (lines 1609-1620).
        *   Controls: `#free-bright`, `#free-contrast`.

    *   **Otonom Card (`otonom`):**
        *   `#pnl-otonom` and its contents (lines 1622-1634). This panel re-uses generic toggle and select styles.

---

### 3. JavaScript Functions Belonging to Each Card

The logic is less segregated. We can identify functions by the DOM elements they manipulate.

*   **Reels Card (`reels`):**
    *   Generic slider event listeners in `init()` for controls inside `#pnl-reels` (e.g., `r-exp`, `r-cont`) (lines 2011-2022).
    *   `fabApplyFilters()` (lines 1827-1857): While global, its primary inputs come from the Reels panel sliders.
    *   `initCrop()` (lines 1916-1969): Logic for the crop tool.
    *   `initDraw()` (lines 1999-2024): Logic for the simple draw tool.

*   **Pro Card (`pro`):**
    *   `initProPanel()` (lines 1972-2051): Handles Pro-specific logic like video merging and event listeners for its unique controls.
    *   `initFigurBoya()` (lines 2054-2191): The entire block of logic for the "Figür Boyama" feature, including `openFB`, `closeFB`, `applyFB`, and `floodFill`. This is exclusive to Pro.
    *   `fbSetPreset()` (line 2194): A global helper for the Figür Boyama presets.

*   **360, Ses, Free, Otonom Cards:**
    *   These currently do not have dedicated, complex functions. Their logic is handled by the generic event listeners for sliders, toggles, and chips defined in the main `init()` function (lines 2011-2041). For example, the listener for `#s360-trans` is set up generically.

---

### 4. Shared/Global (Core)

This is code that is required for the application to run, regardless of the selected mode.

*   **Core State & Constants (lines 1653-1681):**
    *   `S` (State object)
    *   `PKG_TIERS`, `PKG_REQUIRED`, `CATS`, `MODE_LABELS`

*   **Core UI & App Lifecycle:**
    *   `toast()`: Global notification function (lines 1698-1703).
    *   `showScreen()`: Manages screen transitions (lines 1706-1714).
    *   `onAuthInput()`, `startApp()`: Authentication logic (lines 1717-1743).
    *   `goCards()`, `updateQuotaUI()`: Card screen logic and UI updates (lines 1746-1761).
    *   `goWork()`: Initializes the workspace for any given mode (lines 1764-1776).
    *   `showUpgradeModal()`, `closeUpgradeModal()`: Modal logic (lines 1779-1789).
    *   `buildCatGrid()`, `openCatModal()`, `closeCatModal()`: Category modal logic (lines 1792-1811).
    *   `fireCanvas()`: The background particle animation (lines 1684-1695).
    *   Main `init()` function and event listeners for global elements (logout, back, etc.) (lines 2244-2309).

*   **Core Workspace/Editor Functionality:**
    *   **File Handling:** `resetUpload()`, `loadFiles()`, `renderGrid()` (lines 1814-1901).
    *   **Generation Logic:** `generate()`, `done()`, `showResult()` (lines 1904-1946).
    *   **Fabric.js Canvas:** `initFabric()`, `fabAddImage()`, `fabAddVideo()`, `ebShowImage()`, `ebShowVideo()`, `ebReset()` (lines 1782-1981).
    *   **Timeline:** `drawTimeline()`, `drawAudioWave()`, `initTimelineInteraction()` (lines 2044-2241).
    *   **Toolbar:** `initTooltip()`, `initToolbarActions()` (lines 1904-1970).
    *   **Trends API:** `loadTrends()`, `renderTrends()` (lines 1949-2015).
    *   **Utilities:** `initAccordion()`, `initHapticSliders()`, and generic event listeners for `.tog`, `.chip`, etc. (lines 2018-2035, 2099-2114).

---

### 5. Proposed File Structure After Splitting

This structure promotes separation of concerns, scalability, and potential for lazy-loading modules.

```
fenix-ai/
├── public/
│   ├── assets/
│   │   ├── fenix-icon-192.png
│   │   └── ... (other images, fonts)
│   ├── manifest.json
│   ├── sw.js
│   └── trends_db.json
│
├── src/
│   ├── css/
│   │   ├── base/
│   │   │   ├── _reset.css
│   │   │   └── _variables.css
│   │   ├── components/
│   │   │   ├── _button.css
│   │   │   ├── _modal.css
│   │   │   ├── _toast.css
│   │   │   └── _form-controls.css
│   │   ├── layout/
│   │   │   ├── _workspace.css
│   │   │   ├── _header.css
│   │   │   ├── _panels.css
│   │   │   └── _timeline.css
│   │   ├── modes/
│   │   │   ├── _reels-panel.css
│   │   │   ├── _pro-panel.css
│   │   │   ├── _360-panel.css
│   │   │   ├── _ses-panel.css
│   │   │   └── ...
│   │   ├── screens/
│   │   │   ├── _auth.css
│   │   │   └── _cards.css
│   │   └── main.css  (Imports all other CSS files)
│   │
│   ├── js/
│   │   ├── core/
│   │   │   ├── state.js        (S object, constants)
│   │   │   ├── ui.js           (showScreen, toast, modals)
│   │   │   ├── auth.js         (Authentication logic)
│   │   │   └── api.js          (fetch wrappers for /register, /generate)
│   │   ├── workspace/
│   │   │   ├── assets.js       (File upload and grid management)
│   │   │   ├── canvas.js       (All Fabric.js logic)
│   │   │   ├── timeline.js     (Timeline rendering and interaction)
│   │   │   ├── toolbar.js      (Toolbar tooltips and actions)
│   │   │   └── trends.js       (Trend data fetching and rendering)
│   │   ├── modes/
│   │   │   ├── reels.js        (Event listeners for Reels panel)
│   │   │   └── pro.js          (Figür Boyama, video merge logic)
│   │   ├── app.js            (Main entry point, initializes all modules)
│   │   └── init.js           (Wires up all event listeners, calls init functions)
│
└── index.html              (The main HTML shell, linking to main.css and app.js)
```

This architectural plan will transform the monolithic `app.html` into a professional, well-organized codebase, making future development and debugging significantly more efficient.