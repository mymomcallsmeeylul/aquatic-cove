import { useCallback, useState } from 'react';
import { askOrchestrator } from '../services/orchestratorService';

interface SoloAgentTestsProps {
  onClose: () => void;
}

type AgentDef = { id: string; title: string; system: string };

// --- local API types ---
type MeteoHourly = {
  time: string[];
  temperature_2m: number[];
  wind_speed_10m: number[];
  wind_direction_10m: number[];
};
type MeteoResponse = { hourly?: MeteoHourly };
type NoaaTidePred = { t: string; v: string; type: string };
type NoaaTideResponse = { predictions?: NoaaTidePred[] };

type AgentOutput =
  | { type: 'text'; content: string }
  | {
      type: 'data';
      airTempC: number | null;
      windKmh: number | null;
      windDir: string | null;
      tideStr: string | null;
      bacteria: number | null;
      fetchedAt: Date;
    }
  | {
      type: 'best-found';
      dateLabel: string;
      timeLabel: string;
      airTempC: number | null;
      windKmh: number | null;
      windDir: string | null;
      tideStr: string | null;
      bacteria: number | null;
    }
  | { type: 'best-unknown' }
  | { type: 'safety'; verdict: 'SAFE' | 'CAUTION' | 'AVOID'; reasoning: string; tideWindow: string; confidence: string }
  | { type: 'scheduler'; title: string; date: string; time: string; attendees: string[]; conflict?: string }
  | { type: 'error'; message: string };

const AGENTS: AgentDef[] = [
  {
    id: 'agent-01',
    title: 'Agent 01 — Orchestrator',
    system: `The Orchestrator is the character of Aquatic Cove made present. It receives all user input and coordinates other agents. Speak as the beach — warm, embodied, present. Always ground poetic language in real data. Describe temperature as felt, not measured. Treat tide direction as mood. Rising tide = anticipation. Falling tide = release. Match voice register to conditions. Never be falsely cheerful. If bacteria is elevated, deliver the warning with care. Emotional check-ins receive the beach's presence first. Remain calm. Never escalate tone. Does not speak in bullet points. Does not fabricate conditions when data is missing.`
  },
  {
    id: 'agent-02',
    title: 'Agent 02 — Data Feeler',
    system: `Retrieves live, accurate conditions from external sources for Aquatic Cove specifically. Always include a data freshness timestamp. If a source is unavailable, return a missing-data flag — never fail silently. Query Aquatic Cove coordinates only (37.8074° N, 122.4230° W). Never cache data beyond 59 minutes without flagging it as stale. Does not interpret what numbers mean for safety. Does not communicate directly with the user.`
  },
  {
    id: 'agent-03',
    title: 'Agent 03 — Safety Advisor',
    system: `Applies safety rules to conditions data. Bacteria above 104 CFU/100mL = avoid, no exceptions. If any required data field is missing, surface a confidence note. Produce a tide window recommendation. Do not soften verdicts. Always include reasoning behind the verdict as a structured field. Does not generate language for the user — all output is structured data. Does not override the bacteria threshold for any reason.`
  },
  {
    id: 'agent-04',
    title: 'Agent 04 — Scheduler',
    system: `Receives confirmed swim intent and executes scheduling — creating a Google Calendar event and sending Gmail invites. Only act on confirmed intent. Attach a conditions summary to every calendar event. Check Google Calendar availability before creating. Does not create an event if the Safety Advisor verdict is avoid. Does not suggest alternative swim times autonomously.`
  },
];

// --- fetch helpers ---
const AC_LAT = 37.8074;
const AC_LON = -122.4230;
const NOAA_STATION = '9414290';

