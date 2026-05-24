import { useEffect, useRef, useState, useCallback } from 'react';
import { askOcean, type Message } from './services/beachAgentService';
import SchedulePanel from './components/SchedulePanel';
import SystemDiagramPage from './components/SystemDiagramPage';
import KnowledgeBasePage from './components/KnowledgeBasePage';
import SoloAgentTests from './components/SoloAgentTests';
import { loadFriends, type Friend } from './data/friends';
import { createSwimEvent } from './services/calendarService';

// ── Constants ────────────────────────────────────────────────────────────────
const COLS = 46, ROWS = 60;
const N = 64, ITER = 4;
const SZ = (N + 2) * (N + 2);
const WATER_CHARS = ' .,_-~cC/';
const TPI = 2 * Math.PI;

const SCHEDULE_TRIGGERS = [
  'schedule','make a plan','come by','come down',
  'tomorrow','this weekend','next week',
  'when should',"let's go",'meet up','join me',
  'set a time','book a swim','plan a swim',
];

function hasScheduleIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return SCHEDULE_TRIGGERS.some(t => lower.includes(t));
}

function extractHintDate(lower: string): Date | undefined {
  const today = new Date();
  if (lower.includes('tomorrow')) {
    const d = new Date(today); d.setDate(d.getDate() + 1); return d;
  }
  if (lower.includes('this weekend') || lower.includes('weekend')) {
    const d = new Date(today);
    const toSat = (6 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + toSat); return d;
  }
  if (lower.includes('next week')) {
    const d = new Date(today); d.setDate(d.getDate() + 7); return d;
  }
  return undefined;
}

function extractHintFriends(lower: string, friends: Friend[]): string[] {
  return friends
    .filter(f => lower.includes(f.name.toLowerCase()))
    .map(f => f.name);
}

function IX(x: number, y: number): number { return x + (N + 2) * y; }

// ── Perlin noise ─────────────────────────────────────────────────────────────
const perm = (() => {
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const t = new Array(512);
  for (let i = 0; i < 512; i++) t[i] = p[i & 255];
  return t;
})();

const pfade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const plerp = (a: number, b: number, t: number) => a + t * (b - a);
const pgrad = (h: number, x: number, y: number, z: number) => {
  h &= 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : (h === 12 || h === 14) ? x : z;
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
};
function noise(x: number, y: number, z = 0): number {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = pfade(x), v = pfade(y), w = pfade(z);
  const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
  const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
  return plerp(
    plerp(
      plerp(pgrad(perm[AA], x, y, z),     pgrad(perm[BA], x - 1, y, z),     u),
      plerp(pgrad(perm[AB], x, y - 1, z), pgrad(perm[BB], x - 1, y - 1, z), u), v),
    plerp(
      plerp(pgrad(perm[AA + 1], x, y, z - 1),     pgrad(perm[BA + 1], x - 1, y, z - 1),     u),
      plerp(pgrad(perm[AB + 1], x, y - 1, z - 1), pgrad(perm[BB + 1], x - 1, y - 1, z - 1), u), v),
    w
  ) * 0.5 + 0.5;
}

// ── Simulation state ──────────────────────────────────────────────────────────
type SimState = {
  vx: Float32Array; vy: Float32Array;
  vx0: Float32Array; vy0: Float32Array;
  dn: Float32Array; dn0: Float32Array;
  glowMap: Float32Array;
  t: number;
  physicsTick: number;
  renderTick: number;
  md: boolean;
  fadeTimer: number;
  mx: number; my: number;
  pmx: number; pmy: number;
};

function initSim(): SimState {
  return {
    vx: new Float32Array(SZ), vy: new Float32Array(SZ),
    vx0: new Float32Array(SZ), vy0: new Float32Array(SZ),
    dn: new Float32Array(SZ), dn0: new Float32Array(SZ),
    glowMap: new Float32Array(SZ),
    t: 0, physicsTick: 0, renderTick: 0,
    md: false, fadeTimer: 0,
    mx: -1, my: -1, pmx: -1, pmy: -1,
  };
}

// ── Stam fluid solver ─────────────────────────────────────────────────────────
function addSrc(x: Float32Array, x0: Float32Array, dt: number) {
  for (let i = 0; i < SZ; i++) x[i] += dt * x0[i];
}

