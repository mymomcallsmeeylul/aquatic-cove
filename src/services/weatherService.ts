const NOAA_STATION = '9414290';
const AC_LAT = 37.8074, AC_LON = -122.4230;

export type TideInfo = {
  level: number;
  type: 'High' | 'Low';
  time: string; // NOAA format: "YYYY-MM-DD HH:MM"
};

export type WeatherData = {
  tide: TideInfo | null;
  windKmh: number | null;
  waterTempC: number | null;
};

// In-memory caches — tide by date key, wind as 7-day forecast, temp once per session
const tideCache = new Map<string, TideInfo[]>();
let windForecast: { times: string[]; speeds: number[] } | null = null;
let waterTempCache: number | null | undefined = undefined;

function dateCacheKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseTideTime(noaaTime: string): Date {
  // "YYYY-MM-DD HH:MM" (local time)
  const [datePart, timePart] = noaaTime.split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  return new Date(y, mo - 1, d, hh, mm, 0);
}

async function fetchTidePredictions(date: Date): Promise<TideInfo[]> {
  const key = dateCacheKey(date);
  if (tideCache.has(key)) return tideCache.get(key)!;
  const [y, m, d] = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
  const dateStr = `${y}${m}${d}`;
  const url =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?begin_date=${dateStr}&end_date=${dateStr}&station=${NOAA_STATION}` +
    `&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=hilo` +
    `&units=metric&application=aquatic_cove&format=json`;
  const res = await fetch(url);
  const data = await res.json() as { predictions?: Array<{ t: string; v: string; type: string }> };
  const preds: TideInfo[] = (data.predictions ?? []).map(p => ({
    type: p.type === 'H' ? 'High' : 'Low',
    level: parseFloat(p.v),
    time: p.t,
  }));
  tideCache.set(key, preds);
  return preds;
}

function selectTide(predictions: TideInfo[], date: Date, timeStr: string): TideInfo | null {
  if (!predictions.length) return null;
  const [hh, mm] = timeStr.split(':').map(Number);
  const ref = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm, 0);
  return predictions.find(p => parseTideTime(p.time) >= ref)
    ?? predictions[predictions.length - 1];
}

async function ensureWindForecast(): Promise<void> {
  if (windForecast) return;
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${AC_LAT}&longitude=${AC_LON}` +
    `&hourly=wind_speed_10m&wind_speed_unit=kmh` +
    `&timezone=America%2FLos_Angeles&forecast_days=7`;
  const res = await fetch(url);
  const data = await res.json() as {
    hourly?: { time: string[]; wind_speed_10m: number[] };
  };
  if (data.hourly?.time && data.hourly?.wind_speed_10m) {
    windForecast = { times: data.hourly.time, speeds: data.hourly.wind_speed_10m };
  }
}

function selectWind(date: Date, timeStr: string): number | null {
  if (!windForecast) return null;
  const [hh] = timeStr.split(':').map(Number);
  // Build target hour string matching Open-Meteo format: "YYYY-MM-DDTHH:00"
  const target = `${dateCacheKey(date)}T${String(hh).padStart(2, '0')}:00`;
  const idx = windForecast.times.findIndex(t => t >= target);
  if (idx === -1) return windForecast.speeds[windForecast.speeds.length - 1] ?? null;
  return windForecast.speeds[idx] ?? null;
}

export async function fetchWaterTemp(): Promise<number | null> {
  if (waterTempCache !== undefined) return waterTempCache;
  const url =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?date=latest&station=${NOAA_STATION}&product=water_temperature` +
    `&units=metric&time_zone=lst_ldt&format=json`;
  const res = await fetch(url);
  const data = await res.json() as { data?: Array<{ v: string }> };
  const val = data.data?.[0]?.v ? parseFloat(data.data[0].v) : null;
  waterTempCache = val;
  return val;
}

export async function fetchWeatherForDate(date: Date, timeStr: string): Promise<WeatherData> {
  // All three fetches are cached after first call; only tide changes per date.
  const [tidesResult, , tempResult] = await Promise.allSettled([
    fetchTidePredictions(date),
    ensureWindForecast(),
    fetchWaterTemp(),
  ]);
  const predictions = tidesResult.status === 'fulfilled' ? tidesResult.value : [];
  return {
    tide:       selectTide(predictions, date, timeStr),
    windKmh:    selectWind(date, timeStr),
    waterTempC: tempResult.status === 'fulfilled' ? tempResult.value : null,
  };
}

export function formatTide(tide: TideInfo): string {
  const timePart = tide.time.split(' ')[1];
  if (!timePart) return `${tide.type} ${tide.level.toFixed(1)}m`;
  const [hStr, mStr] = timePart.split(':');
  const h = parseInt(hStr);
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return `${tide.type} ${tide.level.toFixed(1)}m · ${h12}:${mStr}${ampm}`;
}
