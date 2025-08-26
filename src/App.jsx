import { useState, useMemo, useEffect } from "react";
import * as SunCalc from "suncalc";


/**
 * Golden Hour Finder — disambiguating geocoder + Tailwind UI + daily weather + hourly cloud chart
 */

export default function App() {
  const [query, setQuery] = useState(""); // "Wichita, KS" / "67037" / "37.545,-97.268"
  const [dateStr, setDateStr] = useState(() => new Date().toISOString().slice(0, 10));
const [recent, setRecent] = useState([]);
useEffect(() => {
  const raw = localStorage.getItem("recentPlaces");
  if (raw) {
    try {
      setRecent(JSON.parse(raw));
    } catch {
      // ignore parse errors
    }
  }
}, []); 
// save to localStorage whenever recent changes
useEffect(() => {
  if (recent.length > 0) {
    localStorage.setItem("recentPlaces", JSON.stringify(recent));
  }
}, [recent]);
 
const [angleDeg, setAngleDeg] = useState(15);
  const [status, setStatus] = useState("Idle");
  const [place, setPlace] = useState(null);        // { label, lat, lon, tz }
  const [result, setResult] = useState(null);      // sun-angle results
  const [weather, setWeather] = useState(null);    // daily weather
  const [hourly, setHourly] = useState(null);      // hourly clouds
  const [candidates, setCandidates] = useState([]); // [{label, lat, lon, tz}]
  const [error, setError] = useState(null);

  const canSearch = query.trim().length > 0 && dateStr;

  // ---------- helpers ----------
  function toUtcMidnight(dateYYYYMMDD) {
    const [y, m, d] = dateYYYYMMDD.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function fmtTime(date, tz, withSeconds = false) {
    if (!date) return "—";
    const opts = { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz };
    if (withSeconds) opts.second = "2-digit";
    return new Intl.DateTimeFormat("en-US", opts).format(date);
  }

  function isValidDate(d) {
    return d instanceof Date && !Number.isNaN(d.getTime());
  }

  function altitudeAt(tMs, lat, lon) {
    const pos = SunCalc.getPosition(new Date(tMs), lat, lon);
    return pos.altitude; // radians
  }

  function findCrossing(startDate, endDate, lat, lon, targetRad) {
    let start = startDate?.getTime?.();
    let end = endDate?.getTime?.();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

    const f = (t) => altitudeAt(t, lat, lon) - targetRad;
    let a = f(start);
    let b = f(end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b || a * b > 0) return null;

    // Binary search to ~30s precision
    let iter = 0;
    while (iter++ < 60 && end - start > 30 * 1000) {
      const mid = (start + end) / 2;
      const fm = f(mid);
      if (a * fm <= 0) {
        end = mid;
        b = fm;
      } else {
        start = mid;
        a = fm;
      }
    }
    return new Date((start + end) / 2);
  }

  // --- Weather helpers ---
  function weatherCodeInfo(code) {
    const map = {
      0: { text: "Clear sky", emoji: "☀️" },
      1: { text: "Mainly clear", emoji: "🌤️" },
      2: { text: "Partly cloudy", emoji: "⛅" },
      3: { text: "Overcast", emoji: "☁️" },
      45: { text: "Fog", emoji: "🌫️" },
      48: { text: "Rime fog", emoji: "🌫️" },
      51: { text: "Light drizzle", emoji: "🌦️" },
      53: { text: "Drizzle", emoji: "🌦️" },
      55: { text: "Heavy drizzle", emoji: "🌦️" },
      56: { text: "Freezing drizzle", emoji: "🌧️" },
      57: { text: "Heavy freezing drizzle", emoji: "🌧️" },
      61: { text: "Light rain", emoji: "🌧️" },
      63: { text: "Rain", emoji: "🌧️" },
      65: { text: "Heavy rain", emoji: "🌧️" },
      66: { text: "Freezing rain", emoji: "🌧️" },
      67: { text: "Heavy freezing rain", emoji: "🌧️" },
      71: { text: "Light snow", emoji: "🌨️" },
      73: { text: "Snow", emoji: "🌨️" },
      75: { text: "Heavy snow", emoji: "❄️" },
      77: { text: "Snow grains", emoji: "🌨️" },
      80: { text: "Rain showers", emoji: "🌦️" },
      81: { text: "Heavy rain showers", emoji: "🌧️" },
      82: { text: "Violent rain showers", emoji: "⛈️" },
      85: { text: "Snow showers", emoji: "🌨️" },
      86: { text: "Heavy snow showers", emoji: "❄️" },
      95: { text: "Thunderstorm", emoji: "⛈️" },
      96: { text: "Thunderstorm + hail", emoji: "⛈️" },
      99: { text: "Severe thunderstorm + hail", emoji: "⛈️" },
    };
    return map[code] ?? { text: "Weather", emoji: "🌤️" };
  }

  async function fetchWeather(lat, lon, dateYYYYMMDD, tz) {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      timezone: tz || "auto",
      start_date: dateYYYYMMDD,
      end_date: dateYYYYMMDD,
      daily: [
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_sum",
        "cloud_cover_mean",
        "weathercode",
      ].join(","),
    });

    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather failed (${res.status})`);
    const data = await res.json();

    const d = data.daily;
    if (!d || !d.time || d.time.length === 0) return null;

    return {
      tmaxC: d.temperature_2m_max[0],   // °C
      tminC: d.temperature_2m_min[0],   // °C
      precipMm: d.precipitation_sum[0], // mm
      cloudsPct: d.cloud_cover_mean[0], // %
      code: d.weathercode[0],           // WMO code
      when: d.time[0],
    };
  }

  // Hourly cloud cover for the date
  async function fetchHourlyCloud(lat, lon, dateYYYYMMDD, tz) {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      timezone: tz || "auto",
      start_date: dateYYYYMMDD,
      end_date: dateYYYYMMDD,
      hourly: "cloud_cover",
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Hourly failed (${res.status})`);
    const data = await res.json();

    const t = data.hourly?.time ?? [];
    const c = data.hourly?.cloud_cover ?? [];
    const out = [];
    for (let i = 0; i < t.length; i++) {
      const s = t[i] || ""; // "YYYY-MM-DDTHH:MM"
      const HH = parseInt(s.slice(11, 13) || "0", 10);
      const MM = parseInt(s.slice(14, 16) || "0", 10);
      const frac = HH + (MM || 0) / 60;
      out.push({ hour: frac, cloud: Number(c[i] ?? 0) });
    }
    return out.length ? out : null;
  }

  // --- Geocoder pieces ---
  async function inferTimezone(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m&timezone=auto`;
    try {
      const res = await fetch(url);
      if (!res.ok) return "UTC";
      const data = await res.json();
      return data.timezone || "UTC";
    } catch {
      return "UTC";
    }
  }

  // Return an ARRAY of candidates [{label, lat, lon, tz}]
  async function geocodeCandidates(name) {
    const q = (name || "").trim();
    const out = [];

    // A) Direct lat,lon input
    const m = q.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
    if (m) {
      const lat = parseFloat(m[1]);
      const lon = parseFloat(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const tz = await inferTimezone(lat, lon);
        return [{ label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon, tz }];
      }
    }

    // B) US ZIP → resolve to City, State then proceed
    if (/^\d{5}$/.test(q)) {
      try {
        const zipRes = await fetch(`https://api.zippopotam.us/us/${q}`);
        if (zipRes.ok) {
          const z = await zipRes.json();
          const placeName = z.places?.[0]?.["place name"];
          const state = z.places?.[0]?.state;
          if (placeName && state) {
            return await geocodeCandidates(`${placeName}, ${state}`);
          }
        }
      } catch {
        // continue into name flow
      }
    }

    async function om(text) {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        text
      )}&count=10&language=en&format=json`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
      const data = await res.json();
      return data.results || [];
    }

    // Try full query
    let results = await om(q);

    // If user included a comma, also try just the head (e.g. "Derby" from "Derby, KS")
    if (!results.length && q.includes(",")) {
      const head = q.split(",")[0];
      results = await om(head);
    }

    // If no country hint, add ", US" as a fallback
    if (!results.length && !/[,\\s][A-Za-z]{2,}$/.test(q)) {
      results = await om(`${q}, US`);
    }

    for (const r of results) {
      out.push({
        label: [r.name, r.admin1, r.country_code].filter(Boolean).join(", "),
        lat: r.latitude,
        lon: r.longitude,
        tz: r.timezone || "UTC",
      });
    }

    // Deduplicate
    const seen = new Set();
    return out.filter((c) => {
      const k = `${c.label}|${c.lat}|${c.lon}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function computeTimes(lat, lon, dateUTC, tz, angleDegrees) {
    const targetRad = (angleDegrees * Math.PI) / 180;
    const times = SunCalc.getTimes(dateUTC, lat, lon);

    const sunrise = times.sunrise;
    const sunset = times.sunset;
    const solarNoon = times.solarNoon;

    if (!isValidDate(solarNoon)) {
      return { ok: false, message: "Solar noon unavailable for this date/location." };
    }

    const noonAlt = altitudeAt(solarNoon.getTime(), lat, lon);

    if (noonAlt < targetRad) {
      return {
        ok: false,
        message: `The Sun never reaches ${angleDegrees}° on this date here. Try a smaller angle.`,
        sunrise,
        sunset,
        solarNoon,
        noonAltDeg: (noonAlt * 180) / Math.PI,
      };
    }

    const morning = findCrossing(sunrise, solarNoon, lat, lon, targetRad);
    const evening = findCrossing(solarNoon, sunset, lat, lon, targetRad);

    if (!morning && !evening) {
      return {
        ok: false,
        message: "Couldn't find crossings today—this can happen near the poles.",
        sunrise,
        sunset,
        solarNoon,
        noonAltDeg: (noonAlt * 180) / Math.PI,
      };
    }

    return {
      ok: true,
      sunrise,
      sunset,
      solarNoon,
      morningAt: morning,
      eveningAt: evening,
      tz,
      angleDeg: angleDegrees,
    };
  }

  // ---------- actions ----------
  async function handleSearch(e) {
    e?.preventDefault?.();
    setError(null);
    setResult(null);
    setWeather(null);
    setHourly(null);
    setPlace(null);
    setCandidates([]);
    if (!canSearch) return;

    try {
      setStatus("Searching places…");
      const list = await geocodeCandidates(query.trim());

      if (!list.length) {
        throw new Error("No matches found.");
      } else if (list.length === 1) {
        // Only one — select it and compute
        onPickPlace(list[0]);
      } else {
        // Multiple — show choices
        setCandidates(list);
        setStatus(`Select a place (${list.length} matches)…`);
      }
    } catch (err) {
      console.error(err);
      setError(err.message || String(err));
      setStatus("Error");
    }
  }

  async function onPickPlace(p) {
    try {
      setStatus("Calculating sun times…");
      setPlace(p);
// update recents (max 5 unique)
setRecent((prev) => {
  const existing = prev.filter((r) => r.label !== p.label);
  return [p, ...existing].slice(0, 5);
});
      const dateUTC = toUtcMidnight(dateStr);
      const computed = computeTimes(p.lat, p.lon, dateUTC, p.tz, angleDeg);
      setResult(computed);

      setStatus("Fetching weather…");
      try {
        const w = await fetchWeather(p.lat, p.lon, dateStr, p.tz);
        setWeather(w);
      } catch (werr) {
        console.warn(werr);
        setWeather(null);
      }

      setStatus("Loading hourly clouds…");
      try {
        const h = await fetchHourlyCloud(p.lat, p.lon, dateStr, p.tz);
        setHourly(h);
      } catch (herr) {
        console.warn(herr);
        setHourly(null);
      }

      setCandidates([]);
      setStatus("Done");
    } catch (err) {
      console.error(err);
      setError(err.message || String(err));
      setStatus("Error");
    }
  }

  const tips = useMemo(
    () => [
      "Type a city + state/country, a ZIP like 67037, or lat,lon like 37.545,-97.268.",
      "If multiple places match, pick the exact one from the list.",
      "15° is a nice proxy for golden-hour portraits.",
    ],
    []
  );

  // ---------- chart ----------
  function localHM(date, tz) {
    const f = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }).formatToParts(date);
    const h = Number(f.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(f.find((p) => p.type === "minute")?.value ?? 0);
    return { h, m };
  }

  function CloudChart({ hourly, tz, morningAt, eveningAt }) {
    if (!hourly || hourly.length === 0) return null;

    const W = 720, H = 200;
    const L = 40, R = 12, T = 12, B = 28;
    const PW = W - L - R, PH = H - T - B;

    const points = hourly.map(({ hour, cloud }) => {
      const x = L + (hour / 24) * PW;
      const y = T + (1 - Math.max(0, Math.min(100, cloud)) / 100) * PH;
      return [x, y];
    });

    const pathD = points.length ? "M " + points.map(([x, y]) => `${x},${y}`).join(" L ") : "";

    const markers = [];
    if (morningAt) {
      const { h, m } = localHM(morningAt, tz);
      markers.push({ x: L + ((h + m / 60) / 24) * PW, color: "#f59e0b" }); // orange
    }
    if (eveningAt) {
      const { h, m } = localHM(eveningAt, tz);
      markers.push({ x: L + ((h + m / 60) / 24) * PW, color: "#ec4899" }); // pink
    }

    const ticksX = [0, 6, 12, 18, 24];
    const ticksY = [0, 50, 100];

    return (
      <div className="mt-6 bg-white/90 backdrop-blur p-6 rounded-2xl shadow">
        <div className="font-bold text-slate-700 mb-2">☁️ Hourly Cloud Cover</div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-48">
          <rect x={L} y={T} width={PW} height={PH} fill="none" stroke="#e5e7eb" />
          {pathD && <path d={pathD} fill="none" stroke="#0ea5e9" strokeWidth="2" />}
          {points.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="2" fill="#0ea5e9" />)}
          {markers.map((m, i) => (
            <line key={i} x1={m.x} y1={T} x2={m.x} y2={T + PH} stroke={m.color} strokeDasharray="4 3" />
          ))}
          {ticksX.map((t) => {
            const x = L + (t / 24) * PW;
            return (
              <g key={t}>
                <line x1={x} x2={x} y1={T + PH} y2={T + PH + 4} stroke="#6b7280" />
                <text x={x} y={T + PH + 16} fontSize="10" textAnchor="middle" fill="#6b7280">{t}</text>
              </g>
            );
          })}
          {ticksY.map((v) => {
            const y = T + (1 - v / 100) * PH;
            return (
              <g key={v}>
                <line x1={L - 4} x2={L} y1={y} y2={y} stroke="#6b7280" />
                <text x={L - 8} y={y + 3} fontSize="10" textAnchor="end" fill="#6b7280">{v}%</text>
              </g>
            );
          })}
        </svg>
        <div className="text-xs text-slate-500 mt-1">
          Golden-hour markers: <span className="text-amber-500">morning</span> (orange),
          <span className="text-pink-500"> evening</span> (pink).
        </div>
      </div>
    );
  }

  // ---------- UI ----------
  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-100 via-yellow-50 to-slate-100 flex items-start justify-center p-6">
      <div className="w-full max-w-2xl">
        <h1 className="text-4xl font-extrabold tracking-tight mb-2 text-slate-800">🌅 Golden Hour Finder</h1>
        <p className="text-slate-600 mb-8 text-lg">
          Instantly find the best times for portraits when the Sun is low in the sky.
        </p>

        <form onSubmit={handleSearch} className="grid gap-4 bg-white/80 backdrop-blur p-6 rounded-2xl shadow-xl">
          <label className="grid gap-1">
            <span className="text-sm font-semibold text-slate-700">City & State (or Country)</span>
            <input
              className="border border-slate-300 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-orange-400 w-full"
              placeholder="Wichita, KS"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          <div className="grid sm:grid-cols-2 gap-4">
            <label className="grid gap-1">
              <span className="text-sm font-semibold text-slate-700">Date</span>
              <input
                type="date"
                className="border border-slate-300 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-orange-400 w-full"
                value={dateStr}
                onChange={(e) => setDateStr(e.target.value)}
              />
            </label>

            <label className="grid gap-1">
              <span className="text-sm font-semibold text-slate-700">Sun Angle (degrees)</span>
              <input
                type="number"
                min={0}
                max={89}
                step={0.5}
                className="border border-slate-300 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-orange-400 w-full"
                value={angleDeg}
                onChange={(e) => setAngleDeg(Number(e.target.value))}
              />
            </label>
          </div>

          <button
            type="submit"
            disabled={!canSearch}
            className="bg-gradient-to-r from-orange-400 to-pink-500 hover:opacity-90 text-white font-semibold rounded-xl py-2 px-4 transition disabled:opacity-40"
          >
            Find Times
          </button>

          <div className="text-xs text-slate-500 italic">{status}</div>