function setBnd(b: number, x: Float32Array) {
  for (let i = 1; i <= N; i++) {
    x[IX(0, i)]     = b === 1 ? -x[IX(1, i)]   : x[IX(1, i)];
    x[IX(N + 1, i)] = b === 1 ? -x[IX(N, i)]   : x[IX(N, i)];
    x[IX(i, 0)]     = b === 2 ? -x[IX(i, 1)]   : x[IX(i, 1)];
    x[IX(i, N + 1)] = b === 2 ? -x[IX(i, N)]   : x[IX(i, N)];
  }
  x[IX(0, 0)]         = 0.5 * (x[IX(1, 0)]     + x[IX(0, 1)]);
  x[IX(0, N + 1)]     = 0.5 * (x[IX(1, N + 1)] + x[IX(0, N)]);
  x[IX(N + 1, 0)]     = 0.5 * (x[IX(N, 0)]     + x[IX(N + 1, 1)]);
  x[IX(N + 1, N + 1)] = 0.5 * (x[IX(N, N + 1)] + x[IX(N + 1, N)]);
}

function linSolve(b: number, x: Float32Array, x0: Float32Array, a: number, c: number) {
  const ci = 1 / c;
  for (let k = 0; k < ITER; k++) {
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++)
        x[IX(i, j)] = (x0[IX(i, j)] + a * (x[IX(i-1,j)] + x[IX(i+1,j)] + x[IX(i,j-1)] + x[IX(i,j+1)])) * ci;
    setBnd(b, x);
  }
}

function diffuse(b: number, x: Float32Array, x0: Float32Array, d: number, dt: number) {
  const a = dt * d * N * N;
  linSolve(b, x, x0, a, 1 + 4 * a);
}

function advect(b: number, d: Float32Array, d0: Float32Array, u: Float32Array, v: Float32Array, dt: number) {
  const dt0 = dt * N;
  for (let j = 1; j <= N; j++) {
    for (let i = 1; i <= N; i++) {
      let px = i - dt0 * u[IX(i, j)], py = j - dt0 * v[IX(i, j)];
      if (px < 0.5) px = 0.5; if (px > N + 0.5) px = N + 0.5;
      if (py < 0.5) py = 0.5; if (py > N + 0.5) py = N + 0.5;
      const i0 = px | 0, i1 = i0 + 1, j0 = py | 0, j1 = j0 + 1;
      const s1 = px - i0, s0 = 1 - s1, t1 = py - j0, t0 = 1 - t1;
      d[IX(i, j)] = s0 * (t0 * d0[IX(i0, j0)] + t1 * d0[IX(i0, j1)]) +
                    s1 * (t0 * d0[IX(i1, j0)] + t1 * d0[IX(i1, j1)]);
    }
  }
  setBnd(b, d);
}

function project(u: Float32Array, v: Float32Array, p: Float32Array, div: Float32Array) {
  for (let j = 1; j <= N; j++)
    for (let i = 1; i <= N; i++) {
      div[IX(i, j)] = -0.5 * (u[IX(i+1,j)] - u[IX(i-1,j)] + v[IX(i,j+1)] - v[IX(i,j-1)]) / N;
      p[IX(i, j)] = 0;
    }
  setBnd(0, div); setBnd(0, p);
  linSolve(0, p, div, 1, 4);
  for (let j = 1; j <= N; j++)
    for (let i = 1; i <= N; i++) {
      u[IX(i, j)] -= 0.5 * N * (p[IX(i+1,j)] - p[IX(i-1,j)]);
      v[IX(i, j)] -= 0.5 * N * (p[IX(i,j+1)] - p[IX(i,j-1)]);
    }
  setBnd(1, u); setBnd(2, v);
}

function velStep(u: Float32Array, v: Float32Array, u0: Float32Array, v0: Float32Array, vis: number, dt: number) {
  addSrc(u, u0, dt); addSrc(v, v0, dt);
  u0.set(u); diffuse(1, u, u0, vis, dt);
  v0.set(v); diffuse(2, v, v0, vis, dt);
  project(u, v, u0, v0);
  u0.set(u); v0.set(v);
  advect(1, u, u0, u0, v0, dt); advect(2, v, v0, u0, v0, dt);
  project(u, v, u0, v0);
}

