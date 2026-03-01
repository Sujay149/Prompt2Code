import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

/* ──────────────────────────────────────────────
 * Google OAuth 2.0 constants (PKCE flow — no secret required)
 * ────────────────────────────────────────────── */
const GOOGLE_CLIENT_ID = '820264138125-3nqs28rdd1riavsu38li2iafoef5utdd.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const SCOPES = ['openid', 'email', 'profile'];

/* ── PKCE helpers ── */
function generateCodeVerifier(): string {
  return crypto.randomBytes(48).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export interface UserInfo {
  id: string;
  email: string;
  name: string;
  picture: string;
}

/* ──────────────────────────────────────────────
 *  GoogleAuthProvider
 *  – Handles the full OAuth 2.0 authorization-code
 *    flow using a disposable localhost redirect.
 *  – Persists tokens in VS Code SecretStorage and
 *    user info in globalState.
 * ────────────────────────────────────────────── */
export class GoogleAuthProvider {
  private readonly context: vscode.ExtensionContext;
  private readonly _onDidChangeAuth = new vscode.EventEmitter<boolean>();
  public readonly onDidChangeAuth = this._onDidChangeAuth.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /* ── Query helpers ── */
  async isAuthenticated(): Promise<boolean> {
    const token = await this.context.secrets.get('prompt2code.googleAccessToken');
    return !!token;
  }

  async getUserInfo(): Promise<UserInfo | null> {
    return this.context.globalState.get<UserInfo>('prompt2code.googleUserInfo') ?? null;
  }

  async getAccessToken(): Promise<string | undefined> {
    return this.context.secrets.get('prompt2code.googleAccessToken');
  }

  /* ── Sign-in ── */
  async signIn(): Promise<UserInfo | null> {
    // Always use hardcoded client ID for all users

    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Try to find an available port from a range
    const PORT_RANGE = [8080, 8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089, 8090];

    return new Promise<UserInfo | null>((resolve) => {
      const server = http.createServer(async (req, res) => {
        if (!req.url || !req.url.startsWith('/callback')) {
          res.writeHead(404);
          res.end();
          return;
        }

        try {
          const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error || returnedState !== state || !code) {
            const reason = error || (returnedState !== state ? 'state mismatch' : 'missing code');
            console.error('OAuth callback error:', reason);
            this.sendHtml(res, '❌ Authentication failed', `Reason: ${reason}. You can close this tab and try again.`);
            cleanup();
            resolve(null);
            return;
          }

          // Exchange authorization code for tokens using PKCE (no client_secret needed for native apps)
          const redirectUri = `http://127.0.0.1:${boundPort}/callback`;
          const tokenRes = await axios.post(
            GOOGLE_TOKEN_URL,
            (() => {
              const params = new URLSearchParams({
                code,
                client_id: GOOGLE_CLIENT_ID,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
                code_verifier: codeVerifier,
              });
              if (GOOGLE_CLIENT_SECRET) {
                params.append('client_secret', GOOGLE_CLIENT_SECRET);
              }
              return params.toString();
            })(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
          );

          const { access_token, refresh_token } = tokenRes.data;

          // Fetch user profile
          const profileRes = await axios.get(GOOGLE_USERINFO_URL, {
            headers: { Authorization: `Bearer ${access_token}` },
          });

          const userInfo: UserInfo = {
            id: profileRes.data.id,
            email: profileRes.data.email,
            name: profileRes.data.name,
            picture: profileRes.data.picture,
          };

          // Persist
          await this.context.secrets.store('prompt2code.googleAccessToken', access_token);
          if (refresh_token) {
            await this.context.secrets.store('prompt2code.googleRefreshToken', refresh_token);
          }
          await this.context.globalState.update('prompt2code.googleUserInfo', userInfo);

          this.sendHtml(res, `✅ Signed in as ${userInfo.name}`, 'You can close this tab and return to VS Code.');
          cleanup();
          this._onDidChangeAuth.fire(true);
          resolve(userInfo);
        } catch (err: unknown) {
          let errorMsg = '';
          if (typeof err === 'object' && err !== null && 'response' in err) {
            const e = err as { response?: { data?: string }; message?: string };
            errorMsg = e.response?.data ?? e.message ?? String(err);
          } else if (err instanceof Error) {
            errorMsg = err.message;
          } else {
            errorMsg = String(err);
          }
          console.error('Google OAuth token exchange failed:', errorMsg);
          this.sendHtml(res, '❌ Authentication error', 'Please close this tab and try again.');
          cleanup();
          resolve(null);
        }
      });

      let boundPort = 0;
      // eslint-disable-next-line prefer-const
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
        }
        try {
          server.close();
        } catch {
          /* already closed */
        }
      };

      /**
       * Try to listen on ports from PORT_RANGE sequentially.
       * Google treats 127.0.0.1 as a special loopback address for OAuth
       * (no need to pre-register each port in the console for native/desktop apps).
       */
      const tryListen = (portIndex: number) => {
        if (portIndex >= PORT_RANGE.length) {
          vscode.window.showErrorMessage(
            'Sign-in failed: Could not find an available port (tried 8080–8090). Please close applications using those ports and try again.'
          );
          cleanup();
          resolve(null);
          return;
        }

        const port = PORT_RANGE[portIndex];
        // Remove any previous error listener so it doesn't fire for old attempts
        server.removeAllListeners('error');
        server.once('error', (err: unknown) => {
          let errorMsg = '';
          if (typeof err === 'object' && err !== null && 'code' in err) {
            const e = err as { code?: string; message?: string };
            errorMsg = e.code ?? e.message ?? String(err);
          } else if (err instanceof Error) {
            errorMsg = err.message;
          } else {
            errorMsg = String(err);
          }
          console.warn(`Auth server: port ${port} failed (${errorMsg}), trying next…`);
          if (portIndex + 1 < PORT_RANGE.length) {
            tryListen(portIndex + 1);
          } else {
            vscode.window.showErrorMessage('Sign-in failed: All ports 8080–8090 are in use. Please free one and try again.');
            cleanup();
            resolve(null);
          }
        });

        server.listen(port, '127.0.0.1', () => {
          boundPort = port;
          console.log(`🔐 Auth server listening on 127.0.0.1:${port}`);
          vscode.window.showInformationMessage(`🔐 Auth server ready on port ${port} — opening browser…`);
          const redirectUri = `http://127.0.0.1:${port}/callback`;
          const authUrl = `${GOOGLE_AUTH_URL}?` +
            new URLSearchParams({
              client_id: GOOGLE_CLIENT_ID,
              redirect_uri: redirectUri,
              response_type: 'code',
              scope: SCOPES.join(' '),
              state,
              access_type: 'offline',
              prompt: 'consent',
              code_challenge: codeChallenge,
              code_challenge_method: 'S256',
            }).toString();
          vscode.env.openExternal(vscode.Uri.parse(authUrl));
        });
      };

      // Start trying ports
      tryListen(0);

      // Timeout after 3 minutes
      timer = setTimeout(() => {
        vscode.window.showWarningMessage('Google Sign-In timed out. Please try again.');
        cleanup();
        resolve(null);
      }, 180000);
    });
  }

  /* ── Sign-out ── */
  async signOut(): Promise<void> {
    // Revoke the token with Google for security
    const accessToken = await this.context.secrets.get('prompt2code.googleAccessToken');
    if (accessToken) {
      try {
        await axios.post('https://oauth2.googleapis.com/revoke', null, {
          params: { token: accessToken },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
      } catch (err) {
        console.warn('Failed to revoke token with Google:', err);
        // Continue with local cleanup even if revocation fails
      }
    }

    // Clear local storage
    await this.context.secrets.delete('prompt2code.googleAccessToken');
    await this.context.secrets.delete('prompt2code.googleRefreshToken');
    await this.context.globalState.update('prompt2code.googleUserInfo', undefined);
    this._onDidChangeAuth.fire(false);
  }

  /* ── Token refresh (best-effort) ── */
  async refreshAccessToken(): Promise<string | null> {
    const refreshToken = await this.context.secrets.get('prompt2code.googleRefreshToken');
    if (!refreshToken) {
      return null;
    }

    try {
      const res = await axios.post(
        GOOGLE_TOKEN_URL,
        (() => {
          const params = new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
          });
          if (GOOGLE_CLIENT_SECRET) {
            params.append('client_secret', GOOGLE_CLIENT_SECRET);
          }
          return params.toString();
        })(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const newToken = res.data.access_token;
      await this.context.secrets.store('prompt2code.googleAccessToken', newToken);
      return newToken;
    } catch {
      // Refresh token revoked or expired — force re-login
      await this.signOut();
      return null;
    }
  }

  /* ── Helpers ── */
  private sendHtml(res: http.ServerResponse, title: string, subtitle: string) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>Prompt2Code</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1e1e1e;color:#d4d4d4;">
  <div style="text-align:center">
    <h2 style="margin-bottom:8px">${title}</h2>
    <p style="opacity:0.7">${subtitle}</p>
  </div>
</body></html>`);
  }
}