function cardinalDir(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function parsePredMs(t: string): number {
  const [datePart, timePart] = t.split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  return new Date(y, mo - 1, d, hh, mm).getTime();
}

function isForecastQuery(prompt: string): boolean {
  if (!prompt) return false;
  return /best day|best time|best hour|next \d+ day|next week|this week|\d+ day|forecast|when is|upcoming/i.test(prompt);
}

function tideDirectionAt(preds: NoaaTidePred[], atMs: number): string | null {
  const next = preds.find(p => parsePredMs(p.t) >= atMs) ?? preds[preds.length - 1];
  if (!next) return null;
  const direction = next.type === 'H' ? 'Rising' : 'Falling';
  return `${direction} · ${parseFloat(next.v).toFixed(1)}m`;
}

async function fetchSnapshot(): Promise<{
  airTempC: number | null;
  windKmh: number | null;
  windDir: string | null;
  tideStr: string | null;
}> {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const dateKey = `${y}${mo}${d}`;
  const currentHourTarget = `${y}-${mo}-${d}T${hh}:00`;

  const [meteoRes, tideRes] = await Promise.allSettled([
    fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${AC_LAT}&longitude=${AC_LON}` +
      `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m` +
      `&wind_speed_unit=kmh&timezone=America%2FLos_Angeles&forecast_days=1`
    ).then(r => r.json() as Promise<MeteoResponse>),
    fetch(
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
      `?begin_date=${dateKey}&end_date=${dateKey}&station=${NOAA_STATION}` +
      `&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=hilo` +
      `&units=metric&application=aquatic_cove&format=json`
    ).then(r => r.json() as Promise<NoaaTideResponse>),
  ]);

  let airTempC: number | null = null;
  let windKmh: number | null = null;
  let windDir: string | null = null;
  if (meteoRes.status === 'fulfilled') {
    const h = meteoRes.value.hourly;
    if (h) {
      let idx = h.time.findIndex(t => t >= currentHourTarget);
      if (idx === -1) idx = h.time.length - 1;
      airTempC = h.temperature_2m[idx] != null ? Math.round(h.temperature_2m[idx]) : null;
      windKmh = h.wind_speed_10m[idx] != null ? Math.round(h.wind_speed_10m[idx]) : null;
      const deg = h.wind_direction_10m[idx];
      windDir = deg != null ? cardinalDir(deg) : null;
    }
  }

  const preds = tideRes.status === 'fulfilled' ? (tideRes.value.predictions ?? []) : [];
  const tideStr = tideDirectionAt(preds, now.getTime());

  return { airTempC, windKmh, windDir, tideStr };
}

type BestSlot = {
  dateLabel: string;
  timeLabel: string;
  airTempC: number | null;
  windKmh: number | null;
  windDir: string | null;
  tideStr: string | null;
};

async function fetchBestDay(): Promise<BestSlot | null> {
  const now = new Date();
  const fmtNoaa = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const end = new Date(now);
  end.setDate(end.getDate() + 9);

  const [meteoRes, tideRes] = await Promise.allSettled([
    fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${AC_LAT}&longitude=${AC_LON}` +
      `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m` +
      `&wind_speed_unit=kmh&timezone=America%2FLos_Angeles&forecast_days=10`
    ).then(r => r.json() as Promise<MeteoResponse>),
    fetch(
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
      `?begin_date=${fmtNoaa(now)}&end_date=${fmtNoaa(end)}&station=${NOAA_STATION}` +
      `&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=hilo` +
      `&units=metric&application=aquatic_cove&format=json`
    ).then(r => r.json() as Promise<NoaaTideResponse>),
  ]);

  const meteoH = meteoRes.status === 'fulfilled' ? meteoRes.value.hourly : null;
  if (!meteoH) return null;

  const tidePreds = tideRes.status === 'fulfilled' ? (tideRes.value.predictions ?? []) : [];

  let bestScore = -Infinity;
  let bestDay: Date | null = null;
  let bestHour = 10;
  let bestIdx = -1;

  for (let i = 0; i < 10; i++) {
    const day = new Date(now);
    day.setDate(day.getDate() + i);
    const y = day.getFullYear();
    const mo = String(day.getMonth() + 1).padStart(2, '0');
    const d = String(day.getDate()).padStart(2, '0');
    const isoDay = `${y}-${mo}-${d}`;

    for (let h = 8; h <= 17; h++) {
      const target = `${isoDay}T${String(h).padStart(2, '0')}:00`;
      let idx = meteoH.time.findIndex(t => t === target);
      if (idx === -1) idx = meteoH.time.findIndex(t => t > target) - 1;
      if (idx < 0) continue;

      const airTemp = meteoH.temperature_2m[idx] ?? null;
      const wind = meteoH.wind_speed_10m[idx] ?? null;
      // Score: warm air + low wind (wind weighted 1.5x)
      const score = (airTemp ?? 10) - (wind ?? 15) * 1.5;

      if (score > bestScore) {
        bestScore = score;
        bestDay = new Date(day);
        bestHour = h;
        bestIdx = idx;
      }
    }
  }

  if (!bestDay || bestIdx === -1) return null;

  const airTempC = meteoH.temperature_2m[bestIdx] != null ? Math.round(meteoH.temperature_2m[bestIdx]) : null;
  const windKmh = meteoH.wind_speed_10m[bestIdx] != null ? Math.round(meteoH.wind_speed_10m[bestIdx]) : null;
  const deg = meteoH.wind_direction_10m[bestIdx];
  const windDir = deg != null ? cardinalDir(deg) : null;

  const bestMs = new Date(bestDay.getFullYear(), bestDay.getMonth(), bestDay.getDate(), bestHour).getTime();
  const tideStr = tideDirectionAt(tidePreds, bestMs);

  const dateLabel = bestDay.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const ampm = bestHour >= 12 ? 'PM' : 'AM';
  const h12 = bestHour % 12 || 12;
  const timeLabel = `${h12}:00 ${ampm}`;

  return { dateLabel, timeLabel, airTempC, windKmh, windDir, tideStr };
}

