// Jericho Wind Monitor — Cloudflare Worker
// Serves: HTML frontend (GET /), API (GET /api/*), Cron (scheduled)
// Binding: D1 database as "DB"
// Cron: */1 * * * *

const WEATHERLINK_URL = 'https://www.weatherlink.com/embeddablePage/getData/e25c3f542d98439b8acd3bcc217068ce';
const JSCA_TXT_URL = 'https://jsca.bc.ca/main/downld02.txt';
const PURGE_DAYS = 60;
const WORKER_SCRIPT_NAME = 'jerico-wind';

const FREE_PLAN_QUOTAS = {
  workersRequestsPerDay: 100000,
  d1RowsReadPerDay: 5000000,
};

async function handleScheduled(event, env) {
  await handleWeatherLinkScheduled(env);

  const minute = new Date().getUTCMinutes();
  if (minute === 2 || minute === 32) {
    await handleJscScheduled(env);
  }
}

// --- Cron Handler: fetch WeatherLink, store in D1 ---
async function handleWeatherLinkScheduled(env) {
  const resp = await fetch(WEATHERLINK_URL, {
    headers: { 'User-Agent': 'JerichoWindMonitor/1.0' },
  });
  if (!resp.ok) return;

  const data = await resp.json();
  const rawTime = data.lastReceived;
  if (!rawTime) return;
  // WeatherLink returns milliseconds — convert to seconds for consistent storage
  const stationTime = rawTime > 9999999999 ? Math.floor(rawTime / 1000) : rawTime;

  const gustAt = data.gustAt ? (data.gustAt > 9999999999 ? Math.floor(data.gustAt / 1000) : data.gustAt) : null;
  const parsedGust = parseFloat(data.gust);
  const isCurrentGust = gustAt != null && Math.abs(gustAt - stationTime) < 30;
  const windGust = isCurrentGust && Number.isFinite(parsedGust) ? parsedGust : null;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO readings (station_time, captured_at, wind_speed, wind_gust, wind_direction, temperature, barometer, gust_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    stationTime,
    Math.floor(Date.now() / 1000),
    parseFloat(data.wind) || 0,
    windGust,
    data.windDirection != null ? data.windDirection : null,
    parseFloat(data.temperature) || null,
    parseFloat(data.barometer) || null,
    null
  ).run();

  // Purge old data
  const cutoff = Math.floor(Date.now() / 1000) - PURGE_DAYS * 86400;
  await env.DB.prepare('DELETE FROM readings WHERE station_time < ?').bind(cutoff).run();
}

