import { useState, useEffect } from 'react';
import { type Friend, loadFriends, saveFriend, friendHue } from '../data/friends';
import { fetchWeatherForDate, formatTide, type WeatherData } from '../services/weatherService';
import { createSwimEvent } from '../services/calendarService';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const WEEKDAYS = ['Mo','Tu','We','Th','Fr','Sa','Su'];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getMondayOffset(year: number, month: number): number {
  const jsDay = new Date(year, month, 1).getDay(); // 0=Sun
  return (jsDay + 6) % 7; // Mon=0
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

function isPast(year: number, month: number, day: number): boolean {
  const today = new Date();
  const d = new Date(year, month, day);
  d.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return d < today;
}

interface SchedulePanelProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (date: Date, time: string, friends: Friend[]) => Promise<void>;
  initialDate?: Date;
  preselectedFriends?: string[];
}

export default function SchedulePanel({
  open,
  onClose,
  onConfirm,
  initialDate,
  preselectedFriends = [],
}: SchedulePanelProps) {
  const today = new Date();
  const startDate = initialDate ?? today;

  const [viewYear,  setViewYear]  = useState(startDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(startDate.getMonth());
  const [selDate,   setSelDate]   = useState<Date>(startDate);
  const [time,      setTime]      = useState('09:30');
  const [weather,   setWeather]   = useState<WeatherData>({ tide: null, windKmh: null, waterTempC: null });
  const [friends,   setFriends]   = useState<Friend[]>([]);
  const [selEmails, setSelEmails] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [error,      setError]    = useState('');

  // Add friend form
  const [showAdd,   setShowAdd]   = useState(false);
  const [addName,   setAddName]   = useState('');
  const [addEmail,  setAddEmail]  = useState('');

  // Load friends from localStorage on mount
  useEffect(() => {
    const all = loadFriends();
    setFriends(all);
    // Pre-select friends whose names appear in the voice transcript
    const pre = new Set(
      all.filter(f => preselectedFriends.some(n => n.toLowerCase() === f.name.toLowerCase()))
         .map(f => f.email)
    );
    setSelEmails(pre);
  }, [preselectedFriends]);

  // Sync calendar view when initialDate changes (panel re-opens with new date)
  useEffect(() => {
    if (open && initialDate) {
      setSelDate(initialDate);
      setViewYear(initialDate.getFullYear());
      setViewMonth(initialDate.getMonth());
    }
  }, [open, initialDate]);

  // Re-derive weather whenever the panel is open, the date, or the time changes.
  // Tide predictions are cached per date; wind forecast is cached for the session —
  // so only the first open and date changes cause network requests.
  useEffect(() => {
    if (!open) return;
    fetchWeatherForDate(selDate, time).then(setWeather).catch(() => {});
  }, [open, selDate, time]);

  // Reset error when user interacts
  useEffect(() => { setError(''); }, [selDate, time, selEmails]);

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  }

  function nextMonth() {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  }

  function selectDay(day: number) {
    const d = new Date(viewYear, viewMonth, day);
    setSelDate(d);
  }

  function toggleFriend(email: string) {
    setSelEmails(prev => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email); else next.add(email);
      return next;
    });
  }

  function handleAddFriend() {
    if (!addName.trim() || !addEmail.trim()) return;
    const f: Friend = { name: addName.trim(), email: addEmail.trim(), avatar: null };
    saveFriend(f);
    setFriends(prev => [...prev, f]);
    setAddName(''); setAddEmail('');
    setShowAdd(false);
  }

  async function handleConfirm() {
    setConfirming(true);
    setError('');
    try {
      const selectedFriends = friends.filter(f => selEmails.has(f.email));
      await onConfirm(selDate, time, selectedFriends);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setConfirming(false);
    }
  }

  // Build calendar cells
  const offset = getMondayOffset(viewYear, viewMonth);
  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const cells: (number | null)[] = [
    ...Array(offset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className={`schedule-panel${open ? ' open' : ''}`}>
      {/* Calendar */}
      <div className="sp-section">
        <div className="sp-month-nav">
          <span className="sp-month-label">{MONTHS[viewMonth]} {viewYear}</span>
          <div className="sp-month-btns">
            <button onClick={prevMonth}>‹</button>
            <button onClick={nextMonth}>›</button>
          </div>
        </div>
        <div className="sp-weekdays">
          {WEEKDAYS.map(d => <span key={d}>{d}</span>)}
        </div>
        <div className="sp-day-grid">
          {cells.map((day, idx) => {
            if (!day) return <span key={`e-${idx}`} />;
            const past = isPast(viewYear, viewMonth, day);
            const sel  = isSameDay(selDate, new Date(viewYear, viewMonth, day));
            return (
              <button
                key={day}
                className={`sp-day${sel ? ' sp-day-sel' : ''}${past ? ' sp-day-past' : ''}`}
                onClick={() => !past && selectDay(day)}
                disabled={past}
              >
                {day}
              </button>
            );
          })}
        </div>
      </div>

      <div className="sp-divider" />

      {/* Info rows */}
      <div className="sp-section">
        <div className="sp-info-row">
          <span className="sp-info-label">Time</span>
          <input
            type="time"
            className="sp-time-input"
            value={time}
            onChange={e => setTime(e.target.value)}
          />
        </div>
        <div className="sp-info-row">
          <span className="sp-info-label">Tide</span>
          <span className="sp-info-value">
            {weather.tide ? formatTide(weather.tide) : '–'}
          </span>
        </div>
        <div className="sp-info-row">
          <span className="sp-info-label">Wind</span>
          <span className="sp-info-value">
            {weather.windKmh != null ? `${Math.round(weather.windKmh)} km/h` : '–'}
          </span>
        </div>
      </div>

      <div className="sp-divider" />

      {/* Friends */}
      <div className="sp-section">
        <span className="sp-section-label">Friends</span>
        <div className="sp-friends-scroll">
          {friends.map(f => {
            const sel = selEmails.has(f.email);
            const hue = friendHue(f.name);
            return (
              <button
                key={f.email}
                className={`sp-avatar-btn${sel ? ' sp-avatar-sel' : ''}`}
                onClick={() => toggleFriend(f.email)}
                style={{ '--avatar-hue': hue } as React.CSSProperties}
              >
                <div className="sp-avatar-circle">
                  {f.avatar
                    ? <img src={f.avatar} alt={f.name} className="sp-avatar-img" />
                    : f.name[0]}
                </div>
                <span className="sp-avatar-name">{f.name}</span>
              </button>
            );
          })}

          {/* Add friend */}
          {!showAdd ? (
            <button className="sp-add-btn" onClick={() => setShowAdd(true)}>+</button>
          ) : (
            <div className="sp-add-form">
              <input
                className="sp-add-input"
                placeholder="Name"
                value={addName}
                onChange={e => setAddName(e.target.value)}
                autoFocus
              />
              <input
                className="sp-add-input"
                placeholder="Email"
                value={addEmail}
                onChange={e => setAddEmail(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddFriend(); }}
              />
              <button className="sp-add-save" onClick={handleAddFriend}>Add</button>
            </div>
          )}
        </div>
      </div>

      {/* Error */}
      {error && <p className="sp-error">{error}</p>}

      {/* Confirm */}
      <div className="sp-confirm-area">
        <button
          className="sp-confirm-btn"
          onClick={handleConfirm}
          disabled={confirming}
        >
          {confirming ? 'Booking…' : 'Confirm'}
        </button>
      </div>
    </div>
  );
}