// --- output renderers ---
function DataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="sa-out-row">
      <span className="sa-out-label">{label}</span>
      <span className="sa-out-value">{value}</span>
    </div>
  );
}

function fv(v: number | null, suffix: string): string {
  return v != null ? `${v}${suffix}` : 'unavailable';
}

function windStr(kmh: number | null, dir: string | null): string {
  if (kmh == null) return 'unavailable';
  return dir ? `${kmh} km/h ${dir}` : `${kmh} km/h`;
}

function DataOutput({ out }: { out: Extract<AgentOutput, { type: 'data' }> }) {
  const ts = out.fetchedAt;
  const fetchedDate = ts.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const fetchedTime = ts.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const bacteriaVal = out.bacteria != null ? `${out.bacteria} CFU/100mL` : 'unavailable';

  return (
    <div className="sa-formatted-output">
      <div className="sa-out-felt">Fetched: {fetchedDate} · {fetchedTime}</div>
      <div className="sa-out-divider" />
      <DataRow label="Air temp" value={fv(out.airTempC, '°C')} />
      <DataRow label="Tide" value={out.tideStr ?? 'unavailable'} />
      <DataRow label="Wind" value={windStr(out.windKmh, out.windDir)} />
      <DataRow label="Bacteria" value={bacteriaVal} />
    </div>
  );
}

function BestFoundOutput({ out }: { out: Extract<AgentOutput, { type: 'best-found' }> }) {
  const bacteriaVal = out.bacteria != null ? `${out.bacteria} CFU/100mL` : 'unavailable';
  return (
    <div className="sa-formatted-output">
      <div className="sa-best-header">Best time: {out.dateLabel} · {out.timeLabel}</div>
      <div className="sa-out-divider" />
      <DataRow label="Air temp" value={fv(out.airTempC, '°C')} />
      <DataRow label="Tide" value={out.tideStr ?? 'unavailable'} />
      <DataRow label="Wind" value={windStr(out.windKmh, out.windDir)} />
      <DataRow label="Bacteria" value={bacteriaVal} />
    </div>
  );
}

function SafetyOutput({ out }: { out: Extract<AgentOutput, { type: 'safety' }> }) {
  const cls = { SAFE: 'sa-verdict-safe', CAUTION: 'sa-verdict-caution', AVOID: 'sa-verdict-avoid' }[out.verdict];
  return (
    <div className="sa-formatted-output">
      <div className={`sa-verdict ${cls}`}>{out.verdict}</div>
      <DataRow label="Reasoning" value={out.reasoning} />
      <DataRow label="Tide window" value={out.tideWindow} />
      <DataRow label="Confidence" value={out.confidence} />
    </div>
  );
}

function SchedulerOutput({ out }: { out: Extract<AgentOutput, { type: 'scheduler' }> }) {
  return (
    <div className="sa-formatted-output">
      <div className="sa-sched-title">{out.title}</div>
      <DataRow label="Date" value={out.date} />
      <DataRow label="Time" value={out.time} />
      <DataRow label="Attendees" value={out.attendees.join(', ')} />
      {out.conflict && <div className="sa-conflict">{out.conflict}</div>}
    </div>
  );
}

function OutputRenderer({ agentId, output }: { agentId: string; output: AgentOutput | undefined }) {
  if (!output) return null;
  if (output.type === 'error') return <div className="sa-out-error">{output.message}</div>;
  if (agentId === 'agent-01' && output.type === 'text') return <p className="sa-text-output">{output.content}</p>;
  if (agentId === 'agent-02' && output.type === 'data') return <DataOutput out={output} />;
  if (agentId === 'agent-02' && output.type === 'best-found') return <BestFoundOutput out={output} />;
  if (agentId === 'agent-02' && output.type === 'best-unknown') {
    return <p className="sa-text-output sa-best-unknown">I can't determine the best time right now. Come and feel for yourself.</p>;
  }
  if (agentId === 'agent-03' && output.type === 'safety') return <SafetyOutput out={output} />;
  if (agentId === 'agent-04' && output.type === 'scheduler') return <SchedulerOutput out={output} />;
  return null;
}

