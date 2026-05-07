import { useEffect, useRef, useState, useCallback } from 'react';
import { askOcean, type Message } from './services/beachAgentService';
import SchedulePanel from './components/SchedulePanel';
import { loadFriends, type Friend } from './data/friends';
import { createSwimEvent } from './services/calendarService';

// ── Constants ────────────────────────────────────────────────────────────────
const COLS = 46, ROWS = 60;
const N = 64, ITER = 4;
const SZ = (N + 2) * (N + 2);
const WATER_CHARS = ' .,_-~cC/';
const TPI = 2 * Math.PI;

const SCHEDULE_TRIGGERS = [
  'schedule','plan','visit','swim','come by','come down',
  'invite','bring','tomorrow','this weekend','next week',
  'what time','when should',"let's go",'meet up','join me',
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

function waterColor(d: number, g: number): string | null {
  if (d < 0.015 && g < 0.05) return null;
  const wH = 215 - d * 40, wS = Math.max(20, 85 - d * d * 55), wL = 12 + d * 75;
  if (g > 0.04) {
    const gt = Math.min(1, g * 1.6);
    return `hsl(${(wH + (195 - wH) * gt) | 0},${(wS + (100 - wS) * gt) | 0}%,${(wL + (85 - wL) * gt) | 0}%)`;
  }
  return `hsl(${wH | 0},${wS | 0}%,${wL | 0}%)`;
}

function sandHSL(wetness: number): [number, number, number] {
  return [48 - wetness * 8, 96 - wetness * 36, 89 - wetness * 19];
}

// ── Render ASCII fluid to #cv innerHTML ───────────────────────────────────────
function renderFluid(s: SimState, cvEl: HTMLDivElement) {
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
        col = waterColor(dEff, g);
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
      const msg = err instanceof Error ? err.message : 'network error';
      setStatusText(msg);
      setStatusClass('error');
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

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    const s = simState.current;
    const t = e.touches[0];
    s.md = true;
    [s.mx, s.my] = toFluid(t.clientX, t.clientY);
    s.pmx = s.mx; s.pmy = s.my;
  }, [toFluid]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    const s = simState.current;
    const t = e.touches[0];
    s.pmx = s.mx; s.pmy = s.my;
    [s.mx, s.my] = toFluid(t.clientX, t.clientY);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = s.mx + dx, ny = s.my + dy;
      if (nx > 0 && nx <= N && ny > 0 && ny <= N)
        s.glowMap[IX(nx, ny)] += 1.8 * Math.exp(-(dx * dx + dy * dy) * 1.2);
    }
  }, [toFluid]);

  const onTouchEnd = useCallback(() => {
    const s = simState.current;
    s.md = false;
    s.fadeTimer = 6;
  }, []);

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
        renderFluid(s, cvRef.current);
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
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
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
      <button className="settings-btn" aria-label="Settings">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M1.52192 11.8052C1.52192 10.5268 1.68764 9.35153 2.01907 8.27942C2.3539 7.20394 2.83076 6.21469 3.44968 5.31169H4.50487C4.26136 5.64651 4.03308 6.05912 3.82001 6.54951C3.61032 7.03653 3.426 7.57258 3.26705 8.15767C3.10809 8.73938 2.98295 9.34138 2.89164 9.96368C2.80371 10.586 2.75974 11.1998 2.75974 11.8052C2.75974 12.6101 2.83753 13.4269 2.9931 14.2555C3.14867 15.0841 3.35836 15.8535 3.62216 16.5637C3.88596 17.2739 4.18019 17.8523 4.50487 18.2987H3.44968C2.83076 17.3957 2.3539 16.4081 2.01907 15.336C1.68764 14.2606 1.52192 13.0836 1.52192 11.8052ZM11.7099 17.1623C10.9726 17.1623 10.2793 17.0237 9.62992 16.7463C8.98395 16.469 8.41408 16.0852 7.9203 15.5948C7.42991 15.101 7.04436 14.5311 6.76365 13.8851C6.48632 13.2392 6.34935 12.5459 6.35273 11.8052C6.35611 11.0645 6.49647 10.3712 6.77379 9.72524C7.0545 9.07927 7.44005 8.51109 7.93045 8.0207C8.42084 7.52692 8.98903 7.14137 9.63499 6.86404C10.281 6.58672 10.9726 6.44805 11.7099 6.44805C12.4505 6.44805 13.1439 6.58672 13.7898 6.86404C14.4392 7.14137 15.0074 7.52692 15.4944 8.0207C15.9848 8.51109 16.3686 9.07927 16.646 9.72524C16.9233 10.3712 17.0636 11.0645 17.067 11.8052C17.0704 12.5459 16.9334 13.2392 16.6561 13.8851C16.3788 14.5311 15.9949 15.101 15.5045 15.5948C15.0141 16.0852 14.4442 16.469 13.7949 16.7463C13.1455 17.0237 12.4505 17.1623 11.7099 17.1623ZM11.7099 15.9854C12.2882 15.9854 12.831 15.8772 13.3383 15.6607C13.8456 15.4443 14.2904 15.145 14.6725 14.7628C15.0547 14.3806 15.354 13.9376 15.5705 13.4336C15.7869 12.9263 15.8934 12.3852 15.8901 11.8103C15.8867 11.2319 15.7768 10.6891 15.5603 10.1818C15.3439 9.67451 15.0446 9.22978 14.6624 8.84761C14.2802 8.46544 13.8372 8.16613 13.3332 7.94968C12.8293 7.73323 12.2882 7.625 11.7099 7.625C11.1349 7.625 10.5955 7.73323 10.0916 7.94968C9.58765 8.16613 9.1446 8.46713 8.76243 8.85268C8.38026 9.23485 8.07926 9.67959 7.85943 10.1869C7.64298 10.6908 7.53306 11.2319 7.52968 11.8103C7.5263 12.3818 7.63283 12.9213 7.84928 13.4286C8.06573 13.9325 8.36504 14.3755 8.74721 14.7577C9.13276 15.1399 9.5775 15.4409 10.0814 15.6607C10.5887 15.8772 11.1315 15.9854 11.7099 15.9854ZM21.9004 11.8052C21.9004 13.0836 21.733 14.2606 21.3981 15.336C21.0667 16.4081 20.5915 17.3957 19.9726 18.2987H18.9174C19.1609 17.9639 19.3875 17.5513 19.5972 17.0609C19.8103 16.5739 19.9963 16.0395 20.1552 15.4578C20.3142 14.8727 20.4376 14.269 20.5256 13.6467C20.6169 13.021 20.6625 12.4072 20.6625 11.8052C20.6625 11.0003 20.5848 10.1835 20.4292 9.35491C20.2736 8.52631 20.0639 7.7569 19.8001 7.04667C19.5363 6.33644 19.2421 5.75812 18.9174 5.31169H19.9726C20.5915 6.21469 21.0667 7.20394 21.3981 8.27942C21.733 9.35153 21.9004 10.5268 21.9004 11.8052Z" fill="white"/>
          <path d="M12.1948 1.52192C13.4732 1.52192 14.6485 1.68764 15.7206 2.01907C16.7961 2.3539 17.7853 2.83076 18.6883 3.44968V4.50487C18.3535 4.26136 17.9409 4.03308 17.4505 3.82001C16.9635 3.61032 16.4274 3.426 15.8423 3.26705C15.2606 3.10809 14.6586 2.98295 14.0363 2.89164C13.414 2.80371 12.8002 2.75974 12.1948 2.75974C11.3899 2.75974 10.5731 2.83753 9.74452 2.9931C8.91592 3.14867 8.14651 3.35836 7.43628 3.62216C6.72606 3.88596 6.14773 4.18019 5.7013 4.50487V3.44968C6.6043 2.83076 7.59186 2.3539 8.66396 2.01907C9.73945 1.68764 10.9164 1.52192 12.1948 1.52192ZM6.83766 11.7099C6.83766 10.9726 6.97633 10.2793 7.25365 9.62992C7.53098 8.98395 7.91484 8.41408 8.40524 7.9203C8.89901 7.42991 9.46889 7.04436 10.1149 6.76365C10.7608 6.48632 11.4541 6.34935 12.1948 6.35273C12.9355 6.35611 13.6288 6.49647 14.2748 6.77379C14.9207 7.0545 15.4889 7.44005 15.9793 7.93045C16.4731 8.42084 16.8586 8.98903 17.136 9.63499C17.4133 10.281 17.5519 10.9726 17.5519 11.7099C17.5519 12.4505 17.4133 13.1439 17.136 13.7898C16.8586 14.4392 16.4731 15.0074 15.9793 15.4944C15.4889 15.9848 14.9207 16.3686 14.2748 16.646C13.6288 16.9233 12.9355 17.0636 12.1948 17.067C11.4541 17.0704 10.7608 16.9334 10.1149 16.6561C9.46889 16.3788 8.89901 15.9949 8.40524 15.5045C7.91484 15.0141 7.53098 14.4442 7.25365 13.7949C6.97633 13.1455 6.83766 12.4505 6.83766 11.7099ZM8.01461 11.7099C8.01461 12.2882 8.12284 12.831 8.33929 13.3383C8.55574 13.8456 8.85505 14.2904 9.23722 14.6725C9.61939 15.0547 10.0624 15.354 10.5664 15.5705C11.0737 15.7869 11.6148 15.8934 12.1897 15.8901C12.7681 15.8867 13.3109 15.7768 13.8182 15.5603C14.3255 15.3439 14.7702 15.0446 15.1524 14.6624C15.5346 14.2802 15.8339 13.8372 16.0503 13.3332C16.2668 12.8293 16.375 12.2882 16.375 11.7099C16.375 11.1349 16.2668 10.5955 16.0503 10.0916C15.8339 9.58765 15.5329 9.1446 15.1473 8.76243C14.7652 8.38026 14.3204 8.07926 13.8131 7.85943C13.3092 7.64298 12.7681 7.53306 12.1897 7.52968C11.6182 7.5263 11.0787 7.63283 10.5714 7.84928C10.0675 8.06573 9.62446 8.36504 9.24229 8.74721C8.86012 9.13276 8.55912 9.5775 8.33929 10.0814C8.12284 10.5887 8.01461 11.1315 8.01461 11.7099ZM12.1948 21.9004C10.9164 21.9004 9.73945 21.733 8.66396 21.3981C7.59186 21.0667 6.6043 20.5915 5.7013 19.9726V18.9174C6.03612 19.1609 6.44873 19.3875 6.93912 19.5972C7.42614 19.8103 7.9605 19.9963 8.54221 20.1552C9.1273 20.3142 9.73099 20.4376 10.3533 20.5256C10.979 20.6169 11.5928 20.6625 12.1948 20.6625C12.9997 20.6625 13.8165 20.5848 14.6451 20.4292C15.4737 20.2736 16.2431 20.0639 16.9533 19.8001C17.6636 19.5363 18.2419 19.2421 18.6883 18.9174V19.9726C17.7853 20.5915 16.7961 21.0667 15.7206 21.3981C14.6485 21.733 13.4732 21.9004 12.1948 21.9004Z" fill="white"/>
        </svg>
      </button>
    </>
  );
}
