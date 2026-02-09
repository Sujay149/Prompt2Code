import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import axios from 'axios';

/* ──────────────────────────────────────────────
 *  Google OAuth 2.0 constants
 * ────────────────────────────────────────────── */
const GOOGLE_CLIENT_ID =
  '18843406677-rgpn7t8tfmsvjcbbibnit1u8mc0uma19.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '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';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const SCOPES = ['openid', 'email', 'profile'];

/* ──────────────────────────────────────────────
 *  Public types
 * ────────────────────────────────────────────── */
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
  private context: vscode.ExtensionContext;

  private _onDidChangeAuth = new vscode.EventEmitter<boolean>();
  readonly onDidChangeAuth = this._onDidChangeAuth.event;

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
    const state = crypto.randomBytes(16).toString('hex');

    return new Promise<UserInfo | null>((resolve) => {
      const server = http.createServer(async (req, res) => {
        if (!req.url || !req.url.startsWith('/callback')) {
          res.writeHead(404);
          res.end();
          return;
        }

        try {
          const url = new URL(req.url, `http://localhost:${actualPort}`);
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error || returnedState !== state || !code) {
            this.sendHtml(res, '❌ Authentication failed', 'You can close this tab and try again.');
            cleanup();
            resolve(null);
            return;
          }

          // Exchange authorization code for tokens
          const redirectUri = `http://localhost:${actualPort}/callback`;
          const tokenRes = await axios.post(
            GOOGLE_TOKEN_URL,
            new URLSearchParams({
              code,
              client_id: GOOGLE_CLIENT_ID,
              client_secret: GOOGLE_CLIENT_SECRET,
              redirect_uri: redirectUri,
              grant_type: 'authorization_code',
            }).toString(),
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

          this.sendHtml(
            res,
            `✅ Signed in as ${userInfo.name}`,
            'You can close this tab and return to VS Code.'
          );
          cleanup();
          this._onDidChangeAuth.fire(true);
          resolve(userInfo);
        } catch (err: unknown) {
          const error = err as { response?: { data: unknown }; message: string };
          console.error('Google OAuth token exchange failed:', error?.response?.data ?? error.message);
          this.sendHtml(res, '❌ Authentication error', 'Please close this tab and try again.');
          cleanup();
          resolve(null);
        }
      });

      const actualPort = 8080; // Fixed port for Google OAuth redirect

      const cleanup = () => {
        try { server.close(); } catch { /* already closed */ }
      };

      /* Listen on fixed port 8080 for OAuth redirect */
      server.listen(actualPort, () => {
        const redirectUri = `http://localhost:${actualPort}/callback`;
        const authUrl =
          `${GOOGLE_AUTH_URL}?` +
          new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: SCOPES.join(' '),
            state,
            access_type: 'offline',
            prompt: 'consent',
          }).toString();

        vscode.env.openExternal(vscode.Uri.parse(authUrl));
      });

      server.on('error', (err: { code?: string; message?: string }) => {
        console.error('Auth server error:', err);
        if (err.code === 'EADDRINUSE') {
          vscode.window.showErrorMessage('Port 8080 is already in use. Please close any app using that port and try again.');
        }
        cleanup();
        resolve(null);
      });

      // Timeout after 2 minutes
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 120_000);
    });
  }

  /* ── Sign-out ── */

  async signOut(): Promise<void> {
    await this.context.secrets.delete('prompt2code.googleAccessToken');
    await this.context.secrets.delete('prompt2code.googleRefreshToken');
    await this.context.globalState.update('prompt2code.googleUserInfo', undefined);
    this._onDidChangeAuth.fire(false);
  }

  /* ── Token refresh (best-effort) ── */

  async refreshAccessToken(): Promise<string | null> {
    const refreshToken = await this.context.secrets.get('prompt2code.googleRefreshToken');
    if (!refreshToken) { return null; }

    try {
      const res = await axios.post(
        GOOGLE_TOKEN_URL,
        new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const newToken: string = res.data.access_token;
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
