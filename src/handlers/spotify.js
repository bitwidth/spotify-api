const AWS = require('aws-sdk');
const https = require('https');
const querystring = require('querystring');

const TOKENS_TABLE = process.env.TOKENS_TABLE;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

async function getRefreshTokenForUser(spotifyUserId) {
  const ddb = new AWS.DynamoDB.DocumentClient();
  const res = await ddb.get({ TableName: TOKENS_TABLE, Key: { spotifyUserId } }).promise();
  return res.Item && res.Item.refreshToken;
}

async function refreshAccessToken(refreshToken) {
  const postData = querystring.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  });

  const options = {
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  };

  return await new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`Token refresh failed: ${res.statusCode} ${data}`));
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function spotifyRequest(path, method = 'GET', accessToken, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.spotify.com',
      path,
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

exports.handler = async (event) => {
  // path-based routing
  const path = event.path || '';
  const method = (event.httpMethod || event.requestContext?.http?.method || '').toUpperCase();

  // CORS preflight handling: respond to OPTIONS without invoking Spotify or requiring params
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization'
      },
      body: ''
    };
  }
  const parts = path.split('/').filter(Boolean); // ['spotify','following']

  // expect spotifyUserId via query param for now
  const spotifyUserId = (event.queryStringParameters && event.queryStringParameters.spotifyUserId) || (event.headers && event.headers['x-spotify-user-id']);
  if (!spotifyUserId) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: 'Missing spotifyUserId (query param or x-spotify-user-id header)' };

  const refreshToken = await getRefreshTokenForUser(spotifyUserId);
  if (!refreshToken) return { statusCode: 404, body: 'No refresh token found for user; reconnect required' };

  let accessToken;
  try {
    const t = await refreshAccessToken(refreshToken);
    accessToken = t.access_token;
  } catch (err) {
    return { statusCode: 502, headers: { 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: `Failed to refresh access token: ${err.message}` };
  }

  // /spotify/following -> list artists user follows
  if (parts[1] === 'following' || path.endsWith('/following')) {
    const res = await spotifyRequest('/v1/me/following?type=artist&limit=50', 'GET', accessToken);
    return { statusCode: res.statusCode, headers: { 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: res.body };
  }

  // /spotify/player/stop -> stop playback
  if (path.endsWith('/player/stop')) {
    const res = await spotifyRequest('/v1/me/player/pause', 'PUT', accessToken);
    return { statusCode: res.statusCode || 204, headers: { 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: res.body || '' };
  }

  // /spotify/player/devices -> list user's devices
  if (path.endsWith('/player/devices') || parts.slice(1).join('/').endsWith('player/devices')) {
    const devRes = await spotifyRequest('/v1/me/player/devices', 'GET', accessToken);
    return { statusCode: devRes.statusCode || 200, headers: { 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: devRes.body || '[]' };
  }

  // /spotify/player/token -> return a fresh access token (for Web Playback SDK)
  if (path.endsWith('/player/token') || parts.slice(1).join('/').endsWith('player/token')) {
    // return short-lived access token to client
    try {
      const t = await refreshAccessToken(refreshToken);
      const payload = { access_token: t.access_token, expires_in: t.expires_in };
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: JSON.stringify(payload) };
    } catch (err) {
      return { statusCode: 502, headers: { 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: `Failed to refresh access token: ${err.message}` };
    }
  }

  // /spotify/player/play-top?index=0 -> start playback of top 10 song by index
  if (path.includes('/player/play-top')) {
    // fetch top tracks
    const topRes = await spotifyRequest('/v1/me/top/tracks?limit=10', 'GET', accessToken);
  if (topRes.statusCode !== 200) return { statusCode: topRes.statusCode, headers: { 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: topRes.body };
    const topJson = JSON.parse(topRes.body);
    const index = parseInt((event.queryStringParameters && event.queryStringParameters.index) || '0', 10);
    const track = topJson.items && topJson.items[index];
    if (!track) return { statusCode: 400, body: 'Invalid index or no track found' };

    // start playback
    const body = { uris: [track.uri] };
    const playRes = await spotifyRequest('/v1/me/player/play', 'PUT', accessToken, body);

    // If Spotify reports no active device, fetch devices and return a helpful payload
    if (playRes.statusCode === 404) {
      let playErr = {};
      try {
        playErr = JSON.parse(playRes.body || '{}');
      } catch (e) {
        playErr = { message: playRes.body || 'Unknown error' };
      }

      // Spotify uses reason: "NO_ACTIVE_DEVICE" in some responses
      const reason = playErr.reason || (playErr.error && playErr.error.reason) || null;
      if (reason === 'NO_ACTIVE_DEVICE' || (playErr.message && playErr.message.toUpperCase().includes('NO_ACTIVE_DEVICE'))) {
        const devRes = await spotifyRequest('/v1/me/player/devices', 'GET', accessToken);
        let devices = [];
        try {
          const djson = JSON.parse(devRes.body || '{}');
          devices = djson.devices || [];
        } catch (e) {
          devices = [];
        }
        const payload = {
          status: 'NO_ACTIVE_DEVICE',
          message: 'No active Spotify device found. Please open Spotify on a device or transfer playback.',
          devices
        };
        return { statusCode: 409, headers: { 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: JSON.stringify(payload) };
      }
    }

    return { statusCode: playRes.statusCode || 204, headers: { 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: playRes.body || '' };
  }

  return { statusCode: 404, headers: { 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: 'Not found' };
};
