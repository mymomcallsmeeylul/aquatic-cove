export type Friend = {
  name: string;
  email: string;
  avatar: string | null;
};

export const DEFAULT_FRIENDS: Friend[] = [
  { name: 'Viktor',   email: 'viktor.tsvil@gmail.com',     avatar: null },
  { name: 'Luna',     email: 'xunzhiluna@uni.minerva.edu', avatar: null },
  { name: 'Angelina', email: 'yiyun@uni.minerva.edu',      avatar: null },
  { name: 'Polina',   email: 'polina@uni.minerva.edu',     avatar: null },
  { name: 'Heying',   email: 'heyingw@uni.minerva.edu',    avatar: null },
  { name: 'Eylul',    email: 'eylul@cca.edu',              avatar: null },
];

const STORAGE_KEY = 'aquatic-cove-friends';

export function friendHue(name: string): number {
  return (name.charCodeAt(0) * 47 + name.charCodeAt(name.length - 1) * 13) % 360;
}

export function loadFriends(): Friend[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return [...DEFAULT_FRIENDS, ...(JSON.parse(stored) as Friend[])];
  } catch { /* ignore */ }
  return [...DEFAULT_FRIENDS];
}

export function saveFriend(friend: Friend): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const extra: Friend[] = stored ? (JSON.parse(stored) as Friend[]) : [];
    extra.push(friend);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(extra));
  } catch { /* ignore */ }
}