async function handleJscScheduled(env) {
  const txtResp = await fetch(JSCA_TXT_URL, {
    headers: { 'User-Agent': 'JerichoWindMonitor/1.0' },
  });
  if (!txtResp.ok) return;

  const readings = parseJscReadings(await txtResp.text());
  if (!readings.length) return;

//  const latest = readings[readings.length - 1];
//   await env.DB.prepare(
//     `INSERT OR IGNORE INTO jsc_readings (station_time, wind_speed, wind_gust, wind_direction, gust_direction, temperature, rain_rate)
//      VALUES (?, ?, ?, ?, ?, ?, ?)`
//   ).bind(
//     latest.station_time,
//     latest.wind_speed,
//     latest.wind_gust,
//     latest.wind_direction,
//     latest.gust_direction,
//     latest.temperature,
//     latest.rain_rate
//   ).run();

    await env.DB.batch(readings.map((reading) => env.DB.prepare(
    `INSERT OR IGNORE INTO jsc_readings (station_time, wind_speed, wind_gust, wind_direction, gust_direction, temperature, rain_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    reading.station_time,
    reading.wind_speed,
    reading.wind_gust,
    reading.wind_direction,
    reading.gust_direction,
    reading.temperature,
    reading.rain_rate
  )));
}

// --- API Handler ---
async function handleAPI(request, env, ctx) {
  const url = new URL(request.url);

  let response;

  if (url.pathname === '/api/readings') {
    let since, until;
    if (url.searchParams.has('min') && url.searchParams.has('max')) {
      since = parseInt(url.searchParams.get('min'), 10);
      until = parseInt(url.searchParams.get('max'), 10);
      const oldest = Math.floor(Date.now() / 1000) - PURGE_DAYS * 86400;
      if (since < oldest) since = oldest;
    } else {
      const hours = Math.min(Math.max(parseInt(url.searchParams.get('hours') || '1', 10), 1), PURGE_DAYS * 24);
      since = Math.floor(Date.now() / 1000) - hours * 3600;
      until = Math.floor(Date.now() / 1000);
    }

    const { results } = await env.DB.prepare(
      'SELECT station_time, wind_speed, wind_direction, wind_gust, temperature FROM readings WHERE station_time > ? AND station_time <= ? ORDER BY station_time ASC'
    ).bind(since, until).all();

    response = jsonResponse(url.searchParams.get('summary') === '30' ? summarizeReadings(results, 1800) : results);

  } else if (url.pathname === '/api/jsca-txt') {
    let since, until;
    if (url.searchParams.has('min') && url.searchParams.has('max')) {
      since = parseInt(url.searchParams.get('min'), 10);
      until = parseInt(url.searchParams.get('max'), 10);
      const oldest = Math.floor(Date.now() / 1000) - PURGE_DAYS * 86400;
      if (since < oldest) since = oldest;
    } else {
      const hours = Math.min(Math.max(parseInt(url.searchParams.get('hours') || '6', 10), 1), PURGE_DAYS * 24);
      since = Math.floor(Date.now() / 1000) - hours * 3600;
      until = Math.floor(Date.now() / 1000);
    }

    // Serve from the live 2-day text dump first. It's only a rolling window,
    // so for anything older we fall back to the D1 archive that the cron job
    // has been building from the same source.
    const txtResp = await fetch(JSCA_TXT_URL, {
      headers: { 'User-Agent': 'JerichoWindMonitor/1.0' },
    });
    const txtReadings = txtResp.ok
      ? parseJscReadings(await txtResp.text()).filter((r) => r.station_time > since && r.station_time <= until)
      : [];

    const earliestTxt = txtReadings.length ? txtReadings[0].station_time : until;
    let combined = txtReadings;
    if (earliestTxt > since) {
      const { results } = await env.DB.prepare(
        'SELECT station_time, wind_speed, wind_direction, wind_gust, gust_direction, temperature, rain_rate FROM jsc_readings WHERE station_time > ? AND station_time < ? ORDER BY station_time ASC'
      ).bind(since, earliestTxt).all();
      combined = results.concat(txtReadings);
    }

    response = jsonResponse(combined);

  } else if (url.pathname === '/api/current') {
    const { results } = await env.DB.prepare(
      'SELECT station_time, wind_speed, wind_direction, temperature, barometer FROM readings ORDER BY station_time DESC LIMIT 1'
    ).all();

    response = jsonResponse(results[0] || null);

  } else if (url.pathname === '/api/tides') {
    const tide = await fetchTideData(ctx);
    response = tide ? jsonResponse(tide) : jsonResponse({ error: 'Tide data unavailable' }, 502);

  } else if (url.pathname === '/api/usage') {
    const usage = await fetchUsageFromGraphQL(env);
    response = usage ? jsonResponse(usage) : jsonResponse({ error: 'Usage data unavailable' }, 502);

  } else {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  return response;
}

// Point Atkinson (CHS station code 07795) — reference tide station for
// English Bay / Jericho. Free, official Canadian Hydrographic Service data.
const TIDE_STATION_ID = '5cebf1de3d0f4a073c4bb94c';
const TIDE_API_BASE = 'https://api-iwls.dfo-mpo.gc.ca/api/v1/stations';

async function fetchTideSeries(code, fromDate, toDate, resolution) {
  let url = `${TIDE_API_BASE}/${TIDE_STATION_ID}/data?time-series-code=${code}` +
    `&from=${fromDate.toISOString()}&to=${toDate.toISOString()}`;
  if (resolution) url += `&resolution=${resolution}`;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) return [];
  try {
    return await resp.json();
  } catch (e) {
    return [];
  }
}

// Fetches the prediction curve directly, no caching.
async function fetchTideCurve(now, ctx) {
  const curveFrom = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const curveTo = new Date(now.getTime() + 42 * 60 * 60 * 1000);
  const curveData = await fetchTideSeries('wlp', curveFrom, curveTo, 'FIFTEEN_MINUTES');
  return curveData.map((pt) => ({ time: pt.eventDate, height: pt.value }));
}

async function fetchTideData(ctx) {
  const now = new Date();
  const from = new Date(now.getTime() - 60 * 60 * 1000);
  const to = new Date(now.getTime() + 15 * 60 * 1000);

  // Prefer observed water level; fall back to predicted if the gauge is
  // temporarily offline (observations lag the request time by a few minutes).
  let series = 'wlo';
  let data = await fetchTideSeries('wlo', from, to, 'FIFTEEN_MINUTES');
  if (!data.length) {
    series = 'wlp';
    data = await fetchTideSeries('wlp', from, to, 'FIFTEEN_MINUTES');
  }
  if (!data.length) return null;

  const latest = data[data.length - 1];
  const prev = data.length > 1 ? data[data.length - 2] : null;
  let trend = 'steady';
  if (prev) {
    if (latest.value > prev.value + 0.01) trend = 'rising';
    else if (latest.value < prev.value - 0.01) trend = 'falling';
  }

  // Next low/high, from the official tide table predictions. Point Atkinson
  // has a mixed semidiurnal tide, so the gap between events isn't a clean
  // 12.4h — +15h forward comfortably covers even irregular spacing,
  // guaranteeing the next low and next high are both caught. No back-window
  // needed: the classifier below handles the first returned event by
  // comparing it forward to the next one, not backward.
  const hiloFrom = now;
  const hiloTo = new Date(now.getTime() + 15 * 60 * 60 * 1000);
  const hiloData = await fetchTideSeries('wlp-hilo', hiloFrom, hiloTo, null);

  const classified = hiloData.map((pt, i, arr) => {
    let type;
    if (i === 0) {
      type = arr.length > 1 && pt.value > arr[1].value ? 'high' : 'low';
    } else {
      type = pt.value > arr[i - 1].value ? 'high' : 'low';
    }
    return { time: pt.eventDate, height: pt.value, type };
  });

  const nowMs = now.getTime();
  let previousEvent = null, nextEvent = null;
  for (const evt of classified) {
    const t = new Date(evt.time).getTime();
    if (t <= nowMs) previousEvent = evt;
    else if (!nextEvent) { nextEvent = evt; break; }
  }
  const nextLow = classified.find(e => e.type === 'low' && new Date(e.time).getTime() > nowMs) || null;
  const nextHigh = classified.find(e => e.type === 'high' && new Date(e.time).getTime() > nowMs) || null;

  // Wider prediction curve for the graph: 6 hours back, 42 hours ahead.
  const curveData = await fetchTideCurve(now, ctx);
  const curveFromMs = now.getTime() - 6 * 60 * 60 * 1000;
  const curveToMs = now.getTime() + 42 * 60 * 60 * 1000;
  const predictions = curveData.filter((p) => {
    const t = new Date(p.time).getTime();
    return t >= curveFromMs && t <= curveToMs;
  });

  return {
    height: latest.value,
    trend: trend,
    time: latest.eventDate,
    source: series,
    station: 'Point Atkinson',
    previousEvent: previousEvent,
    nextEvent: nextEvent,
    nextLow: nextLow,
    nextHigh: nextHigh,
    events: classified,
    predictions: predictions,
  };
}

// --- Free-plan usage stats (Workers requests + D1 rows read, today) ---
async function fetchUsageFromGraphQL(env) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10); // UTC date, matches Cloudflare's daily reset
  const dayStartUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dtStart = dayStartUTC.toISOString();
  const dtEnd = now.toISOString();

  const query = `
    query UsageToday($accountTag: string!, $day: Date!, $dtStart: string!, $dtEnd: string!, $scriptName: string!, $databaseId: string!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workers: workersInvocationsAdaptive(
            filter: { scriptName: $scriptName, datetime_geq: $dtStart, datetime_leq: $dtEnd }
            limit: 10000
          ) {
            sum { requests }
          }
          d1: d1AnalyticsAdaptiveGroups(
            filter: { date_geq: $day, date_leq: $day, databaseId: $databaseId }
            limit: 10
          ) {
            sum { rowsRead }
          }
        }
      }
    }`;

  const resp = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: env.ACCOUNT_ID,
        day: today,
        dtStart,
        dtEnd,
        scriptName: WORKER_SCRIPT_NAME,
        databaseId: env.D1_DATABASE_ID,
      },
    }),
  });

  if (!resp.ok) {
    console.error('GraphQL usage request failed:', resp.status, await resp.text());
    return null;
  }
  const json = await resp.json();
  if (json.errors && json.errors.length) {
    console.error('GraphQL usage query errors:', JSON.stringify(json.errors));
    return null;
  }

  const account = json.data && json.data.viewer && json.data.viewer.accounts && json.data.viewer.accounts[0];
  const workersRows = (account && account.workers) || [];
  const d1Rows = (account && account.d1) || [];
  const requests = workersRows.reduce((sum, r) => sum + ((r.sum && r.sum.requests) || 0), 0);
  const rowsRead = d1Rows.reduce((sum, r) => sum + ((r.sum && r.sum.rowsRead) || 0), 0);

  return {
    date: today,
    workersRequests: requests,
    d1RowsRead: rowsRead,
    quotas: FREE_PLAN_QUOTAS,
  };
}

function parseJscReadings(txt) {
  const readings = [];
  const lines = txt.split('\n');

  for (const line of lines) {
    const m = line.match(/^\s*(\d{1,2}\/\d{1,2}\/\d{2})\s+(\d{1,2}:\d{2}[ap])\s+/);
    if (!m) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 16) continue;

    const dp = parts[0].split('/');
    const year = 2000 + parseInt(dp[2]);
    const month = parseInt(dp[0]) - 1;
    const day = parseInt(dp[1]);

    const tm = parts[1].match(/(\d{1,2}):(\d{2})([ap])/);
    if (!tm) continue;
    let hour = parseInt(tm[1]);
    const min = parseInt(tm[2]);
    const ampm = tm[3];
    if (ampm === 'p' && hour !== 12) hour += 12;
    if (ampm === 'a' && hour === 12) hour = 0;

    // txt times are PDT (UTC-7), construct UTC timestamp
    const dt = new Date(Date.UTC(year, month, day, hour + 7, min));
    const temperature = parseFloat(parts[2]);

    const rainRate = parseFloat(parts[17]);

    readings.push({
      station_time: Math.floor(dt.getTime() / 1000),
      wind_speed: parseFloat(parts[7]) || 0,
      wind_gust: parseFloat(parts[10]) || 0,
      wind_direction: compassToDeg(parts[8]),
      gust_direction: compassToDeg(parts[11]),
      temperature: Number.isFinite(temperature) ? temperature : null,
      rain_rate: Number.isFinite(rainRate) ? rainRate : null,
    });
  }

  return readings;
}

function compassToDeg(compass) {
  const map = {N:0,NNE:22,NE:45,ENE:67,E:90,ESE:112,SE:135,SSE:157,S:180,SSW:202,SW:225,WSW:247,W:270,WNW:292,NW:315,NNW:337};
  return map[compass] != null ? map[compass] : null;
}

function summarizeReadings(readings, bucketSeconds) {
  const buckets = new Map();

  for (const reading of readings) {
    const windSpeed = Number(reading.wind_speed);
    if (!Number.isFinite(windSpeed)) continue;

    const bucketStart = Math.floor(reading.station_time / bucketSeconds) * bucketSeconds;
    let bucket = buckets.get(bucketStart);
    if (!bucket) {
      bucket = {
        count: 0,
        lastTime: reading.station_time,
        windSum: 0,
        tempSum: 0,
        tempCount: 0,
        dirSin: 0,
        dirCos: 0,
        dirCount: 0,
        maxWind: -Infinity,
        maxWindDirection: null,
      };
      buckets.set(bucketStart, bucket);
    }

    bucket.count += 1;
    bucket.lastTime = Math.max(bucket.lastTime, reading.station_time);
    bucket.windSum += windSpeed;

    const temperature = Number(reading.temperature);
    if (Number.isFinite(temperature)) {
      bucket.tempSum += temperature;
      bucket.tempCount += 1;
    }

    const direction = Number(reading.wind_direction);
    if (Number.isFinite(direction)) {
      const radians = direction * Math.PI / 180;
      bucket.dirSin += Math.sin(radians);
      bucket.dirCos += Math.cos(radians);
      bucket.dirCount += 1;
    }

    const gust = reading.wind_gust != null ? Number(reading.wind_gust) : null;
    const maxCandidate = Number.isFinite(gust) ? Math.max(windSpeed, gust) : windSpeed;
    if (maxCandidate > bucket.maxWind) {
      bucket.maxWind = maxCandidate;
      bucket.maxWindDirection = Number.isFinite(direction) ? direction : null;
    }
  }

  return Array.from(buckets.entries()).map(([bucketStart, bucket]) => {
    const avgDirection = bucket.dirCount
      ? Math.round((Math.atan2(bucket.dirSin, bucket.dirCos) * 180 / Math.PI + 360) % 360)
      : null;

    return {
      station_time: bucket.lastTime || bucketStart,
      wind_speed: bucket.windSum / bucket.count,
      wind_gust: bucket.maxWind,
      wind_direction: avgDirection,
      gust_direction: bucket.maxWindDirection,
      temperature: bucket.tempCount ? bucket.tempSum / bucket.tempCount : null,
    };
  }).sort((a, b) => a.station_time - b.station_time);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
  });
}

// --- Fetch Handler (routes) ---
async function handleFetch(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) {
    return handleAPI(request, env, ctx);
  }

  // Serve frontend HTML at root
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return new Response(HTML_PAGE, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  return new Response('Not found', { status: 404 });
}

export default {
  fetch: handleFetch,
  scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};

// --- Embedded Frontend HTML ---
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Jericho Wind Monitor</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%9B%B5%3C/text%3E%3C/svg%3E" type="image/svg+xml">
    <link rel="icon" href="https://fonts.gstatic.com/s/e/notoemoji/latest/26f5/512.png" type="image/png">
    <link rel="apple-touch-icon" href="https://fonts.gstatic.com/s/e/notoemoji/latest/26f5/512.png">    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"><\/script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"><\/script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f1923;
            color: #e0e0e0;
            min-height: 100vh;
            padding: 20px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            flex-wrap: wrap;
            gap: 10px;
        }
        h1 { font-size: 1.6rem; color: #4fc3f7; }
        .status { font-size: 0.85rem; color: #888; }
        .status .live { color: #4caf50; }
        .status .error { color: #f44336; }
        .current-conditions {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 15px;
            margin-bottom: 25px;
        }
        .card {
            background: #1a2733;
            border-radius: 10px;
            padding: 18px;
            text-align: center;
            border: 1px solid #2a3f50;
        }
        .card .label {
            font-size: 0.75rem;
            color: #78909c;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 6px;
        }
        .card .value { font-size: 2rem; font-weight: 700; color: #fff; }
        .card .unit { font-size: 0.85rem; color: #78909c; margin-left: 3px; }
        .card.wind .value { color: #4fc3f7; }
        .card.gust .value { color: #ff7043; }
        .card.direction .value { color: #aed581; font-size: 1.6rem; }
        .chart-container {
            background: #1a2733;
            border-radius: 10px;
            padding: 20px;
            border: 1px solid #2a3f50;
            margin-bottom: 20px;
        }
        .chart-container h2 { font-size: 1rem; color: #90a4ae; margin-bottom: 15px; }
        .chart-wrapper { position: relative; height: 280px; }
        .controls { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
        .controls button {
            background: #1a2733;
            border: 1px solid #2a3f50;
            color: #e0e0e0;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.85rem;
            transition: all 0.2s;
        }
        .controls button:hover { border-color: #4fc3f7; color: #4fc3f7; }
        .controls button.active { background: #4fc3f7; color: #0f1923; border-color: #4fc3f7; font-weight: 600; }
        .source-selector {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            margin-left: 10px;
            padding: 3px;
            background: #1a2733;
            border: 1px solid #2a3f50;
            border-radius: 999px;
        }
        .source-selector label { cursor: pointer; }
        .source-selector input {
            position: absolute;
            opacity: 0;
            pointer-events: none;
        }
        .source-selector span {
            display: block;
            padding: 6px 12px;
            border-radius: 999px;
            color: #90a4ae;
            font-size: 0.8rem;
            transition: all 0.2s;
            user-select: none;
        }
        .source-selector label:hover span { color: #4fc3f7; }
        .source-selector input:checked + span {
            background: #4fc3f7;
            color: #0f1923;
            font-weight: 600;
        }
        .data-info { font-size: 0.75rem; color: #546e7a; text-align: left; margin-top: 15px; }
        .data-info a { color: #4fc3f7; text-decoration: none; }
        .data-info a:hover { text-decoration: underline; }

        .tide-section {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #1e2d3a;
        }
        .accordion-header {
            cursor: pointer;
            user-select: none;
        }
        .accordion-icon {
            display: inline-block;
            margin-left: 6px;
            transition: transform 0.15s ease;
        }
        .accordion-header.expanded .accordion-icon {
            transform: rotate(90deg);
        }
        .tide-section h2 {
            font-size: 1rem;
            color: #4fc3f7;
            margin: 0 0 15px;
            font-weight: 600;
        }
        .tide-summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 12px;
            margin-bottom: 18px;
        }
        .tide-stat {
            background: #16222d;
            border: 1px solid #22303c;
            border-radius: 10px;
            padding: 12px 14px;
        }
        .tide-stat .label {
            font-size: 0.7rem;
            color: #78909c;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            margin-bottom: 4px;
        }
        .tide-stat .value {
            font-size: 1.3rem;
            font-weight: 600;
            color: #e0e0e0;
        }
        .tide-stat .value .unit { font-size: 0.75rem; color: #78909c; margin-left: 3px; }
        .tide-stat .sub { font-size: 0.72rem; color: #90a4ae; margin-top: 2px; }
        .tide-trend-rising { color: #4fc3f7; }
        .tide-trend-falling { color: #ff7043; }
        .tide-trend-steady { color: #90a4ae; }
        .tide-chart-wrap { position: relative; height: 220px; }
        @media (max-width: 480px) {
            .tide-summary { grid-template-columns: repeat(2, 1fr); }
        }

        .usage-section {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #1e2d3a;
        }
        .usage-section h2 {
            font-size: 1rem;
            color: #4fc3f7;
            margin: 0 0 15px;
            font-weight: 600;
        }
        .usage-summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 12px;
        }
        .usage-stat {
            background: #16222d;
            border: 1px solid #22303c;
            border-radius: 10px;
            padding: 12px 14px;
        }
        .usage-stat .label {
            font-size: 0.7rem;
            color: #78909c;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            margin-bottom: 4px;
        }
        .usage-stat .value {
            font-size: 1.3rem;
            font-weight: 600;
            color: #e0e0e0;
        }
        .usage-stat .sub { font-size: 0.72rem; color: #90a4ae; margin-top: 2px; }
        .usage-bar {
            margin-top: 8px;
            height: 6px;
            border-radius: 3px;
            background: #0f1923;
            overflow: hidden;
        }
        .usage-bar-fill {
            height: 100%;
            border-radius: 3px;
            background: #4fc3f7;
            transition: width 0.3s ease;
        }
        .usage-bar-fill.warn { background: #ffb74d; }
        .usage-bar-fill.danger { background: #ff7043; }

        @media (max-width: 480px) {
            body { padding: 12px; }
            .current-conditions {
                grid-template-columns: repeat(2, 1fr);
                gap: 10px;
            }
            .card { padding: 12px; }
            .card .value { font-size: 1.5rem; }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>&#127754; Jericho Sailing Centre &#8212; Wind Monitor</h1>
        <div class="status">
            <span id="statusIndicator"></span>
            <span id="lastUpdate"></span>
        </div>
    </div>
    <div class="current-conditions">
        <div class="card wind">
            <div class="label">Wind Speed</div>
            <div class="value"><span id="currentWind">--</span><span class="unit">kts</span></div>
        </div>
        <div class="card gust">
            <div class="label">Gust</div>
            <div class="value"><span id="currentGust">--</span><span class="unit">kts</span></div>
        </div>
        <div class="card direction">
            <div class="label">Direction</div>
            <div class="value"><span id="currentDirection">--</span></div>
        </div>
        <div class="card">
            <div class="label">Temperature</div>
            <div class="value"><span id="currentTemp">--</span><span class="unit">&#176;C</span></div>
        </div>
        <!-- <div class="card">
            <div class="label">Barometer</div>
            <div class="value"><span id="currentBaro">--</span><span class="unit">mb</span></div>
        </div> -->
    </div>
    <div class="controls">
        <button data-hours="1" class="active">1 Hour</button>
        <button data-hours="3">3 Hours</button>
        <button data-hours="6">6 Hours</button>
        <button data-hours="12">12 Hours</button>
        <button data-hours="24">24 Hours</button>
        <button data-hours="48">48 Hours</button>
        <button data-hours="168">7 Days</button>
        <button id="customBtn">Custom</button>
        <div id="sourceSelector" class="source-selector" role="radiogroup" aria-label="Data source">
            <label><input type="radio" name="sourceMode" value="jsc" autocomplete="off"><span>jsc</span></label>
            <label><input type="radio" name="sourceMode" value="raw" checked autocomplete="off"><span>raw</span></label>
            <label><input type="radio" name="sourceMode" value="avg" autocomplete="off"><span>avg</span></label>
        </div>
    </div>
    <div id="customRange" style="display:none; margin-bottom:20px; background:#1a2733; border:1px solid #2a3f50; border-radius:10px; padding:15px;">
        <div style="display:flex; gap:15px; flex-wrap:wrap; align-items:center;">
            <label style="color:#90a4ae; font-size:0.85rem;">From: <input type="datetime-local" id="rangeFrom" style="background:#0f1923; color:#e0e0e0; border:1px solid #2a3f50; border-radius:4px; padding:4px 8px;"></label>
            <label style="color:#90a4ae; font-size:0.85rem;">To: <input type="datetime-local" id="rangeTo" style="background:#0f1923; color:#e0e0e0; border:1px solid #2a3f50; border-radius:4px; padding:4px 8px;"></label>
            <button id="customGo" style="background:#4fc3f7; color:#0f1923; border:none; border-radius:6px; padding:8px 16px; cursor:pointer; font-weight:600;">Go</button>
        </div>
    </div>
    <div class="chart-container">
        <h2>Wind Speed &amp; Gust (knots) with Direction Arrows</h2>
        <div class="chart-wrapper"><canvas id="windChart"></canvas></div>
    </div>
    <div class="chart-container">
        <h2>Wind Direction</h2>
        <div class="chart-wrapper"><canvas id="directionChart"></canvas></div>
    </div>
    <!-- 
    // <div class="chart-container">
    //     <h2>7 Day Forecast</h2>
    //     <div class="chart-wrapper"><canvas id="forecastChart"></canvas></div>
    // </div> 
    -->
    <div class="tide-section">
        <h2 class="accordion-header" id="tideHeader">Tide — Point Atkinson<span class="accordion-icon">&#9656;</span></h2>
        <div class="accordion-body" id="tideBody" style="display:none;">
            <div class="tide-summary">
                <div class="tide-stat">
                    <div class="label">Current Height</div>
                    <div class="value"><span id="tideHeight">--</span><span class="unit">m</span></div>
                    <div class="sub"><span id="tideCurrentTime">&nbsp;</span></div>
                </div>
                <div class="tide-stat">
                    <div class="label">Trend</div>
                    <div class="value"><span id="tideTrend">--</span></div>
                </div>
                <div class="tide-stat" id="tideLowCard">
                    <div class="label">Next Low</div>
                    <div class="value"><span id="tideNextLow">--</span></div>
                    <div class="sub"><span id="tideNextLowDate">&nbsp;</span></div>
                </div>
                <div class="tide-stat" id="tideHighCard">
                    <div class="label">Next High</div>
                    <div class="value"><span id="tideNextHigh">--</span></div>
                    <div class="sub"><span id="tideNextHighDate">&nbsp;</span></div>
                </div>
            </div>
            <div class="tide-chart-wrap"><canvas id="tideChart"></canvas></div>
        </div>
    </div>
    <div class="usage-section">
        <h2 class="accordion-header" id="usageHeader">Cloudflare Free Plan Usage — Today (resets 00:00 UTC / <span id="resetTimeLocal"></span> local)<span class="accordion-icon">&#9656;</span></h2>
        <div class="accordion-body" id="usageBody" style="display:none;">
            <div class="usage-summary">
                <div class="usage-stat">
                    <div class="label">Worker Requests</div>
                    <div class="value"><span id="usageRequestsPct">--</span></div>
                    <div class="sub"><span id="usageRequestsCount">--</span></div>
                    <div class="usage-bar"><div class="usage-bar-fill" id="usageRequestsBar" style="width:0%"></div></div>
                </div>
                <div class="usage-stat">
                    <div class="label">D1 Rows Read</div>
                    <div class="value"><span id="usageD1Pct">--</span></div>
                    <div class="sub"><span id="usageD1Count">--</span></div>
                    <div class="usage-bar"><div class="usage-bar-fill" id="usageD1Bar" style="width:0%"></div></div>
                </div>
            </div>
        </div>
    </div>
    <center>
        <div class="data-info">
            Raw (Jericho Sailing Centre — 1-min data): <a href="https://www.weatherlink.com/embeddablePage/getData/e25c3f542d98439b8acd3bcc217068ce" target="_blank" rel="noopener">WeatherLink API</a>.<br>
            Avg is summary of the Raw into 30-minute buckets (max and average).<br>
            JSC (Jericho Sailing Centre 30 min data): <a href="https://jsca.bc.ca/main/downld02.txt" target="_blank" rel="noopener">downld02.txt</a>.<br>
            Tide (Point Atkinson): <a href="https://api-iwls.dfo-mpo.gc.ca/api/v1/stations" target="_blank" rel="noopener">CHS/DFO IWLS API</a>.
        </div>
    </center>
    <script>
    (function() {
        var displayHours = 1;
        var windChart;
        var directionChart;
        var windDirections = [];
        var gustDirections = [];
        var gustPointDirections = [];
        var gustTemperatures = [];
        var gustRainRates = [];

        function drawArrow(ctx, x, y, angle, len, color) {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(angle);
            ctx.beginPath();
            ctx.moveTo(0, -len);
            ctx.lineTo(-4, len * 0.4);
            ctx.lineTo(4, len * 0.4);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();
            ctx.restore();
        }

        function drawRainDrop(ctx, x, y, size, color) {
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(x, y - size);
            ctx.bezierCurveTo(x + size * 0.9, y - size * 0.05, x + size * 0.65, y + size * 0.9, x, y + size * 0.9);
            ctx.bezierCurveTo(x - size * 0.65, y + size * 0.9, x - size * 0.9, y - size * 0.05, x, y - size);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();
            ctx.restore();
        }

        // WMO-style rain-rate bands, assumed mm/hr. Adjust these if the JSCA
        // feed turns out to report in a different unit once real data comes in.
        var RAIN_MODERATE_MM_HR = 2.5;
        var RAIN_HEAVY_MM_HR = 7.6;

        function rainIntensityLevel(rainRate) {
            if (rainRate == null || rainRate <= 0) return 0;
            if (rainRate >= RAIN_HEAVY_MM_HR) return 3;
            if (rainRate >= RAIN_MODERATE_MM_HR) return 2;
            return 1;
        }

        function drawRainDrops(ctx, x, y, count, size, color) {
            var spacing = size * 0.9; // slight overlap between drops
            var startX = x - (spacing * (count - 1)) / 2;
            for (var i = 0; i < count; i++) {
                drawRainDrop(ctx, startX + i * spacing, y, size, color);
            }
        }

        function drawTempLabel(ctx, x, y, text, color) {
            ctx.save();
            ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
            ctx.fillStyle = color;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, x, y);
            ctx.restore();
        }

        // Custom plugin: draw wind direction arrows + gust event arrows
        var arrowPlugin = {
            id: 'windArrows',
            afterDatasetsDraw: function(chart) {
                var ctx = chart.ctx;
                var xScale = chart.scales.x;
                var yScale = chart.scales.y;
                var windData = chart.data.datasets[0].data;
                var gustData = chart.data.datasets[1].data;
                var gustPointData = chart.data.datasets[2].data;
                if (!windData.length) return;

                var chartWidth = xScale.width;
                var minPxBetweenArrows = 24; // arrow width ~24px, so they just touch
                var maxArrows = Math.max(1, Math.floor(chartWidth / minPxBetweenArrows));

                // Green wind direction arrows (spaced by screen width)
                if (windDirections.length) {
                    var step = Math.max(1, Math.floor(windData.length / maxArrows));
                    for (var i = 0; i < windData.length; i += step) {
                        var dir = windDirections[i];
                        if (dir == null) continue;
                        var x = xScale.getPixelForValue(windData[i].x);
                        var y = yScale.getPixelForValue(windData[i].y);
                        var angle = (dir + 180) * Math.PI / 180;
                        drawArrow(ctx, x, y, angle, 12, 'rgba(174,213,129,0.85)');

                        var wSpeed = windData[i].y;
                        if (wSpeed != null) {
                            var wsChartTop = chart.chartArea.top;
                            var wsFlip = (y - 20) < wsChartTop;
                            var wsDir = wsFlip ? 1 : -1;
                            var wsLabelY = y + wsDir * 16;
                            drawTempLabel(ctx, x, wsLabelY, String(Math.round(wSpeed)), 'rgba(197,225,165,0.9)');
                        }
                    }
                }

                // Red gust direction arrows for 30-minute sources.
                if (sourceMode !== 'raw' && gustDirections.length && gustData.length) {
                    var gStep = Math.max(1, Math.floor(gustData.length / maxArrows));
                    for (var j = 0; j < gustData.length; j += gStep) {
                        var gdir = gustDirections[j];
                        if (gdir == null) continue;
                        var gx = xScale.getPixelForValue(gustData[j].x);
                        var gy = yScale.getPixelForValue(gustData[j].y);
                        var gangle = (gdir + 180) * Math.PI / 180;
                        drawArrow(ctx, gx, gy, gangle, 14, 'rgba(255,112,67,0.9)');

                        if (sourceMode === 'jsc' || sourceMode === 'avg') {
                            var gustVal = gustData[j].y;
                            var gRain = gustRainRates[j];
                            var rainLevel = rainIntensityLevel(gRain);
                            var chartTop = chart.chartArea.top;
                            var stackClearance = rainLevel > 0 ? 34 : 28; // approx height the stack needs
                            var flip = (gy - stackClearance) < chartTop;
                            var dir = flip ? 1 : -1; // -1 = draw above the point, 1 = draw below
                            var iconY = gy + dir * 22;
                            if (rainLevel > 0) {
                                drawRainDrops(ctx, gx, iconY + dir * 5, rainLevel, 4, 'rgba(79,195,247,0.9)');
                            }
                            if (gustVal != null) {
                                var valY = rainLevel > 0 ? iconY - dir * 7 : iconY;
                                drawTempLabel(ctx, gx, valY, String(Math.round(gustVal)), 'rgba(224,224,224,0.85)');
                            }
                        }
                    }
                }

                // Red gust arrows for D1 gust points.
                if (sourceMode === 'raw' && gustPointDirections.length && gustPointData.length) {
                    for (var k = 0; k < gustPointData.length; k++) {
                        var pdir = gustPointDirections[k];
                        if (pdir == null) continue;
                        var px = xScale.getPixelForValue(gustPointData[k].x);
                        var py = yScale.getPixelForValue(gustPointData[k].y);
                        var pangle = (pdir + 180) * Math.PI / 180;
                        drawArrow(ctx, px, py, pangle, 14, 'rgba(255,112,67,0.9)');
                    }
                }
            }
        };

        function degreesToCompass(deg) {
            if (deg == null) return '--';
            var dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
            return dirs[Math.round(deg / 22.5) % 16];
        }

        function updateCurrentDisplay(reading) {
            if (!reading) return;
            document.getElementById('currentWind').textContent = reading.wind_speed != null ? reading.wind_speed.toFixed(1) : '--';
            document.getElementById('currentGust').textContent = reading.wind_gust != null ? reading.wind_gust.toFixed(1) : '--';
            document.getElementById('currentDirection').textContent =
                reading.wind_direction != null ? degreesToCompass(reading.wind_direction) + ' (' + reading.wind_direction + '\\u00B0)' : '--';
            document.getElementById('currentTemp').textContent = reading.temperature != null ? reading.temperature.toFixed(1) : '--';
            document.getElementById('lastUpdate').textContent = 'Updated: ' + new Date(reading.station_time * 1000).toLocaleTimeString();
            document.getElementById('statusIndicator').textContent = '\\u25CF ';
            document.getElementById('statusIndicator').className = 'live';
        }

        function showError(msg) {
            document.getElementById('statusIndicator').textContent = '\\u25CF ';
            document.getElementById('statusIndicator').className = 'error';
            document.getElementById('lastUpdate').textContent = msg;
        }

        var customRange = null; // {min, max} in unix seconds
        var sourceMode = 'raw';

        function fetchData() {
            var url;            if (sourceMode === 'jsc') {
                if (customRange) {
                    url = '/api/jsca-txt?min=' + customRange.min + '&max=' + customRange.max;
                } else {
                    url = '/api/jsca-txt?hours=' + displayHours;
                }
            } else if (customRange) {
                url = '/api/readings?min=' + customRange.min + '&max=' + customRange.max;
            } else {
                url = '/api/readings?hours=' + displayHours;
            }
            if (sourceMode === 'avg') {
                url += '&summary=30';
            }
            fetch(url)
                .then(function(resp) {
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    return resp.json();
                })
                .then(function(readings) {
                    if (readings.length > 0) {
                        updateCurrentDisplay(readings[readings.length - 1]);
                    }
                    updateCharts(readings);
                })
                .catch(function(err) {
                    showError('Error: ' + err.message);
                });
        }

        var isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        var tooltipEnabled = !isMobile;

        function formatTideTime(iso) {
            var d = new Date(iso);
            return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        }

        function formatTideDate(iso) {
            var d = new Date(iso);
            return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        }

        var tideChart;
        // var forecastChart;

        // function fetchForecastData() {
        //     var url = 'https://api.open-meteo.com/v1/forecast?latitude=49.2497&longitude=-123.1193&hourly=wind_speed_80m,wind_gusts_10m,wind_direction_80m,temperature_2m,precipitation_probability,precipitation&timezone=America%2FLos_Angeles&wind_speed_unit=kn';
        //     fetch(url)
        //         .then(function(resp) {
        //             if (!resp.ok) throw new Error('HTTP ' + resp.status);
        //             return resp.json();
        //         })
        //         .then(renderForecastChart)
        //         .catch(function(err) {
        //             console.error('Forecast fetch failed:', err.message);
        //         });
        // }

        // var forecastDirections = [];
        // var forecastTemps = [];
        // var forecastPrecip = [];

        // var forecastIconsPlugin = {
        //     id: 'forecastIcons',
        //     afterDatasetsDraw: function(chart) {
        //         var ctx = chart.ctx;
        //         var xScale = chart.scales.x;
        //         var yScale = chart.scales.y;
        //         var windPts = chart.data.datasets[0].data;
        //         if (!windPts.length) return;

        //         var maxArrows = Math.max(1, Math.floor(xScale.width / 24));
        //         var step = Math.max(1, Math.floor(windPts.length / maxArrows));

        //         for (var i = 0; i < windPts.length; i += step) {
        //             var dir = forecastDirections[i];
        //             if (dir == null) continue;
        //             var x = xScale.getPixelForValue(windPts[i].x);
        //             var y = yScale.getPixelForValue(windPts[i].y);
        //             drawArrow(ctx, x, y, (dir + 180) * Math.PI / 180, 12, 'rgba(174,213,129,0.85)');

        //             var temp = forecastTemps[i];
        //             var rainLevel = rainIntensityLevel(forecastPrecip[i]);
        //             var flip = (y - (rainLevel > 0 ? 34 : 28)) < chart.chartArea.top;
        //             var fdir = flip ? 1 : -1;
        //             var iconY = y + fdir * 22;
        //             if (rainLevel > 0) {
        //                 drawRainDrops(ctx, x, iconY + fdir * 5, rainLevel, 4, 'rgba(79,195,247,0.9)');
        //             }
        //             if (temp != null) {
        //                 var tY = rainLevel > 0 ? iconY - fdir * 7 : iconY;
        //                 drawTempLabel(ctx, x, tY, Math.round(temp) + '\u00B0', 'rgba(224,224,224,0.85)');
        //             }
        //         }
        //     },
        // };

        // function renderForecastChart(data) {
        //     var canvas = document.getElementById('forecastChart');
        //     if (!canvas || !data.hourly) return;

        //     var times = data.hourly.time.map(function(t) { return new Date(t).getTime(); });
        //     var toXY = function(arr) { return times.map(function(t, i) { return { x: t, y: arr[i] }; }); };
        //     forecastDirections = data.hourly.wind_direction_80m;
        //     forecastTemps = data.hourly.temperature_2m;
        //     forecastPrecip = data.hourly.precipitation;

        //     if (forecastChart) forecastChart.destroy();
        //     forecastChart = new Chart(canvas, {
        //         data: {
        //             datasets: [
        //                 { 
        //                     type: 'line', 
        //                     label: 'Wind Speed',
        //                     borderColor: '#4fc3f7',
        //                     backgroundColor: 'rgba(79,195,247,0.1)',
        //                     fill: true,
        //                     tension: 0.1,
        //                     data: toXY(data.hourly.wind_speed_80m), 
        //                     yAxisID: 'y', 
        //                     pointRadius: 0, 
        //                     borderWidth: 2, 
        //                 },
        //                 { 
        //                     type: 'line', 
        //                     label: 'Gust', 
        //                     borderColor: '#ff7043', 
        //                     backgroundColor: 'rgba(255,112,67,0.05)',
        //                     fill: true,
        //                     tension: 0.1,
        //                     data: toXY(data.hourly.wind_gusts_10m), 
        //                     yAxisID: 'y', 
        //                     pointRadius: 0, 
        //                     borderWidth: 1.5, 
        //                     borderDash: [4, 3]
        //                 },
        //             ],
        //         },
        //         options: {
        //             responsive: true,
        //             maintainAspectRatio: false,
        //             interaction: { mode: 'index', intersect: false },
        //             plugins: {
        //                 legend: { labels: { color: '#90a4ae' } },
        //                 tooltip: { enabled: tooltipEnabled },
        //             },
        //             scales: {
        //                 x: {
        //                     type: 'time',
        //                     time: { tooltipFormat: 'yyyy-MM-dd HH:mm:ss', displayFormats: { minute: 'HH:mm', hour: 'HH:mm', day: 'MMM d' } },
        //                     grid: { color: 'rgba(255,255,255,0.05)' },
        //                     ticks: {
        //                         color: '#78909c', maxTicksLimit: 12,
        //                         callback: function(value, index, ticks) {
        //                             var d = new Date(ticks[index].value);
        //                             var timeStr = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
        //                             var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        //                             return [timeStr, months[d.getMonth()] + ' ' + d.getDate()];
        //                         }
        //                     }
        //                 },
        //                 y: { position: 'left', grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#78909c', callback: function(v) { return v + 'kn'; } } },
        //             },
        //         },
        //         plugins: [forecastIconsPlugin],
        //     });
        // }

        function renderTideChart(tide) {
            var canvas = document.getElementById('tideChart');
            if (!canvas || !tide.predictions || !tide.predictions.length) return;

            var curvePoints = tide.predictions.map(function(p) {
                return { x: new Date(p.time).getTime(), y: p.height };
            });

            var nowPoint = [{ x: Date.now(), y: tide.height }];

            if (tideChart) tideChart.destroy();
            tideChart = new Chart(canvas, {
                type: 'line',
                data: {
                    datasets: [
                        {
                            label: 'Predicted height',
                            data: curvePoints,
                            borderColor: 'rgba(79,195,247,0.9)',
                            backgroundColor: 'rgba(79,195,247,0.08)',
                            borderWidth: 2,
                            pointRadius: 0,
                            fill: true,
                            tension: 0.4,
                        },
                        {
                            label: 'Now',
                            data: nowPoint,
                            type: 'scatter',
                            pointRadius: 5,
                            pointBackgroundColor: 'rgba(255,112,67,0.95)',
                            pointBorderColor: '#0f1923',
                            pointBorderWidth: 1.5,
                            showLine: false,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'nearest', intersect: false },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            enabled: tooltipEnabled,
                            callbacks: {
                                title: function(items) {
                                    return new Date(items[0].parsed.x).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
                                },
                                label: function(item) {
                                    return item.parsed.y.toFixed(1) + ' m';
                                },
                            },
                        },
                    },
                    scales: {
                        x: {
                            type: 'time',
                            time: { tooltipFormat: 'yyyy-MM-dd HH:mm:ss', displayFormats: { minute: 'HH:mm', hour: 'HH:mm', day: 'MMM d' } },
                            grid: { color: 'rgba(255,255,255,0.05)' },
                            ticks: {
                                color: '#78909c', maxTicksLimit: 12,
                                callback: function(value, index, ticks) {
                                    var d = new Date(ticks[index].value);
                                    var timeStr = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
                                    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                                    return [timeStr, months[d.getMonth()] + ' ' + d.getDate()];
                                }
                            }
                        },
                        y: {
                            grid: { color: 'rgba(255,255,255,0.05)' },
                            ticks: { color: '#78909c', callback: function(v) { return v + 'm'; } },
                        },
                    },
                },
            });
        }

        var lastTide = null;

        function renderTideStats(tide) {
            document.getElementById('tideHeight').textContent = tide.height.toFixed(1);
            document.getElementById('tideCurrentTime').textContent = formatTideTime(new Date().toISOString());

            var trendEl = document.getElementById('tideTrend');
            trendEl.classList.remove('tide-trend-rising', 'tide-trend-falling', 'tide-trend-steady');
            if (tide.trend === 'rising') {
                trendEl.textContent = 'Rising \u2191';
                trendEl.classList.add('tide-trend-rising');
            } else if (tide.trend === 'falling') {
                trendEl.textContent = 'Falling \u2193';
                trendEl.classList.add('tide-trend-falling');
            } else {
                trendEl.textContent = 'Steady \u2192';
                trendEl.classList.add('tide-trend-steady');
            }

            if (tide.nextLow) {
                document.getElementById('tideNextLow').textContent = formatTideTime(tide.nextLow.time) + ' (' + tide.nextLow.height.toFixed(1) + 'm)';
                document.getElementById('tideNextLowDate').textContent = formatTideDate(tide.nextLow.time);
            }
            if (tide.nextHigh) {
                document.getElementById('tideNextHigh').textContent = formatTideTime(tide.nextHigh.time) + ' (' + tide.nextHigh.height.toFixed(1) + 'm)';
                document.getElementById('tideNextHighDate').textContent = formatTideDate(tide.nextHigh.time);
            }

            var lowCard = document.getElementById('tideLowCard');
            var highCard = document.getElementById('tideHighCard');
            if (tide.nextLow && tide.nextHigh && lowCard && highCard) {
                var lowTime = new Date(tide.nextLow.time).getTime();
                var highTime = new Date(tide.nextHigh.time).getTime();
                if (highTime < lowTime) {
                    highCard.parentNode.insertBefore(highCard, lowCard);
                } else {
                    highCard.parentNode.insertBefore(lowCard, highCard);
                }
            }
        }

        function fetchTideData() {
            fetch('/api/tides')
              .then(function(resp) {
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    return resp.json();
                })
                .then(function(tide) {
                    if (!tide || tide.height == null) return;
                    lastTide = tide;
                    renderTideStats(tide);
                    renderTideChart(tide);
                })
                .catch(function(err) {
                    // Tide data is supplementary; fail quietly rather than blocking the main display.
                    console.error('Tide fetch failed:', err.message);
                });
        }

        function cachedFetch(fetchPath, delay) {
            var cacheKey = 'cachedFetch:' + fetchPath;
            var cached = null;
            try {
                cached = JSON.parse(localStorage.getItem(cacheKey));
            } catch (e) {
                cached = null;
            }

            if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < delay) {
                return Promise.resolve(cached.data);
            }

            return fetch(fetchPath)
                .then(function(resp) {
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    return resp.json();
                })
                .then(function(data) {
                    try {
                        localStorage.setItem(cacheKey, JSON.stringify({ fetchedAt: Date.now(), data: data }));
                    } catch (e) {
                        // localStorage unavailable/full; not critical, just skip caching.
                    }
                    return data;
                });
        }

        function fetchUsageData() {
            document.getElementById('resetTimeLocal').textContent = new Date(0).toLocaleTimeString([], {timeStyle: 'short'});
            fetch('/api/usage') // cachedFetch('/api/usage', 5 * 60 * 1000) // if cached then skip next then
                .then(function(resp) {
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    return resp.json();
                })
                .then(function(usage) {
                    if (!usage) return;
                    renderUsageBar('usageRequestsPct', 'usageRequestsCount', 'usageRequestsBar',
                        usage.workersRequests, usage.quotas.workersRequestsPerDay, 'requests');
                    renderUsageBar('usageD1Pct', 'usageD1Count', 'usageD1Bar',
                        usage.d1RowsRead, usage.quotas.d1RowsReadPerDay, 'rows read');
                })
                .catch(function(err) {
                    // Usage stats are supplementary; fail quietly rather than blocking the main display.
                    console.error('Usage fetch failed:', err.message);
                });
        }

        function renderUsageBar(pctId, countId, barId, used, quota, unitLabel) {
            var pct = quota ? Math.min(100, (used / quota) * 100) : 0;
            document.getElementById(pctId).textContent = pct.toFixed(1) + '%';
            document.getElementById(countId).textContent = used.toLocaleString() + ' / ' + quota.toLocaleString() + ' ' + unitLabel;
            var bar = document.getElementById(barId);
            bar.style.width = pct + '%';
            bar.classList.remove('warn', 'danger');
            if (pct >= 90) bar.classList.add('danger');
            else if (pct >= 70) bar.classList.add('warn');
        }

        function createCharts() {
            var gridColor = 'rgba(255,255,255,0.06)';
            var tickColor = '#546e7a';

            windChart = new Chart(document.getElementById('windChart'), {
                type: 'line',
                data: {
                    datasets: [
                        {
                            label: 'Wind Speed',
                            borderColor: '#4fc3f7',
                            backgroundColor: 'rgba(79,195,247,0.1)',
                            fill: true,
                            tension: 0.1,
                            pointRadius: 2,
                            borderWidth: 2,
                            data: []
                        },
                        {
                            label: 'Gust',
                            borderColor: '#ff7043',
                            backgroundColor: 'rgba(255,112,67,0.05)',
                            fill: true,
                            tension: 0.1,
                            pointRadius: 0,
                            borderWidth: 1.5,
                            borderDash: [4, 2],
                            data: []
                        },
                        {
                            fill: false,
                            showLine: false,
                            pointRadius: 0,
                            pointHoverRadius: 0,
                            borderWidth: 0,
                            data: []
                        }
                    ]
                },
                plugins: [arrowPlugin],
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { intersect: false, mode: 'index' },
                    plugins: {
                        legend: { labels: { color: '#90a4ae', filter: function(item) { return item.datasetIndex !== 2; } } },
                        tooltip: {
                            enabled: tooltipEnabled,
                            backgroundColor: '#1a2733', borderColor: '#2a3f50', borderWidth: 1,
                            callbacks: {
                                afterBody: function(tooltipItems) {
                                    var idx = tooltipItems[0].dataIndex;
                                    var dir = windDirections[idx];
                                    if (dir != null) return 'Direction: ' + degreesToCompass(dir) + ' (' + dir + '\\u00B0)';
                                    return '';
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            type: 'time',
                            time: { tooltipFormat: 'yyyy-MM-dd HH:mm:ss', displayFormats: { minute: 'HH:mm', hour: 'HH:mm', day: 'MMM d' } },
                            grid: { color: gridColor },
                            ticks: {
                                color: tickColor, maxTicksLimit: 12,
                                callback: function(value, index, ticks) {
                                    var d = new Date(ticks[index].value);
                                    var timeStr = d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
                                    if (displayHours > 24 || customRange) {
                                        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                                        return [timeStr, months[d.getMonth()] + ' ' + d.getDate()];
                                    }
                                    return timeStr;
                                }
                            }
                        },
                        y: {
                            beginAtZero: true,
                            grid: { color: gridColor },
                            ticks: { color: tickColor },
                            title: { display: true, text: 'knots', color: tickColor }
                        }
                    }
                }
            });

            directionChart = new Chart(document.getElementById('directionChart'), {
                type: 'scatter',
                data: {
                    datasets: [{
                        label: 'Direction',
                        borderColor: '#aed581',
                        backgroundColor: 'rgba(174,213,129,0.6)',
                        pointRadius: 3,
                        pointHoverRadius: 5,
                        data: []
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { intersect: false, mode: 'index' },
                    plugins: {
                        legend: { labels: { color: '#90a4ae' } },
                        tooltip: {
                            enabled: tooltipEnabled,
                            backgroundColor: '#1a2733', borderColor: '#2a3f50', borderWidth: 1,
                            callbacks: {
                                label: function(ctx) {
                                    var deg = ctx.parsed.y;
                                    return degreesToCompass(deg) + ' (' + deg + '\\u00B0)';
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            type: 'time',
                            time: { tooltipFormat: 'yyyy-MM-dd HH:mm:ss', displayFormats: { minute: 'HH:mm', hour: 'HH:mm', day: 'MMM d' } },
                            grid: { color: gridColor },
                            ticks: {
                                color: tickColor, maxTicksLimit: 12,
                                callback: function(value, index, ticks) {
                                    var d = new Date(ticks[index].value);
                                    var timeStr = d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
                                    if (displayHours > 24 || customRange) {
                                        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                                        return [timeStr, months[d.getMonth()] + ' ' + d.getDate()];
                                    }
                                    return timeStr;
                                }
                            }
                        },
                        y: {
                            min: 0, max: 360,
                            grid: { color: gridColor },
                            ticks: {
                                color: tickColor, stepSize: 45,
                                callback: function(value) {
                                    var labels = {0:'N',45:'NE',90:'E',135:'SE',180:'S',225:'SW',270:'W',315:'NW',360:'N'};
                                    return labels[value] || value + '\\u00B0';
                                }
                            },
                            title: { display: true, text: 'degrees', color: tickColor }
                        }
                    }
                }
            });
        }

        function updateCharts(readings) {
            windChart.data.datasets[0].data = readings.map(function(d) { return { x: d.station_time * 1000, y: d.wind_speed }; });
            // Raw D1 shows individual gust arrows; 30-minute sources show a connected gust line.
            if (sourceMode !== 'raw') {
                windChart.data.datasets[1].data = readings.map(function(d) { return { x: d.station_time * 1000, y: d.wind_gust }; });
                windChart.data.datasets[2].data = [];
                gustPointDirections = [];
            } else {
                windChart.data.datasets[1].data = [];
                var gustPointReadings = readings.filter(function(d) { return d.wind_gust != null; });
                windChart.data.datasets[2].data = gustPointReadings.map(function(d) { return { x: d.station_time * 1000, y: d.wind_gust }; });
                gustPointDirections = gustPointReadings.map(function(d) { return d.gust_direction != null ? d.gust_direction : d.wind_direction; });
            }
            windDirections = readings.map(function(d) { return d.wind_direction; });
            gustDirections = readings.map(function(d) { return d.gust_direction != null ? d.gust_direction : d.wind_direction; });
            gustTemperatures = readings.map(function(d) { return d.temperature != null ? d.temperature : null; });
            gustRainRates = readings.map(function(d) { return d.rain_rate != null ? d.rain_rate : null; });
            windChart.update('none');

            directionChart.data.datasets[0].data = readings.filter(function(d) { return d.wind_direction != null; })
                .map(function(d) { return { x: d.station_time * 1000, y: d.wind_direction }; });
            directionChart.update('none');
        }

        document.querySelectorAll('.controls button[data-hours]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.controls button').forEach(function(b) { b.classList.remove('active'); });
                this.classList.add('active');
                displayHours = parseInt(this.dataset.hours);
                customRange = null;
                document.getElementById('customRange').style.display = 'none';
                fetchData();
            });
        });

        // Custom range controls
        var customBtn = document.getElementById('customBtn');
        var customPanel = document.getElementById('customRange');
        var rangeFrom = document.getElementById('rangeFrom');
        var rangeTo = document.getElementById('rangeTo');
        var customGo = document.getElementById('customGo');

        // Set min/max attributes (7 days ago to now)
        var now = new Date();
        var sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000);
        function toLocalISO(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
        rangeFrom.min = toLocalISO(sixtyDaysAgo);
        rangeFrom.max = toLocalISO(now);
        rangeTo.min = toLocalISO(sixtyDaysAgo);
        rangeTo.max = toLocalISO(now);
        rangeTo.value = toLocalISO(now);
        rangeFrom.value = toLocalISO(new Date(now.getTime() - 3600000));

        customBtn.addEventListener('click', function() {
            var showing = customPanel.style.display !== 'none';
            customPanel.style.display = showing ? 'none' : 'block';
            if (!showing) {
                document.querySelectorAll('.controls button').forEach(function(b) { b.classList.remove('active'); });
                customBtn.classList.add('active');
            }
        });

        customGo.addEventListener('click', function() {
            var from = new Date(rangeFrom.value);
            var to = new Date(rangeTo.value);
            if (isNaN(from) || isNaN(to) || from >= to) { alert('Invalid range'); return; }
            customRange = { min: Math.floor(from.getTime() / 1000), max: Math.floor(to.getTime() / 1000) };
            fetchData();
        });

        document.querySelectorAll('input[name="sourceMode"]').forEach(function(input) {
            input.checked = (input.value === sourceMode);
            input.addEventListener('change', function() {
                if (!this.checked) return;
                sourceMode = this.value;
                fetchData();
            });
        });

        document.getElementById('tideHeader').addEventListener('click', function() {
            var body = document.getElementById('tideBody');
            var expanding = body.style.display === 'none';
            body.style.display = expanding ? '' : 'none';
            this.classList.toggle('expanded', expanding);
            if (expanding) fetchTideData();
        });

        document.getElementById('usageHeader').addEventListener('click', function() {
            var body = document.getElementById('usageBody');
            var expanding = body.style.display === 'none';
            body.style.display = expanding ? '' : 'none';
            this.classList.toggle('expanded', expanding);
            if (expanding) fetchUsageData();
        });

        createCharts();
        fetchData();
        //fetchForecastData();
    })();
    <\/script>
</body>
</html>`;