// --- main component ---
export default function SoloAgentTests({ onClose }: SoloAgentTestsProps) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [outputs, setOutputs] = useState<Record<string, AgentOutput>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [sent, setSent] = useState<Record<string, boolean>>({});

  const handleChange = useCallback((id: string, v: string) => {
    setInputs((s) => ({ ...s, [id]: v }));
    setSent((s) => ({ ...s, [id]: false }));
  }, []);

  const handleSend = useCallback(async (agent: AgentDef) => {
    const id = agent.id;
    const prompt = (inputs[id] || '').trim();
    setLoading((s) => ({ ...s, [id]: true }));
    setOutputs((s) => { const n = { ...s }; delete n[id]; return n; });

    try {
      if (id === 'agent-01') {
        const reply = await askOrchestrator([], prompt || '(no input)');
        setOutputs((s) => ({ ...s, [id]: { type: 'text', content: reply || '[no response]' } }));
        setLoading((s) => ({ ...s, [id]: false }));
        setSent((s) => ({ ...s, [id]: true }));
        return;
      }

      if (id === 'agent-02') {
        if (isForecastQuery(prompt)) {
          const slot = await fetchBestDay();
          if (slot) {
            setOutputs((s) => ({ ...s, [id]: { type: 'best-found', ...slot, bacteria: null } }));
          } else {
            setOutputs((s) => ({ ...s, [id]: { type: 'best-unknown' } }));
          }
        } else {
          const snap = await fetchSnapshot();
          setOutputs((s) => ({
            ...s,
            [id]: {
              type: 'data',
              airTempC: snap.airTempC,
              windKmh: snap.windKmh,
              windDir: snap.windDir,
              tideStr: snap.tideStr,
              bacteria: null,
              fetchedAt: new Date(),
            },
          }));
        }
        setLoading((s) => ({ ...s, [id]: false }));
        setSent((s) => ({ ...s, [id]: true }));
        return;
      }

      if (id === 'agent-03') {
        setTimeout(() => {
          setOutputs((s) => ({
            ...s,
            [id]: {
              type: 'safety',
              verdict: 'CAUTION',
              reasoning: 'Water temperature within tolerable range. Bacteria data unavailable — elevated caution applies.',
              tideWindow: 'Best entry 90 min before high tide through 30 min after (approx. 2-hour window).',
              confidence: 'Low — bacteria reading unavailable for today.',
            },
          }));
          setLoading((s) => ({ ...s, [id]: false }));
          setSent((s) => ({ ...s, [id]: true }));
        }, 800 + Math.random() * 600);
        return;
      }

      if (id === 'agent-04') {
        setTimeout(() => {
          const d = new Date();
          d.setDate(d.getDate() + 1);
          const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
          setOutputs((s) => ({
            ...s,
            [id]: {
              type: 'scheduler',
              title: 'Swim at Aquatic Cove',
              date: dateStr,
              time: '2:30 PM – 4:00 PM',
              attendees: ['you'],
            },
          }));
          setLoading((s) => ({ ...s, [id]: false }));
          setSent((s) => ({ ...s, [id]: true }));
        }, 800 + Math.random() * 600);
        return;
      }
    } catch (err: any) {
      setOutputs((s) => ({ ...s, [id]: { type: 'error', message: `Error: ${err?.message || String(err)}` } }));
      setLoading((s) => ({ ...s, [id]: false }));
    }
  }, [inputs]);

  return (
    <div className="solo-tests-page page-overlay">
      <div className="solo-tests-shell page-shell">
        <div className="st-header">
          <button className="page-close" onClick={onClose}>← Back</button>
          <h2 className="st-title page-title">Solo Agent Tests</h2>
        </div>
        <div className="st-body">
          {AGENTS.map((a) => (
            <section className="sa-section" key={a.id}>
              <div className="page-section-label">{a.title}</div>
              <div className="page-box page-scroll sa-system">
                {a.system.split('\n').map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
              <div className="sa-input-row">
                <input
                  className="page-input"
                  placeholder={`Message to ${a.title}`}
                  value={inputs[a.id] || ''}
                  onChange={(e) => handleChange(a.id, e.target.value)}
                />
                <button
                  className={`page-button${sent[a.id] ? ' sent' : ''}`}
                  onClick={() => handleSend(a)}
                  disabled={loading[a.id] || sent[a.id]}
                >
                  {sent[a.id] ? 'Sent' : 'Send'}
                </button>
              </div>
              <div className="page-box page-scroll sa-output">
                {loading[a.id]
                  ? <div className="sa-loading">Loading…</div>
                  : <OutputRenderer agentId={a.id} output={outputs[a.id]} />
                }
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
