import { useEffect, useState } from 'react';
import { api } from '@appdeploy/client';
import {
  Activity,
  ArrowUpRight,
  ShieldCheck,
  Zap,
  Link2,
  CircleAlert,
  LockKeyhole,
  ChartNoAxesCombined,
  LogOut,
} from 'lucide-react';

function App() {
  const [accountMode, setAccountMode] = useState('demo');
  const [market, setMarket] = useState('1HZ100V');
  const [notice, setNotice] = useState('');
  const [tickStatus, setTickStatus] = useState('Waiting for connection');
  const [latestQuote, setLatestQuote] = useState('—');
  const [latestDigit, setLatestDigit] = useState('—');
  const [isDerivConnected, setIsDerivConnected] = useState(() => Boolean(sessionStorage.getItem('deriv_access_token')) && Boolean(sessionStorage.getItem('deriv_accounts')));
  const DERIV_CLIENT_ID = '34KuEDDAwXVXfSunQnHDx';
  const DERIV_REDIRECT_URI = 'https://volatility-trader-u6vyl7.v2.appdeploy.ai/callback';

  function base64Url(bytes: Uint8Array) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function disconnectFromDeriv() {
    sessionStorage.removeItem('deriv_access_token');
    sessionStorage.removeItem('deriv_accounts');
    setIsDerivConnected(false);
    setNotice('Disconnected from Deriv.');
    setTickStatus('Waiting for connection');
    setLatestQuote('—');
    setLatestDigit('—');
  }

  async function connectToDeriv() {
    try {
      setNotice('Preparing secure Deriv authorisation…');
      const random = crypto.getRandomValues(new Uint8Array(32));
      const codeVerifier = base64Url(random);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
      const codeChallenge = base64Url(new Uint8Array(digest));
      const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
      // localStorage survives consent flows that return in a new tab/webview.
      localStorage.setItem('deriv_pkce_verifier', codeVerifier);
      localStorage.setItem('deriv_oauth_state', state);
      const url = new URL('https://auth.deriv.com/oauth2/auth');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', DERIV_CLIENT_ID);
      url.searchParams.set('redirect_uri', DERIV_REDIRECT_URI);
      url.searchParams.set('scope', 'trade');
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      window.location.assign(url.toString());
    } catch {
      setNotice('Could not start secure authorisation. Please use a browser with secure crypto support and try again.');
    }
  }

  useEffect(() => {
    if (window.location.pathname !== '/callback') return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const returnedState = params.get('state');
    const savedState = localStorage.getItem('deriv_oauth_state');
    const verifier = localStorage.getItem('deriv_pkce_verifier');

    if (params.has('error')) {
      setNotice('Deriv authorisation was cancelled or denied. You can try again.');
      window.history.replaceState({}, '', '/');
      return;
    }
    if (!code || !savedState || returnedState !== savedState || !verifier) {
      localStorage.removeItem('deriv_pkce_verifier');
      localStorage.removeItem('deriv_oauth_state');
      setNotice('Authorisation could not be verified. Please restart the connection.');
      window.history.replaceState({}, '', '/');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const response = await api.post('/api/deriv/oauth/token', {
          code,
          codeVerifier: verifier,
          redirectUri: DERIV_REDIRECT_URI,
        });
        if (cancelled) return;
        const token = response.data?.access_token;
        const accounts = response.data?.accounts;
        if (!token) throw new Error('No access token returned');
        if (!Array.isArray(accounts) || accounts.length === 0) throw new Error('No Options accounts were returned');
        sessionStorage.setItem('deriv_access_token', token);
        sessionStorage.setItem('deriv_accounts', JSON.stringify(accounts));
        localStorage.removeItem('deriv_pkce_verifier');
        localStorage.removeItem('deriv_oauth_state');
        setIsDerivConnected(true);
        setNotice('Deriv account connected successfully for this browser session.');
      } catch {
        if (!cancelled) setNotice('Deriv token exchange failed. Check the registered redirect URL and try connecting again.');
      } finally {
        window.history.replaceState({}, '', '/');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isDerivConnected) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let connectionAttempt = 0;
    setTickStatus('Connecting to Deriv market data…');
    setLatestQuote('—');
    setLatestDigit('—');

    async function connectTicks() {
      if (disposed) return;
      const attempt = ++connectionAttempt;
      try {
        const accessToken = sessionStorage.getItem('deriv_access_token');
        const storedAccounts = sessionStorage.getItem('deriv_accounts');
        const accounts = storedAccounts ? JSON.parse(storedAccounts) as Array<{ account_id?: string; account_type?: string; status?: string }> : [];
        const account = accounts.find(item => item.account_type?.toLowerCase() === accountMode && item.account_id && item.status?.toLowerCase() !== 'disabled');
        if (!accessToken || !account?.account_id) {
          setTickStatus(`No ${accountMode} Options account is available for this login`);
          return;
        }
        setTickStatus('Requesting a fresh Deriv connection OTP…');
        const otpResponse = await api.post('/api/deriv/accounts/otp', {
          accessToken,
          accountId: account.account_id,
        });
        if (disposed || attempt !== connectionAttempt) return;
        const websocketUrl = otpResponse.data?.url;
        if (typeof websocketUrl !== 'string' || !websocketUrl.startsWith('wss://api.derivws.com/')) {
          throw new Error('Deriv returned an invalid WebSocket URL');
        }
        setTickStatus('Opening authenticated Deriv market feed…');
        // Use Deriv's one-time OTP URL exactly as returned; do not rebuild or modify it.
        socket = new WebSocket(websocketUrl);
        socket.onopen = () => {
          if (disposed || !socket) return;
          setTickStatus('Connected; subscribing to market ticks…');
          socket.send(JSON.stringify({ ticks: market, subscribe: 1, req_id: 11 }));
        };
        socket.onmessage = event => {
          if (disposed) return;
          try {
            const message = JSON.parse(String(event.data));
            if (message.error) {
              setTickStatus(`Deriv API error: ${message.error.message || message.error.code || 'Unknown error'}`);
              return;
            }
            if (message.msg_type === 'tick' && message.tick) {
              const quote = String(message.tick.quote);
              const digits = quote.match(/\d/g) || [];
              const digit = digits.length ? digits[digits.length - 1] : '—';
              setLatestQuote(quote);
              setLatestDigit(digit);
              setTickStatus('Receiving live ticks');
            }
          } catch {
            setTickStatus('Could not read market data response');
          }
        };
        socket.onerror = () => {
          if (!disposed) setTickStatus('WebSocket transport error — check network or browser connection');
        };
        socket.onclose = event => {
          if (disposed) return;
          setTickStatus(`Feed closed (code ${event.code}) — requesting a fresh OTP…`);
          reconnectTimer = setTimeout(() => { void connectTicks(); }, 4000);
        };
      } catch (connectionError) {
        if (!disposed && attempt === connectionAttempt) {
          const message = connectionError instanceof Error ? connectionError.message : 'Could not open authenticated market data connection';
          setTickStatus(`${message} — retrying with a fresh OTP…`);
          reconnectTimer = setTimeout(() => { void connectTicks(); }, 4000);
        }
      }
    }

    void connectTicks();
    return () => {
      disposed = true;
      connectionAttempt += 1;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [isDerivConnected, market]);

  return (
    <main className={!isDerivConnected ? 'shell login-shell' : 'shell'}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Zap size={22} fill="currentColor" />
          </div>
          <div>
            <div className="brand-name">
              CODE PULSE<span>BINARY</span>
            </div>
            <div className="brand-sub">DERIV STRATEGY CONSOLE</div>
          </div>
        </div>
        {isDerivConnected && <div className="top-actions">
          <div className="top-status">
            <span className="status-dot" /> CONNECTED
          </div>
          <button className="disconnect-button" onClick={disconnectFromDeriv} type="button" aria-label="Disconnect from Deriv">
            <LogOut size={15} strokeWidth={2} />
            <span>Disconnect</span>
          </button>
        </div>}
      </header>

      {!isDerivConnected && (
        <section className="panel connection-panel connection-only-panel">
          <div className="panel-heading">
            <div>
              <div className="section-kicker">ACCOUNT AUTHORISATION</div>
              <h2>Connect Deriv</h2>
            </div>

          </div>
          <p className="panel-intro">
            Connect your own Deriv account to continue. Your Deriv password is
            never requested by Code Pulse Binary.
          </p>
          <div className="strategy-row">
            <div className="strategy-icon">
              <ShieldCheck size={18} />
            </div>
            <div className="strategy-copy">
              <strong>Secure account authorisation</strong>
              <span>Sign in and approve access through Deriv</span>
            </div>
            <span className="tag muted">NOT CONNECTED</span>
          </div>
          <button className="primary-button" onClick={connectToDeriv} type="button">
            Connect my Deriv account <ArrowUpRight size={17} />
          </button>
          {notice && (
            <div className="notice" role="status">
              <CircleAlert size={16} />
              <span>{notice}</span>
            </div>
          )}
          <div className="secure-note">
            <LockKeyhole size={14} /> Never share your Deriv password or API token.
          </div>
        </section>
      )}

      {isDerivConnected && <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <Activity size={14} /> AUTOMATED STRATEGY WORKSPACE
          </div>
          <h1>Trade with a clearer view.</h1>
          <p>
            Connect your Deriv account, choose a volatility market, and manage
            your strategy from one private dashboard.
          </p>
          <div className="hero-pills">
            <span>
              <ShieldCheck size={14} /> Account authorisation
            </span>
            <span>
              <LockKeyhole size={14} /> Credentials stay private
            </span>
          </div>
        </div>
        <div className="hero-graphic" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="core">
            <Zap size={36} fill="currentColor" />
          </div>
          <div className="graphic-line line-one" />
          <div className="graphic-line line-two" />
          <div className="graphic-line line-three" />
        </div>
      </section>}

      {isDerivConnected && <section className="summary-grid">
        <article className="summary-card">
          <div className="card-icon">
            <Link2 size={18} />
          </div>
          <div className="summary-label">DERIV CONNECTION</div>
          <div className="summary-value">Connected</div>
          <div className="summary-foot">
            <span className="tiny-dot" /> Authorised for this session
          </div>
        </article>
        <article className="summary-card">
          <div className="card-icon">
            <ChartNoAxesCombined size={18} />
          </div>
          <div className="summary-label">STRATEGY ENGINE</div>
          <div className="summary-value">Standby</div>
          <div className="summary-foot">Trading is not active</div>
        </article>
        <article className="summary-card">
          <div className="card-icon">
            <ShieldCheck size={18} />
          </div>
          <div className="summary-label">ACCOUNT MODE</div>
          <div className="summary-value">
            {accountMode === 'demo' ? 'Demo account' : 'Real account'}
          </div>
          <div className="summary-foot">
            {accountMode === 'demo'
              ? 'Practice mode selected'
              : 'Live-risk mode selected'}
          </div>
        </article>
      </section>}

      {isDerivConnected && <section className="workspace-grid">
        <div className="right-column">
          <article className="panel">
            <div className="panel-heading">
              <div>
                <div className="section-kicker">MARKET SETTINGS</div>
                <h2>Market settings</h2>
              </div>
            </div>
            <label htmlFor="market">Synthetic volatility market</label>
            <select
              id="market"
              value={market}
              onChange={e => setMarket(e.target.value)}
            >
              <option value="1HZ90V">Volatility 90 (1s)</option>
              <option value="1HZ100V">Volatility 100 (1s)</option>
              <option value="1HZ50V">Volatility 50 (1s)</option>
              <option value="1HZ25V">Volatility 25 (1s)</option>
              <option value="R_100">Volatility 100</option>
              <option value="R_75">Volatility 75</option>
              <option value="R_50">Volatility 50</option>
              <option value="R_25">Volatility 25</option>
            </select>
            <label>Account type</label>
            <div className="mode-switch">
              <button
                className={accountMode === 'demo' ? 'mode active' : 'mode'}
                onClick={() => setAccountMode('demo')}
                type="button"
              >
                Demo
              </button>
              <button
                className={accountMode === 'real' ? 'mode active real' : 'mode'}
                onClick={() => setAccountMode('real')}
                type="button"
              >
                Real
              </button>
            </div>
            <div className="warning-note">
              <CircleAlert size={16} />
              <span>
                This feed is read-only. No orders are placed, and the strategy remains disabled while market data and strategy behaviour are tested.
              </span>
            </div>
            <div className="tick-monitor" aria-live="polite">
              <div className="panel-heading">
                <div>
                  <div className="section-kicker">LIVE MARKET DATA</div>
                  <h3>Volatility tick monitor</h3>
                </div>
                <span className="tag">READ ONLY</span>
              </div>
              <div className="strategy-row">
                <div className="strategy-copy">
                  <strong>{market === '1HZ100V' ? 'Volatility 100 (1s)' : market}</strong>
                  <span>{tickStatus}</span>
                </div>
              </div>
              <div className="summary-grid tick-summary-grid">
                <article className="summary-card">
                  <div className="summary-label">LATEST QUOTE</div>
                  <div className="summary-value">{latestQuote}</div>
                </article>
                <article className="summary-card">
                  <div className="summary-label">LAST DIGIT</div>
                  <div className="summary-value">{latestDigit}</div>
                </article>
              </div>
            </div>
          </article>

          <article className="panel strategy-panel">
            <div className="panel-heading">
              <div>
                <div className="section-kicker">STRATEGY CONTROL</div>
                <h2>Strategy control</h2>
              </div>
            </div>
            <div className="strategy-row">
              <div className="strategy-icon">
                <Activity size={18} />
              </div>
              <div className="strategy-copy">
                <strong>Tick pattern engine</strong>
                <span>Waiting for authorised market data</span>
              </div>
              <span className="tag">STANDBY</span>
            </div>
            <div className="strategy-row">
              <div className="strategy-icon">
                <ShieldCheck size={18} />
              </div>
              <div className="strategy-copy">
                <strong>Loss / stake controls</strong>
                <span>Risk limits must be configured</span>
              </div>
              <span className="tag muted">PENDING</span>
            </div>
            <button className="run-button" disabled>
              <Zap size={16} fill="currentColor" /> Run strategy
            </button>
            <p className="disabled-hint">
              Run unlocks only after account authorisation, risk limits, and
              strategy integration are verified.
            </p>
          </article>
        </div>
      </section>}
      <footer>
        <span>
          CODE PULSE BINARY <span className="footer-dot">•</span> PRIVATE DASHBOARD
        </span>
        <span>Your Deriv account access remains under your control.</span>
      </footer>
    </main>
  );
}

export default App;
