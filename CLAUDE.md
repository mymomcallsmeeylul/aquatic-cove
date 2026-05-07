# CLAUDE.md — Aquatic Cove
_Read this before touching any file in this project._

---

## What this project is

A mobile-first, voice-driven interface where the user talks to the ocean. The ocean is the AI agent. There are no buttons. The ASCII fluid simulation IS the UI.

Stack: Vite + React + TypeScript. Entry: `src/main.tsx` → `src/App.tsx`.

---

## NEVER change these things

### 1. The three-layer z-index structure
```
z-index 1  → #cv           (ASCII fluid simulation)
z-index 15 → .response-text + .status-text  (text overlays)
z-index 20 → .entry-screen  (tap to enter)
z-index 30 → settings button
```
These layers must never be collapsed, merged, or reordered.

### 2. Response text is NOT rendered into the ASCII fluid
The ocean response appears in `.response-text` — a separate absolutely positioned div above the fluid. It fades in via CSS `transition: color 0.9s ease`. It is never ASCII-rendered, never part of `#cv`.

### 3. Font
- Response text: **Instrument Serif, italic** — loaded via Google Fonts in `index.css`
- Fluid: monospace only
- Do not swap, replace, or add fallback fonts that change the visual weight

### 4. Water charset
```
WATER_CHARS = " .,_-~cC/"
```
No `@`. No `$`. No `#`. Do not add characters.

### 5. Touch disturbance physics — exact values
```typescript
// Radius
for(let dy=-1; dy<=1; dy++) for(let dx=-1; dx<=1; dx++)  // ±1 only, NOT ±2

// Force
const fx = fdx * 42, fy = fdy * 42;  // NOT 130

// Falloff
const w = Math.exp(-(dx*dx+dy*dy) * 1.2);  // tight, NOT 0.5

// Density injection
s.dn0[IX(nx,ny)] += 32*w;  // NOT 90
```

### 6. Viscosity
```typescript
velStep(s.vx, s.vy, s.vx0, s.vy0, 0.00012, dt);  // NOT 0
```

### 7. Three-mode decay — do not simplify to one value
```typescript
const decay = s.md        ? 0.984   // while touching
            : s.fadeTimer > 0 ? 0.976   // 6s after release
            : 0.980;                    // idle
```

### 8. `simState` in `useRef`, not `useState`
The entire simulation state lives in `simState.current`. Never move fluid arrays, ticks, or mouse coords into React state — it will cause re-render performance issues.

### 9. `stirOcean()` is called on every agent response
When Claude replies, `stirOcean()` runs. The ocean reacts to its own voice. Do not remove this.

### 10. CSS owns the layout — App.tsx does not duplicate it
`index.css` defines `#cv`, `.response-text`, `.status-text`, `.entry-screen`. Do not add inline styles to these elements in JSX.

---

## File responsibilities

| File | Owns |
|---|---|
| `src/App.tsx` | Fluid simulation, rendering loop, voice pipeline, pointer handlers, React state |
| `src/index.css` | All layout, positioning, fonts, transitions for overlay elements |
| `src/services/beachAgentService.ts` | Claude API call + system prompt only |
| `src/main.tsx` | Entry point only — do not modify |

---

## Key constants — do not change without reason

```typescript
const COLS = 46, ROWS = 60;
const N = 64, ITER = 4;
// Physics tick: every 2nd frame
// Render tick: every 3rd frame
// Wave injection amplitude: 0.7
// Glow decay: 0.93 per physics tick
```

---

## CSS layout rules

```css
/* #cv is anchored to the bottom of the viewport */
#cv {
  position: absolute;
  bottom: 0;
  width: 390px;
  font-size: 10px;
  letter-spacing: 2px;
  line-height: 1.0;
}

/* Viewport is fixed at 390px wide, mobile-first */
html, body {
  width: 390px;
  height: 100dvh;
  overflow: hidden;
}
```

---

## Agent voice — system prompt rules (in beachAgentService.ts)

- Speaks as the water/beach in first person
- Warm, embodied, unhurried — never clinical, never cheerful
- Max ~3 sentences
- Sensation over data ("honest cold", not "9°C")
- **Never** bullet points, never "I am an AI", never "Certainly", never "How can I help"

---

## To-do list

### 🔴 Blocking
- [ ] `npm run dev` needs to run stably — confirmed working on Node v20, Vite 5
- [ ] `ANTHROPIC_API_KEY` must be set in `.env.local` as `VITE_ANTHROPIC_API_KEY`
- [ ] Confirm `beachAgentService.ts` is using `@anthropic-ai/sdk` (not `@google/genai`)

### 🟡 Agent improvements  
- [ ] Fetch live water conditions before calling Claude and pass as context:
  - NOAA tides: `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9414290`
  - Buoy water temp: NOAA buoy 46026
  - SF water quality: waterboard.ca.gov
- [ ] `stirOcean()` intensity should scale with response length/intensity
- [ ] Remove or fix `getBeachRecommendations()` — currently uses non-existent model `"gemini-3-flash-preview"`

### 🟢 Polish
- [ ] Test voice on iPhone Safari (requires HTTPS — run `npx local-ssl-proxy --source 8443 --target 8080` for local testing)
- [ ] Confirm Instrument Serif loads (needs internet connection)
- [ ] Entry screen fade-out: uses `.entry-screen.hidden` + CSS `opacity: 0` transition — do not change to `display:none`
- [ ] Deploy to Vercel (handles HTTPS automatically — required for Web Speech API)
- [ ] Set `VITE_ANTHROPIC_API_KEY` in Vercel environment variables dashboard

### 🔵 Physical / NFC
- [ ] NFC tag at the cove opens the app URL — same as manual tap-to-enter
- [ ] Consider geofencing fallback for devices without NFC

---

## Common mistakes to avoid

- **Do not** add a chat input box or send button — voice only
- **Do not** add loading spinners inside `#cv` — status text handles feedback
- **Do not** use `useState` for anything in the animation loop
- **Do not** call `cancelAnimationFrame` outside the `useEffect` cleanup
- **Do not** add new npm packages without checking if the functionality already exists in the codebase
- **Do not** change `ROWS`, `COLS`, or `N` without re-testing the shoreline position
