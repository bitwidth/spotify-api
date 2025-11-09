const querystring = require('querystring');

exports.loginHandler = async (event) => {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server misconfiguration: SPOTIFY_CLIENT_ID and SPOTIFY_REDIRECT_URI must be set as environment variables.' })
    };
  }
  const state = Math.random().toString(36).substring(2, 15);
  const scope = [
    'user-follow-read',
    'user-modify-playback-state',
    'user-read-playback-state',
    'user-top-read',
    'streaming',
    'user-read-private',
    'user-read-email'
  ].join(' ');

  const params = querystring.stringify({
    response_type: 'code',
    client_id: clientId,
    scope,
    redirect_uri: redirectUri,
    state
  });

  return {
    statusCode: 302,
    headers: {
      Location: `https://accounts.spotify.com/authorize?${params}`
    },
    body: ''
  };
};

exports.callbackHandler = async (event) => {
  const AWS = require('aws-sdk');
  const https = require('https');
  const querystring = require('querystring');

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const tokensTable = process.env.TOKENS_TABLE;

  if (!clientId || !clientSecret || !process.env.SPOTIFY_REDIRECT_URI) {
    return { statusCode: 500, body: 'Server misconfiguration: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and SPOTIFY_REDIRECT_URI are required.' };
  }

  const params = event.queryStringParameters || {};
  const code = params.code;
  const state = params.state;

  if (!code) {
    return { statusCode: 400, body: 'Missing code' };
  }

  const postData = querystring.stringify({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    client_id: clientId,
    client_secret: clientSecret
  });

  const options = {
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const tokenResponse = await new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(10000, () => {
      req.abort();
      reject(new Error('Token request timed out'));
    });
    req.write(postData);
    req.end();
  }).catch((err) => {
    return { statusCode: 502, body: `Token exchange network error: ${err.message}` };
  });

  if (tokenResponse.statusCode !== 200) {
    let errBody = tokenResponse.body || '';
    let parsed = null;
    try {
      parsed = JSON.parse(errBody);
    } catch (e) {
      parsed = null;
    }
    const errCode = (parsed && (parsed.error || parsed.error_description)) || errBody;
    console.error('Token exchange failed:', errBody);

    if (process.env.FRONTEND_BASE_URL) {
      const safe = encodeURIComponent(typeof errCode === 'string' ? errCode : JSON.stringify(errCode));
      const redirectTo = `${process.env.FRONTEND_BASE_URL}?auth_error=${safe}`;
      return { statusCode: 302, headers: { Location: redirectTo, 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: '' };
    }

    return { statusCode: 502, body: JSON.stringify({ error: 'token_exchange_failed', details: errCode }) };
  }

  const tokenJson = JSON.parse(tokenResponse.body);
  const refreshToken = tokenJson.refresh_token;

  const accessToken = tokenJson.access_token;
  const me = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.spotify.com',
        path: '/v1/me',
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    req.on('error', (err) => reject(err));
    req.setTimeout(10000, () => {
      req.abort();
      reject(new Error('Profile request timed out'));
    });
    req.end();
  }).catch((err) => {
    return { statusCode: 502, body: `Failed to fetch user profile (network): ${err.message}` };
  });

  if (me.statusCode !== 200) {
    return { statusCode: 502, body: `Failed to fetch user profile: ${me.body}` };
  }

  const meJson = JSON.parse(me.body);
  const spotifyUserId = meJson.id;

  const dynamo = new AWS.DynamoDB.DocumentClient();
  await dynamo
    .put({ TableName: tokensTable, Item: { spotifyUserId, refreshToken, scope: tokenJson.scope, savedAt: Date.now() } })
    .promise();
  const frontendBase = process.env.FRONTEND_BASE_URL;
  if (process.env.FRONTEND_BASE_URL) {
    const redirectTo = `${process.env.FRONTEND_BASE_URL}?spotifyUserId=${spotifyUserId}`;
    return { statusCode: 302, headers: { Location: redirectTo, 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: '' };
  }
  return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*' }, body: JSON.stringify({ message: 'Connected', spotifyUserId }) };
};
