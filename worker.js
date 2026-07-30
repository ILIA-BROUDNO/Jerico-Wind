// Jericho Wind Monitor — Cloudflare Worker
// Serves: HTML frontend (GET /), API (GET /api/*), Cron (scheduled)
// Binding: D1 database as "DB"
// Cron: */1 * * * *

const WEATHERLINK_URL = 'https://www.weatherlink.com/embeddablePage/getData/e25c3f542d98439b8acd3bcc217068ce';
const CACHE_TTL_SECONDS = 0;
const PURGE_DAYS = 60;

// --- Cron Handler: fetch WeatherLink, store in D1 ---
async function handleScheduled(env) {
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

  await env.DB.prepare(
    `INSERT OR IGNORE INTO readings (station_time, captured_at, wind_speed, wind_gust, wind_direction, temperature, barometer, gust_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    stationTime,
    Math.floor(Date.now() / 1000),
    parseFloat(data.wind) || 0,
    parseFloat(data.gust) || 0,
    data.windDirection != null ? data.windDirection : null,
    parseFloat(data.temperature) || null,
    parseFloat(data.barometer) || null,
    gustAt
  ).run();

  // Purge old data
  const cutoff = Math.floor(Date.now() / 1000) - PURGE_DAYS * 86400;
  await env.DB.prepare('DELETE FROM readings WHERE station_time < ?').bind(cutoff).run();
}

// --- API Handler ---
async function handleAPI(request, env, ctx) {
  const url = new URL(request.url);
  const cacheKey = new Request(url.toString(), request);
  const cache = caches.default;

  let response;

  if (url.pathname === '/api/readings') {
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

    const { results } = await env.DB.prepare(
      'SELECT station_time, wind_speed, wind_direction, temperature, barometer FROM readings WHERE station_time > ? AND station_time <= ? ORDER BY station_time ASC'
    ).bind(since, until).all();

    response = jsonResponse(results);

  } else if (url.pathname === '/api/jsca-txt') {
    // Proxy the JSCA 2-day data dump and parse it
    const txtResp = await fetch('https://jsca.bc.ca/main/downld02.txt', {
      headers: { 'User-Agent': 'JerichoWindMonitor/1.0' },
    });
    if (!txtResp.ok) return jsonResponse({ error: 'Failed to fetch JSCA data' }, 502);
    const txt = await txtResp.text();
    const lines = txt.split('\n');
    const readings = [];
    for (const line of lines) {
      const m = line.match(/^\s*(\d{1,2}\/\d{1,2}\/\d{2})\s+(\d{1,2}:\d{2}[ap])\s+/);
      if (!m) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 16) continue;
      const dateStr = parts[0];
      const timeStr = parts[1];
      // Parse date: M/D/YY
      const dp = dateStr.split('/');
      const year = 2000 + parseInt(dp[2]);
      const month = parseInt(dp[0]) - 1;
      const day = parseInt(dp[1]);
      // Parse time: h:mma/p
      const tm = timeStr.match(/(\d{1,2}):(\d{2})([ap])/);
      if (!tm) continue;
      let hour = parseInt(tm[1]);
      const min = parseInt(tm[2]);
      const ampm = tm[3];
      if (ampm === 'p' && hour !== 12) hour += 12;
      if (ampm === 'a' && hour === 12) hour = 0;
      // txt times are PDT (UTC-7), construct UTC timestamp
      const dt = new Date(Date.UTC(year, month, day, hour + 7, min));
      const ts = Math.floor(dt.getTime() / 1000);
      const windSpeed = parseFloat(parts[7]) || 0;
      const windDir = parts[8];
      const hiSpeed = parseFloat(parts[10]) || 0;
      const hiDir = parts[11];
      // Convert compass to degrees
      function compassToDeg(c) {
        var map = {N:0,NNE:22,NE:45,ENE:67,E:90,ESE:112,SE:135,SSE:157,S:180,SSW:202,SW:225,WSW:247,W:270,WNW:292,NW:315,NNW:337};
        return map[c] != null ? map[c] : null;
      }
      readings.push({
        station_time: ts,
        wind_speed: windSpeed,
        wind_gust: hiSpeed,
        wind_direction: compassToDeg(windDir),
        gust_direction: compassToDeg(hiDir)
      });
    }
    response = jsonResponse(readings);

  } else if (url.pathname === '/api/current') {
    const { results } = await env.DB.prepare(
      'SELECT station_time, wind_speed, wind_direction, temperature, barometer FROM readings ORDER BY station_time DESC LIMIT 1'
    ).all();

    response = jsonResponse(results[0] || null);

  } else {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  return response;
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
    ctx.waitUntil(handleScheduled(env));
  },
};

// --- Embedded Frontend HTML ---
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Jericho Wind Monitor</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%9B%B5%3C/text%3E%3C/svg%3E">
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"><\/script>
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
        .data-info { font-size: 0.75rem; color: #546e7a; text-align: center; margin-top: 15px; }
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
        <div class="toggle-container" style="display:inline-flex; align-items:center; gap:6px; margin-left:10px; font-size:0.8rem; color:#90a4ae;">
            <span>1min</span>
            <div id="sourceToggle" class="toggle-switch" style="width:36px; height:20px; background:#2a3f50; border-radius:10px; position:relative; cursor:pointer; transition:background 0.2s;">
                <div class="toggle-knob" style="width:16px; height:16px; background:#e0e0e0; border-radius:50%; position:absolute; top:2px; left:2px; transition:left 0.2s;"></div>
            </div>
            <span>30min</span>
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
    <div class="data-info">
        Data source: Davis Vantage Pro2 via WeatherLink Live at Jericho Sailing Centre, Vancouver BC.<br>
        Data collected every minute. Up to 7 days of history available.
    </div>
    <script>
    (function() {
        var POLL_INTERVAL_MS = 60 * 1000; // kept for reference only
        var displayHours = 1;
        var windChart;
        var directionChart;
        var windDirections = [];
        var gustDirections = [];

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

        // Custom plugin: draw wind direction arrows + gust event arrows
        var arrowPlugin = {
            id: 'windArrows',
            afterDatasetsDraw: function(chart) {
                var ctx = chart.ctx;
                var xScale = chart.scales.x;
                var yScale = chart.scales.y;
                var windData = chart.data.datasets[0].data;
                var gustData = chart.data.datasets[1].data;
                if (!windData.length) return;

                // Green wind direction arrows (spaced by screen width)
                if (windDirections.length) {
                    var chartWidth = xScale.width;
                    var minPxBetweenArrows = 24; // arrow width ~24px, so they just touch
                    var maxArrows = Math.floor(chartWidth / minPxBetweenArrows);
                    var step = Math.max(1, Math.floor(windData.length / maxArrows));
                    for (var i = 0; i < windData.length; i += step) {
                        var dir = windDirections[i];
                        if (dir == null) continue;
                        var x = xScale.getPixelForValue(windData[i].x);
                        var y = yScale.getPixelForValue(windData[i].y);
                        var angle = (dir + 180) * Math.PI / 180;
                        drawArrow(ctx, x, y, angle, 12, 'rgba(174,213,129,0.85)');
                    }
                }

                // Red gust direction arrows (JSCA only, on gust line)
                if (useJscaSource && gustDirections.length && gustData.length) {
                    var gStep = Math.max(1, Math.floor(gustData.length / maxArrows));
                    for (var j = 0; j < gustData.length; j += gStep) {
                        var gdir = gustDirections[j];
                        if (gdir == null) continue;
                        var gx = xScale.getPixelForValue(gustData[j].x);
                        var gy = yScale.getPixelForValue(gustData[j].y);
                        var gangle = (gdir + 180) * Math.PI / 180;
                        drawArrow(ctx, gx, gy, gangle, 14, 'rgba(255,112,67,0.9)');
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

        function updateCurrentDisplayD1(readings) {
            var now = readings[readings.length - 1].station_time;
            var thirtyMinAgo = now - 1800;
            var recent = readings.filter(function(r) { return r.station_time > thirtyMinAgo; });
            if (!recent.length) recent = [readings[readings.length - 1]];
            var avgWind = recent.reduce(function(s, r) { return s + r.wind_speed; }, 0) / recent.length;
            var maxWind = Math.max.apply(null, recent.map(function(r) { return r.wind_speed; }));
            var dirs = recent.filter(function(r) { return r.wind_direction != null; }).map(function(r) { return r.wind_direction; });
            var avgDir = dirs.length ? Math.round(dirs.reduce(function(s, d) { return s + d; }, 0) / dirs.length) : null;
            var lastReading = readings[readings.length - 1];
            document.getElementById('currentWind').textContent = avgWind.toFixed(1);
            document.getElementById('currentGust').textContent = maxWind.toFixed(1);
            document.getElementById('currentDirection').textContent =
                avgDir != null ? degreesToCompass(avgDir) + ' (' + avgDir + '\\u00B0)' : '--';
            document.getElementById('currentTemp').textContent = lastReading.temperature != null ? lastReading.temperature.toFixed(1) : '--';
            document.getElementById('lastUpdate').textContent = 'Updated: ' + new Date(lastReading.station_time * 1000).toLocaleTimeString();
            document.getElementById('statusIndicator').textContent = '\\u25CF ';
            document.getElementById('statusIndicator').className = 'live';
        }

        function showError(msg) {
            document.getElementById('statusIndicator').textContent = '\\u25CF ';
            document.getElementById('statusIndicator').className = 'error';
            document.getElementById('lastUpdate').textContent = msg;
        }

        var customRange = null; // {min, max} in unix seconds
        var useJscaSource = false;

        function fetchData() {
            var url;
            if (useJscaSource) {
                url = '/api/jsca-txt';
            } else if (customRange) {
                url = '/api/readings?min=' + customRange.min + '&max=' + customRange.max;
            } else {
                url = '/api/readings?hours=' + displayHours;
            }
            fetch(url)
                .then(function(resp) {
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    return resp.json();
                })
                .then(function(readings) {
                    // If JSCA source, filter by time range
                    if (useJscaSource && readings.length) {
                        var now = Math.floor(Date.now() / 1000);
                        var minT, maxT;
                        if (customRange) {
                            minT = customRange.min;
                            maxT = customRange.max;
                        } else {
                            minT = now - displayHours * 3600;
                            maxT = now;
                        }
                        readings = readings.filter(function(r) { return r.station_time > minT && r.station_time <= maxT; });
                    }
                    if (readings.length > 0) {
                        if (useJscaSource) {
                            updateCurrentDisplay(readings[readings.length - 1]);
                        } else {
                            updateCurrentDisplayD1(readings);
                        }
                    }
                    updateCharts(readings);
                })
                .catch(function(err) {
                    showError('Error: ' + err.message);
                });
        }

        var isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        var tooltipEnabled = !isMobile;

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
                            tension: 0,
                            pointRadius: 2,
                            borderWidth: 2,
                            data: []
                        },
                        {
                            label: 'Gust',
                            borderColor: '#ff7043',
                            backgroundColor: 'rgba(255,112,67,0.05)',
                            fill: true,
                            tension: 0,
                            pointRadius: 0,
                            borderWidth: 1.5,
                            borderDash: [4, 2],
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
                        legend: { labels: { color: '#90a4ae' } },
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
            // Only show gust line for JSCA source
            if (useJscaSource) {
                windChart.data.datasets[1].data = readings.map(function(d) { return { x: d.station_time * 1000, y: d.wind_gust }; });
            } else {
                windChart.data.datasets[1].data = [];
            }
            windDirections = readings.map(function(d) { return d.wind_direction; });
            gustDirections = readings.map(function(d) { return d.gust_direction != null ? d.gust_direction : d.wind_direction; });
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

        // Source toggle (D1 vs JSCA txt)
        var toggleEl = document.getElementById('sourceToggle');
        var toggleKnob = toggleEl.querySelector('.toggle-knob');
        toggleEl.addEventListener('click', function() {
            useJscaSource = !useJscaSource;
            if (useJscaSource) {
                toggleEl.style.background = '#4fc3f7';
                toggleKnob.style.left = '18px';
            } else {
                toggleEl.style.background = '#2a3f50';
                toggleKnob.style.left = '2px';
            }
            fetchData();
        });

        createCharts();
        fetchData();
    })();
    <\/script>
</body>
</html>`;
