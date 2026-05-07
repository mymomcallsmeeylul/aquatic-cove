import type { Friend } from '../data/friends';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

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

function encodeEmail(to: string, subject: string, body: string): string {
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
  return btoa(unescape(encodeURIComponent(mime)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendGmailInvite(token: string, friend: Friend, date: Date, timeStr: string): Promise<void> {
  const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const [hh, mm] = timeStr.split(':').map(Number);
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 || 12;
  const timeDisplay = `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;

  const subject = `Swim at Aquatic Cove — ${dateStr}`;
  const body = [
    `Hey ${friend.name}!`,
    '',
    `I'd love for you to join me for a swim at Aquatic Cove in San Francisco.`,
    '',
    `Date: ${dateStr}`,
    `Time: ${timeDisplay}`,
    `Location: Aquatic Cove, San Francisco, CA`,
    '',
    `The ocean's been perfect lately. Hope to see you there.`,
  ].join('\n');

  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encodeEmail(friend.email, subject, body) }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Gmail API error ${res.status}`);
  }
}

export async function createSwimEvent(date: Date, timeStr: string, friends: Friend[]): Promise<void> {
  const token = await getAccessToken();
  await createCalendarEvent(token, date, timeStr, friends);
  await Promise.all(friends.map(f => sendGmailInvite(token, f, date, timeStr)));
}
