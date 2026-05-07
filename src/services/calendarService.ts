import type { Friend } from '../data/friends';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;
const SCOPES = 'https://www.googleapis.com/auth/calendar.events';

function getAccessToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error('Google Identity Services not loaded'));
      return;
    }
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error ?? 'OAuth failed'));
        } else {
          resolve(resp.access_token);
        }
      },
    });
    client.requestAccessToken({ prompt: '' });
  });
}

function buildDateTime(date: Date, timeStr: string): string {
  const [hh, mm] = timeStr.split(':').map(Number);
  const d = new Date(date);
  d.setHours(hh, mm, 0, 0);
  // ISO 8601 with timezone offset
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${oh}:${om}`;
}

async function createCalendarEvent(token: string, date: Date, timeStr: string, friends: Friend[]): Promise<void> {
  const start = buildDateTime(date, timeStr);
  const endDate = new Date(date);
  const [hh, mm] = timeStr.split(':').map(Number);
  endDate.setHours(hh + 1, mm, 0, 0);
  const end = buildDateTime(endDate, `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}`);

  const body = {
    summary: 'Swim at Aquatic Cove',
    location: 'Aquatic Cove, San Francisco, CA',
    start: { dateTime: start, timeZone: 'America/Los_Angeles' },
    end:   { dateTime: end,   timeZone: 'America/Los_Angeles' },
    attendees: friends.map(f => ({ email: f.email, displayName: f.name })),
  };

  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Calendar API error ${res.status}`);
  }
}


export async function createSwimEvent(date: Date, timeStr: string, friends: Friend[]): Promise<void> {
  const token = await getAccessToken();
  await createCalendarEvent(token, date, timeStr, friends);
}