</form>
{recent.length > 0 && (
  <div className="mt-4">
    <div className="flex items-center justify-between mb-1">
  <span className="text-sm font-semibold text-slate-700">Recent searches</span>
  <button
    type="button"
    className="text-xs text-rose-600 hover:text-rose-800"
    onClick={() => {
      setRecent([]);
      localStorage.removeItem("recentPlaces");
    }}
  >
    Clear
  </button>
</div>

    <div className="flex flex-wrap gap-2">
      {recent.map((r, i) => (
        <button
          key={i}
          className="px-3 py-1 rounded-lg text-sm bg-slate-600 text-white hover:bg-slate-700"

          onClick={() => onPickPlace(r)}
        >
          {r.label}
        </button>
      ))}
    </div>
  </div>
)}        


        <div className="mt-6 grid gap-2">
          {tips.map((t, i) => (
            <div key={i} className="text-sm text-slate-600 flex items-start gap-2">
              <span className="text-orange-500">•</span> {t}
            </div>
          ))}
        </div>

        {error && (
          <div className="mt-6 bg-rose-50 border border-rose-200 text-rose-700 p-4 rounded-xl shadow">
            {error}
          </div>
        )}

        {/* DID-YOU-MEAN candidates */}
        {candidates.length > 1 && (
          <div className="mt-6 bg-white/90 backdrop-blur p-6 rounded-2xl shadow grid gap-3">
            <div className="font-bold text-slate-700">Did you mean…</div>
            <div className="grid gap-2">
              {candidates.map((c, i) => (
                <button
                  key={`${c.label}-${i}`}
                  className="text-left w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 hover:bg-slate-50"
                  onClick={() => onPickPlace(c)}
                >
                  <div className="font-medium">{c.label}</div>
                  <div className="text-xs text-slate-500">
                    Lat {c.lat.toFixed(4)}, Lon {c.lon.toFixed(4)} · TZ {c.tz}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* LOCATION */}
        {place && (
          <div className="mt-8 bg-white/90 backdrop-blur p-5 rounded-2xl shadow grid gap-2">
            <div className="font-bold text-slate-700">📍 Location</div>
            <div className="text-slate-800 text-lg">{place.label}</div>
            <div className="text-slate-600 text-sm">Lat {place.lat.toFixed(4)}, Lon {place.lon.toFixed(4)}</div>
            <div className="text-slate-600 text-sm">Timezone: {place.tz}</div>
          </div>
        )}

        {/* RESULTS — under Location, above Weather */}
        {result && (
          <div className="mt-6 bg-white/90 backdrop-blur p-6 rounded-2xl shadow grid gap-3">
            <div className="font-bold text-lg text-slate-700">Results for {dateStr}</div>

            {result.ok ? (
              <div className="grid gap-4 text-slate-800">
                {/* Sun Times */}
                <div>
                  <div className="text-lg font-semibold text-slate-700 mb-1">🌞 Sun Times</div>
                  <div>🌄 Sunrise: <strong>{fmtTime(result.sunrise, place?.tz)}</strong></div>
                  <div>☀️ Solar noon: <strong>{fmtTime(result.solarNoon, place?.tz)}</strong></div>
                  <div>🌇 Sunset: <strong>{fmtTime(result.sunset, place?.tz)}</strong></div>
                </div>

                <hr className="my-2 border-slate-200" />

                {/* Shoot Times */}
                <div>
                  <div className="text-xl font-bold text-slate-800 mb-2">📸 Shoot Times</div>
                  <div className="text-slate-700">End your <strong>MORNING</strong> shoot by:</div>
                  <div>⏰ {result.angleDeg}° after sunrise: <strong>{fmtTime(result.morningAt, place?.tz)}</strong></div>
                  <div className="text-slate-700 mt-2">Start your <strong>EVENING</strong> shoot by:</div>
                  <div>⏰ {result.angleDeg}° before sunset: <strong>{fmtTime(result.eveningAt, place?.tz)}</strong></div>
                  <p className="text-sm text-slate-600 mt-2 italic">
                    Tip: Portraits often look best when the Sun sits low in the sky.
                  </p>
                </div>
              </div>
            ) : (
              <div className="text-amber-800">
                {result.message}
                <div className="mt-2 text-slate-700">
                  Sunrise: <strong>{fmtTime(result.sunrise, place?.tz)}</strong> · Sunset: <strong>{fmtTime(result.sunset, place?.tz)}</strong>
                </div>
              </div>
            )}
          </div>
        )}

        {/* WEATHER */}
        {weather && (
          <div className="mt-6 bg-white/90 backdrop-blur p-6 rounded-2xl shadow grid gap-2">
            <div className="font-bold text-slate-700">🌤️ Weather for {weather.when}</div>
            <div className="text-slate-800 flex items-center gap-2">
              <span className="text-2xl">{weatherCodeInfo(weather.code).emoji}</span>
              <span>{weatherCodeInfo(weather.code).text}</span>
            </div>
            <div className="text-slate-700">
              High / Low:{" "}
              <strong>{Math.round(weather.tmaxC * 9/5 + 32)}°F</strong> /{" "}
              <strong>{Math.round(weather.tminC * 9/5 + 32)}°F</strong>{" "}
              <span className="text-slate-500">( {Math.round(weather.tmaxC)}°C / {Math.round(weather.tminC)}°C )</span>
            </div>
            <div className="text-slate-700">
              Precipitation: <strong>{(weather.precipMm ?? 0).toFixed(1)} mm</strong>
            </div>
            <div className="text-slate-700">
              Cloud cover: <strong>{Math.round(weather.cloudsPct)}%</strong>
            </div>
          </div>
        )}

        {/* CLOUD CHART */}
        {hourly && result && (
          <CloudChart
            hourly={hourly}
            tz={place?.tz}
            morningAt={result.morningAt}
            eveningAt={result.eveningAt}
          />
        )}

        <footer className="mt-10 text-xs text-slate-500 text-center">
          Built with React + SunCalc + Open-Meteo Geocoding & Forecast.
        </footer>
      </div>
    </div>
  );
}
