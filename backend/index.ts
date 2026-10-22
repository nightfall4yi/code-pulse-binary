import { router, json, error } from '@appdeploy/sdk';

import {
  realtimeSubscriptionRoutes,
} from './realtime-subscribers';

const DERIV_TOKEN_URL = 'https://auth.deriv.com/oauth2/token';
const DERIV_CLIENT_ID = '34KuEDDAwXVXfSunQnHDx';
const DERIV_REDIRECT_URI = 'https://volatility-trader-u6vyl7.v2.appdeploy.ai/callback';

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ message: 'Success' })],

  'POST /api/deriv/oauth/token': [async ({ body }) => {
    if (!body || typeof body !== 'object') {
      return error('Invalid request body', 400);
    }

    const payload = body as { code?: string; codeVerifier?: string; redirectUri?: string };
    if (!payload.code || !payload.codeVerifier || payload.redirectUri !== DERIV_REDIRECT_URI) {
      return error('Missing or invalid OAuth callback parameters', 400);
    }
    if (payload.code.length > 4096 || payload.codeVerifier.length < 43 || payload.codeVerifier.length > 128) {
      return error('Invalid OAuth code or PKCE verifier', 400);
    }

    const tokenResponse = await fetch(DERIV_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: DERIV_CLIENT_ID,
        code: payload.code,
        code_verifier: payload.codeVerifier,
        redirect_uri: DERIV_REDIRECT_URI,
      }),
    });

    const tokenData = await tokenResponse.json() as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!tokenResponse.ok || !tokenData.access_token) {
      return error('Deriv token exchange failed. Restart the connection and try again.', 502);
    }

    const accountsResponse = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const accountsData = await accountsResponse.json() as {
      data?: Array<{ account_id?: string; account_type?: string; currency?: string; status?: string }>;
    };
    if (!accountsResponse.ok || !Array.isArray(accountsData.data)) {
      return error('Could not retrieve Deriv Options accounts. Check that the authorised account has trade access.', 502);
    }

    return json({
      access_token: tokenData.access_token,
      token_type: tokenData.token_type ?? 'Bearer',
      expires_in: tokenData.expires_in ?? 3600,
      accounts: accountsData.data,
    });
  }],

  'POST /api/deriv/accounts/otp': [async ({ body }) => {
    if (!body || typeof body !== 'object') {
      return error('Invalid OTP request body', 400);
    }
    const payload = body as { accessToken?: string; accountId?: string };
    if (!payload.accessToken || !payload.accountId || payload.accessToken.length > 8192 || payload.accountId.length > 128) {
      return error('Missing or invalid access token or account ID', 400);
    }

    const otpResponse = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(payload.accountId)}/otp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${payload.accessToken}` },
    });
    const otpData = await otpResponse.json() as { data?: { url?: string }; errors?: Array<{ message?: string }> };
    if (!otpResponse.ok || !otpData.data?.url) {
      return error(otpData.errors?.[0]?.message || 'Deriv did not return an authenticated WebSocket URL.', 502);
    }

    return json({ url: otpData.data.url });
  }],

  ...realtimeSubscriptionRoutes,
});