function densStep(x: Float32Array, x0: Float32Array, u: Float32Array, v: Float32Array, d: number, dt: number) {
  addSrc(x, x0, dt);
  x0.set(x); diffuse(0, x, x0, d, dt);
  x0.set(x); advect(0, x, x0, u, v, dt);
}

// ── Wave injection ────────────────────────────────────────────────────────────
function injectWaves(s: SimState) {
  const amp = 0.7;
  for (let i = 1; i <= N; i++) {
    const x = i / N;
    const h = amp * (
      Math.sin(TPI * (2.5 * x - 0.22 * s.t)) +
      0.55 * Math.sin(TPI * (3.8 * x - 0.35 * s.t) + 1.2) +
      0.35 * Math.sin(TPI * (1.7 * x - 0.14 * s.t) + 2.5)
    ) / 1.9;
    const surfJ = Math.max(3, Math.min(N - 8, Math.round(N * 0.40 + h * N * 0.07)));
    for (let j = surfJ; j <= N; j++) {
      const depth = j - surfJ;
      s.dn0[IX(i, j)] += (depth < 5 ? 1.5 * Math.exp(-depth * 0.18) : 0.6) * amp;
      s.vx0[IX(i, j)] += 14 * h * Math.exp(-depth * 0.08);
      if (depth < 8) s.vy0[IX(i, j)] += 3 * Math.cos(TPI * (2.5 * x - 0.22 * s.t)) * Math.exp(-depth * 0.25);
    }
    const spray = Math.max(0, h + 0.05 * amp);
    for (let dj = -4; dj < 0; dj++) {
      const j = surfJ + dj; if (j < 1) continue;
      const f = Math.exp(dj * 1.6) * spray;
      s.dn0[IX(i, j)] += 2.0 * f;
      s.vx0[IX(i, j)] += 28 * h * f;
      s.vy0[IX(i, j)] += -6 * f;
    }
  }
}

// ── Stir ocean on agent response ──────────────────────────────────────────────
function stirOcean(s: SimState) {
  const jSurf = Math.max(3, Math.min(N - 5, Math.round(N * 0.38)));
  for (let i = 1; i <= N; i++) {
    for (let dj = 0; dj < 10; dj++) {
      const j = jSurf + dj;
      const w = Math.exp(-dj * 0.22);
      s.dn[IX(i, j)]      += 0.4 * w;
      s.vx[IX(i, j)]      += (i / N - 0.5) * 12;
      s.vy[IX(i, j)]      += 3.0 * w;
      s.glowMap[IX(i, j)] += 0.5 * w;
    }
  }
}

