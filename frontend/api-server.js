// ============================================================
// VidAlzer YouTube API Server — api-server.js
// Run: node api-server.js
// Test: http://localhost:3002/api/search?q=Operating+Systems
// ============================================================

import http from 'http';
import https from 'https';
import { URL } from 'url';

// 🔑 APNI YOUTUBE DATA API v3 KEY YAHAN DAALO
// Get it free from: https://console.cloud.google.com
const YT_API_KEY = 'YOUR_YOUTUBE_API_KEY_HERE';

const PORT = 3002;

// ─────────────────────────────────────────────
// RATING FORMULA (same as Rating_System.ipynb)
// ─────────────────────────────────────────────
function calculateRating(views, likes, uploadDate, commentSentiment = 0) {
  const likesScore  = Math.log1p(likes) / 10;          // 40% weight
  const viewsScore  = Math.log1p(views) / 15;          // 30% weight
  const sentScore   = (commentSentiment + 1) / 2;      // 20% weight (normalized 0-1)
  const daysOld     = (Date.now() - new Date(uploadDate)) / 86400000;
  const recency     = 1 / (1 + daysOld / 30);          // 10% weight

  const raw = (0.4 * likesScore) + (0.3 * viewsScore) +
              (0.2 * sentScore)  + (0.1 * recency);

  return Math.min(10, Math.round(raw * 1000) / 100);  // scale 0-10
}

// ─────────────────────────────────────────────
// SENTIMENT — simple keyword approach (no TextBlob)
// ─────────────────────────────────────────────
const positiveWords = ['great','excellent','helpful','amazing','best','good','love','wonderful','perfect','clear','easy','understand','recommend','fantastic','brilliant'];
const negativeWords = ['bad','worst','useless','boring','terrible','wrong','hate','poor','waste','confusing','hard','difficult'];

function simpleSentiment(text) {
  const lower = text.toLowerCase();
  let score = 0;
  positiveWords.forEach(w => { if (lower.includes(w)) score += 0.1; });
  negativeWords.forEach(w => { if (lower.includes(w)) score -= 0.1; });
  return Math.max(-1, Math.min(1, score)); // clamp -1 to 1
}

// ─────────────────────────────────────────────
// YOUTUBE API HELPER — make HTTPS GET request
// ─────────────────────────────────────────────
function ytGet(path) {
  return new Promise((resolve, reject) => {
    const url = `https://www.googleapis.com/youtube/v3${path}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────────
// STEP 1: Search videos by query
// ─────────────────────────────────────────────
async function searchVideos(query, maxResults = 12) {
  const q   = encodeURIComponent(query);
  const res = await ytGet(
    `/search?part=snippet&q=${q}&type=video&maxResults=${maxResults}&order=relevance&key=${YT_API_KEY}`
  );
  if (res.error) throw new Error(res.error.message);
  return res.items || [];
}

// ─────────────────────────────────────────────
// STEP 2: Get stats (views, likes) for video IDs
// ─────────────────────────────────────────────
async function getVideoStats(videoIds) {
  const ids = videoIds.join(',');
  const res = await ytGet(
    `/videos?part=statistics,snippet,contentDetails&id=${ids}&key=${YT_API_KEY}`
  );
  if (res.error) throw new Error(res.error.message);
  const map = {};
  (res.items || []).forEach(item => { map[item.id] = item; });
  return map;
}

// ─────────────────────────────────────────────
// STEP 3: Get top comments for sentiment
// ─────────────────────────────────────────────
async function getCommentSentiment(videoId) {
  try {
    const res = await ytGet(
      `/commentThreads?part=snippet&videoId=${videoId}&maxResults=20&order=relevance&key=${YT_API_KEY}`
    );
    if (!res.items || res.items.length === 0) return 0;
    const scores = res.items.map(c =>
      simpleSentiment(c.snippet.topLevelComment.snippet.textOriginal)
    );
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  } catch {
    return 0; // comments disabled → neutral sentiment
  }
}

// ─────────────────────────────────────────────
// MAIN HANDLER: /api/search?q=QUERY
// ─────────────────────────────────────────────
async function handleSearch(query, res) {
  try {
    console.log(`\n🔍 Searching: "${query}"`);

    // Step 1: Search
    const searchItems = await searchVideos(query, 12);
    const videoIds = searchItems.map(i => i.id.videoId);
    console.log(`✅ Found ${videoIds.length} videos`);

    // Step 2: Get stats for all videos in ONE API call (efficient!)
    const statsMap = await getVideoStats(videoIds);
    console.log(`✅ Fetched stats`);

    // Step 3: Get comment sentiment (fetch top 3 videos only to save quota)
    const sentimentMap = {};
    for (const vid of videoIds.slice(0, 3)) {
      sentimentMap[vid] = await getCommentSentiment(vid);
    }
    console.log(`✅ Analysed comments`);

    // Step 4: Calculate rating for each video
    const videos = searchItems.map(item => {
      const id      = item.id.videoId;
      const details = statsMap[id];
      if (!details) return null;

      const stats      = details.statistics;
      const snippet    = details.snippet;
      const views      = parseInt(stats.viewCount  || 0);
      const likes      = parseInt(stats.likeCount  || 0);
      const comments   = parseInt(stats.commentCount || 0);
      const uploadDate = snippet.publishedAt;
      const sentiment  = sentimentMap[id] || 0;
      const rating     = calculateRating(views, likes, uploadDate, sentiment);

      // Duration from ISO 8601 (PT4M13S → "4:13")
      const dur  = (details.contentDetails || {}).duration || '';
      const durM = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      let duration = '';
      if (durM) {
        const h = durM[1]|0, m = durM[2]|0, s = String(durM[3]|0).padStart(2,'0');
        duration = h ? `${h}:${String(m).padStart(2,'0')}:${s}` : `${m}:${s}`;
      }

      return {
        id,
        title:        snippet.title,
        channel:      snippet.channelTitle,
        thumbnail:    snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url,
        publishedAt:  uploadDate,
        url:          `https://www.youtube.com/watch?v=${id}`,
        embedUrl:     `https://www.youtube.com/embed/${id}`,
        views,
        likes,
        comments,
        duration,
        rating,
        sentiment:    Math.round(sentiment * 100) / 100
      };
    }).filter(Boolean);

    // Step 5: Sort by rating (highest first)
    videos.sort((a, b) => b.rating - a.rating);

    console.log(`\n📊 Top rated:`);
    videos.slice(0,3).forEach((v,i) => console.log(`  ${i+1}. ⭐${v.rating} — ${v.title}`));

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ query, count: videos.length, videos }));

  } catch (err) {
    console.error('❌ Error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ─────────────────────────────────────────────
// HTTP SERVER
// ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }

  if (url.pathname === '/api/search') {
    const query = url.searchParams.get('q') || '';
    if (!query.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: 'Missing query parameter ?q=' }));
    }

    if (YT_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE') {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        error: 'API key not configured. Please set YT_API_KEY in api-server.js',
        guide: 'Get free key at: https://console.cloud.google.com → APIs & Services → YouTube Data API v3'
      }));
    }

    return handleSearch(query, res);
  }

  // Health check
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'VidAlzer API Server running', port: PORT, endpoint: '/api/search?q=your+topic' }));
});

server.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════');
  console.log(`🚀 VidAlzer API Server running on port ${PORT}`);
  console.log(`📡 Endpoint: http://localhost:${PORT}/api/search?q=YOUR_TOPIC`);
  console.log(`🔑 API Key: ${YT_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE' ? '❌ NOT SET (edit api-server.js)' : '✅ Configured'}`);
  console.log('═══════════════════════════════════════════════');
});