// ── Render helpers ────────────────────────────────────────────────────────────
function cellHash(i: number, j: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const BEACH_SETS = [' .,-_', '.,_- ', '.,x_ ', '.x+, ', 'x+X.,', 'x+X* ', 'X*xX+', 'X**X '];

function beachChar(dist: number, hash: number): string {
  const s = BEACH_SETS[Math.min(BEACH_SETS.length - 1, Math.max(0, (dist * 0.9) | 0))];
  return s[Math.floor(hash * s.length)] || '.';
}

function shoreAt(col: number, t: number): number {
  const x = (col - 1) / (COLS - 1), base = ROWS * 0.877;
  return Math.round(
    base
    + 3.2 * Math.sin(TPI * (0.9 * x  - 0.15 * t))
    + 1.6 * Math.sin(TPI * (1.8 * x  - 0.22 * t) + 1.1)
    + 0.7 * Math.sin(TPI * (3.1 * x  - 0.33 * t) + 2.4)
  );
}

function tempToGlowHSL(tempF: number): [number, number, number] {
  if (tempF < 50) return [210, 100, 55];
  if (tempF < 55) return [200,  85, 70];
  if (tempF < 62) return [210,  20, 92];
  if (tempF < 70) return [ 48,  80, 88];
  if (tempF < 80) return [ 30, 100, 60];
  return [15, 100, 55];
}

function waterColor(d: number, g: number, glowH: number, glowS: number, glowL: number): string | null {
  if (d < 0.015 && g < 0.05) return null;
  const wH = 215 - d * 40, wS = Math.max(20, 85 - d * d * 55), wL = 12 + d * 75;
  if (g > 0.04) {
    const gt = Math.min(1, g * 1.6);
    return `hsl(${(wH + (glowH - wH) * gt) | 0},${(wS + (glowS - wS) * gt) | 0}%,${(wL + (glowL - wL) * gt) | 0}%)`;
  }
  return `hsl(${wH | 0},${wS | 0}%,${wL | 0}%)`;
}

function sandHSL(wetness: number): [number, number, number] {
  return [48 - wetness * 8, 96 - wetness * 36, 89 - wetness * 19];
}

// ── Render ASCII fluid to #cv innerHTML ───────────────────────────────────────
function renderFluid(s: SimState, cvEl: HTMLDivElement, glowH: number, glowS: number, glowL: number) {
  const WL = WATER_CHARS.length - 1;
  let html = '';
  for (let j = 1; j <= ROWS; j++) {
    const rj = Math.round(1 + (j - 1) * (N - 6) / (ROWS - 1));
    for (let i = 1; i <= COLS; i++) {
      const ci   = Math.round(1 + (i - 1) * (N - 1) / (COLS - 1));
      const sj   = shoreAt(i, s.t);
      const dist = j - sj;
      const d    = Math.max(0, Math.min(1, s.dn[IX(ci, rj)]));
      const g    = Math.min(1, s.glowMap[IX(ci, rj)]);
      const hash = cellHash(ci, rj);
      let ch: string, col: string | null;
      if (dist <= -1) {
        const n    = noise(ci * 0.07 + s.t * 0.12, rj * 0.07 - s.t * 0.09);
        const dEff = Math.max(0, Math.min(1, d + n * 0.1 - 0.05));
        ch  = WATER_CHARS[Math.min(WL, (dEff * WL * 1.7) | 0)];
        col = waterColor(dEff, g, glowH, glowS, glowL);
        if (!col) { html += ' '; continue; }
      } else if (dist <= 4) {
        const wet = Math.max(0, 1 - dist / 4);
        ch = (d > 0.3 && dist <= 2)
          ? WATER_CHARS[Math.min(WL, (d * WL * 1.4) | 0)]
          : beachChar(Math.max(0, dist), hash);
        const [sH, sS, sL] = sandHSL(wet * 0.7);
        col = (g > 0.04 && dist <= 2)
          ? `hsla(${sH | 0},${(sS + 15) | 0}%,${(sL + 20) | 0}%,0.85)`
          : `hsla(${sH | 0},${sS | 0}%,${sL | 0}%,0.5)`;
      } else {
        const bd = dist - 4;
        ch = beachChar(bd, hash);
        const [sH, sS, sL] = sandHSL(Math.max(0, 1 - bd / 7) * 0.5);
        col = `hsla(${sH | 0},${sS | 0}%,${(sL + hash * 6 - 3) | 0}%,0.5)`;
      }
      html += `<span style="color:${col}">${ch || ' '}</span>`;
    }
    html += '\n';
  }
  cvEl.innerHTML = html.trimEnd();
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const cvRef   = useRef<HTMLDivElement>(null);
  const simState = useRef<SimState>(initSim());
  const rafRef  = useRef(0);
  const lastRef = useRef(performance.now());
  // fallback: hsl(210, 20%, 92%) — white with slight blue tint (55–62°F range)
  const glowHSLRef = useRef<[number, number, number]>([210, 20, 92]);

  // Voice
  const voiceState  = useRef<'idle' | 'listening' | 'thinking'>('idle');
  const recogRef    = useRef<SpeechRecognition | null>(null);
  const srActive    = useRef(false);
  const history     = useRef<Message[]>([]);
  const respTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);

  // UI state (only what React needs to re-render overlays)
  const [entryHidden,   setEntryHidden]   = useState(false);
  const [entryMounted,  setEntryMounted]  = useState(true);
  const [responseText,  setResponseText]  = useState('');
  const [responseVis,   setResponseVis]   = useState(false);
  const [statusText,    setStatusText]    = useState('');
  const [statusClass,   setStatusClass]   = useState('');

  // Schedule panel state
  const scheduleOpenRef   = useRef(false);
  const [scheduleOpen,    setScheduleOpen]    = useState(false);
  const [scheduleDate,    setScheduleDate]    = useState<Date | undefined>(undefined);
  const [schedulePreFrds, setSchedulePreFrds] = useState<string[]>([]);

  // Resource drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [systemDiagramOpen, setSystemDiagramOpen] = useState(false);
  const [knowledgeBaseOpen, setKnowledgeBaseOpen] = useState(false);
  const [knowledgeBasePersonalization, setKnowledgeBasePersonalization] = useState('');
  const [knowledgeBaseSaved, setKnowledgeBaseSaved] = useState(false);
  const [soloTestsOpen, setSoloTestsOpen] = useState(false);

  // Invite confirmation toast
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [toastMounted,  setToastMounted]  = useState(false);
  const [toastVisible,  setToastVisible]  = useState(false);

  // ── Voice helpers ────────────────────────────────────────────────────────────
  const setListening = useCallback((on: boolean) => {
    setStatusText(on ? 'listening' : 'thinking');
    setStatusClass(on ? 'listening' : '');
  }, []);

  const showResponse = useCallback((text: string) => {
    if (respTimer.current) clearTimeout(respTimer.current);
    setResponseText(text);
    setResponseVis(true);
    respTimer.current = setTimeout(() => {
      setResponseVis(false);
      setTimeout(() => setResponseText(''), 1000);
    }, 10000);
  }, []);

  const handleDrawerToggle = useCallback(() => {
    setDrawerOpen((open) => !open);
  }, []);

  const handleDrawerClose = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  const handleDrawerOptionSelect = useCallback((option: string) => {
    if (option === 'Plan a Dip') {
      setDrawerOpen(false);
      setScheduleOpen(true);
      return;
    }
    if (option === 'System Diagram') {
      setDrawerOpen(false);
      setSystemDiagramOpen(true);
      return;
    }
    if (option === 'Knowledge Base') {
      setDrawerOpen(false);
      setKnowledgeBaseOpen(true);
      return;
    }
    if (option === 'Solo Agent Tests') {
      setDrawerOpen(false);
      setSoloTestsOpen(true);
      return;
    }
    console.log('Resource selected:', option);
    setDrawerOpen(false);
  }, []);

  const handleKnowledgeBasePersonalizationChange = useCallback((value: string) => {
    setKnowledgeBasePersonalization(value);
    setKnowledgeBaseSaved(false);
  }, []);

  const handleKnowledgeBaseSave = useCallback(() => {
    setKnowledgeBaseSaved(true);
  }, []);

  const startListening = useCallback(() => {
    const r = recogRef.current;
    if (!r || voiceState.current === 'thinking' || srActive.current) return;
    voiceState.current = 'listening';
    setListening(true);
    try { r.start(); } catch { srActive.current = false; }
  }, [setListening]);

  const callClaude = useCallback(async (transcript: string) => {
    // Detect scheduling intent from user's words
    if (hasScheduleIntent(transcript)) {
      const lower = transcript.toLowerCase();
      const allFriends = loadFriends();
      setScheduleDate(extractHintDate(lower));
      setSchedulePreFrds(extractHintFriends(lower, allFriends));
      scheduleOpenRef.current = true;
      setScheduleOpen(true);
      // Stop mic while panel is open
      if (recogRef.current) { try { recogRef.current.stop(); } catch { /* ignore */ } }
    }

    voiceState.current = 'thinking';
    setListening(false);
    const prevHistory = [...history.current];
    history.current.push({ role: 'user', content: transcript });
    try {
      const reply = await askOcean(prevHistory, transcript);
      if (reply) {
        history.current.push({ role: 'assistant', content: reply });
        showResponse(reply);
        stirOcean(simState.current);
      }
       } catch (err) {
      history.current.pop();
      let raw = err instanceof Error ? err.message : 'network error';

      // Anthropic SDK errors arrive as "400 {...json...}" — extract the human message
      let displayMsg = raw;
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed?.error?.message) displayMsg = parsed.error.message;
        }
      } catch { /* keep raw */ }

      const isFatal =
        displayMsg.toLowerCase().includes('credit') ||
        displayMsg.toLowerCase().includes('billing') ||
        displayMsg.toLowerCase().includes('auth') ||
        displayMsg.toLowerCase().includes('api key') ||
        displayMsg.toLowerCase().includes('401') ||
        displayMsg.toLowerCase().includes('403');

      setStatusText(isFatal ? displayMsg : 'the tide went quiet. trying again.');
      setStatusClass('error');

      if (isFatal) return;
      if (!scheduleOpenRef.current) {
        setTimeout(() => {
          voiceState.current = 'listening';
          setListening(true);
          startListening();
        }, 4000);
      }
      return;
    }
    // Only resume mic if schedule panel is not open
    if (!scheduleOpenRef.current) {
      voiceState.current = 'listening';
      setListening(true);
      startListening();
    }
  }, [setListening, showResponse, startListening]);

  const showToast = useCallback(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMounted(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setToastVisible(true)));
    toastTimerRef.current = setTimeout(() => {
      setToastVisible(false);
      setTimeout(() => setToastMounted(false), 600);
    }, 3500);
  }, []);

  const handlePanelClose = useCallback(() => {
    scheduleOpenRef.current = false;
    setScheduleOpen(false);
    stirOcean(simState.current);
    voiceState.current = 'listening';
    setListening(true);
    startListening();
  }, [setListening, startListening]);

  const handlePanelConfirm = useCallback(async (date: Date, time: string, friends: Friend[]) => {
    await createSwimEvent(date, time, friends);
    handlePanelClose();
    showToast();
  }, [handlePanelClose, showToast]);

  const initSpeech = useCallback(() => {
    if (recogRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR: (new () => SpeechRecognition) | undefined = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setStatusText(window.isSecureContext ? 'speech unavailable' : 'voice needs https');
      setStatusClass('error');
      return;
    }
    const r = new SR();
    r.continuous = false;
    r.interimResults = false;
    r.lang = 'en-US';
    r.onstart  = () => { srActive.current = true; };
    r.onresult = (e: SpeechRecognitionEvent) => {
      const text = e.results[0]?.[0]?.transcript?.trim();
      if (text && voiceState.current !== 'thinking') callClaude(text);
    };
    r.onend = () => {
      srActive.current = false;
      if (voiceState.current === 'listening') setTimeout(startListening, 300);
    };
    r.onerror = (e: SpeechRecognitionErrorEvent) => {
      srActive.current = false;
      if (e.error === 'not-allowed') {
        setStatusText('allow microphone access');
        setStatusClass('error');
      } else if (voiceState.current === 'listening') {
        setTimeout(startListening, 300);
      }
    };
    recogRef.current = r;
    startListening();
  }, [callClaude, startListening]);

  // ── Entry screen ─────────────────────────────────────────────────────────────
  const handleEntry = useCallback(() => {
    setEntryHidden(true);
    setTimeout(() => setEntryMounted(false), 900);
    initSpeech();
    fetch('https://api.open-meteo.com/v1/forecast?latitude=37.8074&longitude=-122.4230&current=temperature_2m&temperature_unit=fahrenheit')
      .then(r => r.json())
      .then((data: { current?: { temperature_2m?: number } }) => {
        const tempF = data.current?.temperature_2m;
        if (tempF != null) glowHSLRef.current = tempToGlowHSL(tempF);
      })
      .catch(() => {});
  }, [initSpeech]);

  // ── Pointer → fluid coords ───────────────────────────────────────────────────
  const toFluid = useCallback((clientX: number, clientY: number): [number, number] => {
    const el = cvRef.current;
    if (!el) return [-1, -1];
    const r = el.getBoundingClientRect();
    return [
      Math.max(1, Math.min(N, Math.round(((clientX - r.left) / r.width)  * (N - 1)) + 1)),
      Math.max(1, Math.min(N - 5, Math.round(((clientY - r.top)  / r.height) * (N - 1)) + 1)),
    ];
  }, []);

  // ── Pointer handlers ─────────────────────────────────────────────────────────
  const onMouseLeave = useCallback(() => {
    const s = simState.current;
    s.mx = -1; s.my = -1; s.md = false;
    s.fadeTimer = 6;
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const s = simState.current;
    s.md = true;
    [s.mx, s.my] = toFluid(e.clientX, e.clientY);
    s.pmx = s.mx; s.pmy = s.my;
  }, [toFluid]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const s = simState.current;
    s.pmx = s.mx; s.pmy = s.my;
    [s.mx, s.my] = toFluid(e.clientX, e.clientY);
    if (!s.md) { s.pmx = s.mx; s.pmy = s.my; }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = s.mx + dx, ny = s.my + dy;
      if (nx > 0 && nx <= N && ny > 0 && ny <= N)
        s.glowMap[IX(nx, ny)] += 0.5 * Math.exp(-(dx * dx + dy * dy) * 1.2);
    }
  }, [toFluid]);

  const onMouseUp = useCallback(() => {
    const s = simState.current;
    s.md = false;
    s.fadeTimer = 6;
  }, []);

  // Touch handlers attached as non-passive native listeners so preventDefault()
  // actually works on iOS Safari (React synthetic touch events are passive).
  useEffect(() => {
    const el = cvRef.current;
    if (!el) return;
    const s = simState.current;

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0];
      s.md = true;
      [s.mx, s.my] = toFluid(t.clientX, t.clientY);
      s.pmx = s.mx; s.pmy = s.my;
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0];
      s.pmx = s.mx; s.pmy = s.my;
      [s.mx, s.my] = toFluid(t.clientX, t.clientY);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = s.mx + dx, ny = s.my + dy;
        if (nx > 0 && nx <= N && ny > 0 && ny <= N)
          s.glowMap[IX(nx, ny)] += 1.8 * Math.exp(-(dx * dx + dy * dy) * 1.2);
      }
    };

    const onTouchEnd = () => {
      s.md = false;
      s.fadeTimer = 6;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove',  onTouchMove,  { passive: false });
    el.addEventListener('touchend',   onTouchEnd,   { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove',  onTouchMove);
      el.removeEventListener('touchend',   onTouchEnd);
    };
  }, [toFluid]);

  // ── Animation loop ───────────────────────────────────────────────────────────
  useEffect(() => {
    function loop(now: number) {
      rafRef.current = requestAnimationFrame(loop);
      if (document.hidden) return;

      const dt = Math.min((now - lastRef.current) / 1000, 0.05);
      lastRef.current = now;
      const s = simState.current;
      s.t += dt;

      s.physicsTick++;
      if (s.physicsTick % 2 === 0) {
        s.vx0.fill(0); s.vy0.fill(0); s.dn0.fill(0);
        injectWaves(s);

        // Touch disturbance — ±1 radius, force 42, falloff 1.2, density 32
        if (s.md && s.mx > 0) {
          const fdx = s.mx - s.pmx, fdy = s.my - s.pmy;
          const fx = fdx * 42, fy = fdy * 42;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = s.mx + dx, ny = s.my + dy;
            if (nx > 0 && nx <= N && ny > 0 && ny <= N) {
              const w = Math.exp(-(dx * dx + dy * dy) * 1.2);
              s.dn0[IX(nx, ny)] += 32 * w;
              s.vx0[IX(nx, ny)] += fx;
              s.vy0[IX(nx, ny)] += fy;
              s.vx[IX(nx, ny)]  += fdx * 2 * w;
              s.vy[IX(nx, ny)]  += fdy * 2 * w;
              s.glowMap[IX(nx, ny)] += 1.8 * w;
            }
          }
        }

        velStep(s.vx, s.vy, s.vx0, s.vy0, 0.00012, dt);
        densStep(s.dn, s.dn0, s.vx, s.vy, 0.000015, dt);

        // Three-mode decay
        const decay = s.md ? 0.984 : s.fadeTimer > 0 ? 0.976 : 0.980;
        for (let i = 0; i < SZ; i++) {
          s.dn[i]      *= decay;
          s.vx[i]      *= decay;
          s.vy[i]      *= decay;
          s.glowMap[i] *= 0.93;
        }
        if (!s.md && s.fadeTimer > 0) s.fadeTimer -= dt * 2;
      }

      s.renderTick++;
      if (s.renderTick % 3 === 0 && cvRef.current) {
        const [gH, gS, gL] = glowHSLRef.current;
        renderFluid(s, cvRef.current, gH, gS, gL);
      }
    }

    rafRef.current = requestAnimationFrame(loop);

    const onVisChange = () => {
      if (!document.hidden) lastRef.current = performance.now();
    };
    document.addEventListener('visibilitychange', onVisChange);

    return () => {
      cancelAnimationFrame(rafRef.current);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <>
      <div
        id="cv"
        ref={cvRef}
        className={scheduleOpen ? 'dimmed' : undefined}
        onMouseLeave={onMouseLeave}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      />
      <div className={`response-text${responseVis ? ' visible' : ''}`}>{responseText}</div>
      {!scheduleOpen && (
        <div className={`status-text${statusClass ? ` ${statusClass}` : ''}`}>{statusText}</div>
      )}
      {scheduleOpen && (
        <button className="sp-back-floating" onClick={handlePanelClose}>← back</button>
      )}
      {entryMounted && (
        <div className={`entry-screen${entryHidden ? ' hidden' : ''}`} onPointerDown={handleEntry}>
          <div className="entry-title">tap to get closer</div>
          <div className="entry-sub">the cove is waiting</div>
        </div>
      )}
      {toastMounted && (
        <div className={`invite-toast${toastVisible ? ' visible' : ''}`}>
          <span className="invite-toast-label">Invitation sent.</span>
          <span className="invite-toast-text">The water is waiting for you.</span>
        </div>
      )}
      <SchedulePanel
        open={scheduleOpen}
        onClose={handlePanelClose}
        onConfirm={handlePanelConfirm}
        initialDate={scheduleDate}
        preselectedFriends={schedulePreFrds}
      />
      {drawerOpen && <div className="drawer-backdrop" onClick={handleDrawerClose} />}
      <div className={`resource-drawer${drawerOpen ? ' open' : ''}`} aria-hidden={!drawerOpen}>
        <div className="drawer-header">Resources</div>
        <button type="button" className="drawer-option" onClick={() => handleDrawerOptionSelect('Plan a Dip')}>
          Plan a Dip
        </button>
        <button type="button" className="drawer-option" onClick={() => handleDrawerOptionSelect('System Diagram')}>
          System Diagram
        </button>
        <button type="button" className="drawer-option" onClick={() => handleDrawerOptionSelect('Knowledge Base')}>
          Knowledge Base
        </button>
        <button type="button" className="drawer-option" onClick={() => handleDrawerOptionSelect('Solo Agent Tests')}>
          Solo Agent Tests
        </button>
      </div>
      {knowledgeBaseOpen && (
        <KnowledgeBasePage
          onClose={() => setKnowledgeBaseOpen(false)}
          personalization={knowledgeBasePersonalization}
          saved={knowledgeBaseSaved}
          onSave={handleKnowledgeBaseSave}
          onPersonalizationChange={handleKnowledgeBasePersonalizationChange}
        />
      )}
      {soloTestsOpen && (
        <SoloAgentTests onClose={() => setSoloTestsOpen(false)} />
      )}
      {systemDiagramOpen && (
        <SystemDiagramPage onClose={() => setSystemDiagramOpen(false)} />
      )}
      <button className="settings-btn" aria-label="Open resources" aria-expanded={drawerOpen} onClick={handleDrawerToggle}>
        <img
          src="/Aquatic-Cove-Icon.svg"
          alt="Open resources"
          className="settings-icon"
          onError={(event) => {
            event.currentTarget.onerror = null;
            event.currentTarget.src = 'data:image/svg+xml,%3Csvg%20width%3D%22128%22%20height%3D%22128%22%20viewBox%3D%220%200%20128%20128%22%20fill%3D%22none%22%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%3Crect%20width%3D%22128%22%20height%3D%22128%22%20rx%3D%2224%22%20fill%3D%22%2304101E%22%20/%3E%3Ccircle%20cx%3D%2264%22%20cy%3D%2242%22%20r%3D%2218%22%20fill%3D%22%23FFE066%22%20opacity%3D%220.94%22%20/%3E%3Cpath%20d%3D%22M18%2086C28%2072%2038%2066%2054%2066C70%2066%2078%2076%2096%2074C114%2072%20120%2058%20110%2050%22%20stroke%3D%22%236DD5FA%22%20stroke-width%3D%2212%22%20stroke-linecap%3D%22round%22%20/%3E%3Cpath%20d%3D%22M18%20100C28%2088%2040%2088%2054%2088C70%2088%2080%2096%2096%2094C112%2092%20122%2080%20110%2074%22%20stroke%3D%22%236DD5FA%22%20stroke-width%3D%2212%22%20stroke-linecap%3D%22round%22%20/%3E%3Cpath%20d%3D%22M22%20110C34%20100%2044%20100%2056%20100C70%20100%2078%20106%2096%20104C114%20102%20120%2092%20110%2088%22%20stroke%3D%22rgba(255%2C255%2C255%2C0.24)%22%20stroke-width%3D%2210%22%20stroke-linecap%3D%22round%22%20/%3E%3C/svg%3E';
          }}
        />
      </button>
    </>
  );
}
