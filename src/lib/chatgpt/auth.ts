import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Sign in with ChatGPT for plan usage, following OpenAI's open-source app
 * flow: dynamic client registration, PKCE and a 127.0.0.1 callback.
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 *
 * This server usually runs on another machine than the browser, so the
 * callback page will not load. The user pastes its address back into
 * Settings and the server finishes the exchange with the verifier it kept.
 */

export const ISSUER = 'https://auth.openai.com';
export const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
export const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
export const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
export const RESOURCE = 'https://api.openai.com/v1';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
export const REDIRECT_URI = 'http://127.0.0.1:1459/auth/callback';
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
const REGISTRATION_CLIENT_ID = 'dynamic_agent_client';
const AGENT_NAME = 'Perplexica';
const PENDING_TTL_MS = 15 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export type ChatGPTAccount = {
  hostId: string;
  clientId?: string;
  subject?: string;
  email?: string;
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  earliestRefreshAt?: number;
  scopes?: string[];
  savedAt?: string;
};

export type ChatGPTStatus = {
  signedIn: boolean;
  email?: string;
  planEnabled: boolean;
  registered: boolean;
  redirectUri: string;
  usageUrl: string;
};

export class ChatGPTAuthError extends Error {
  readonly code: string;
  readonly signInRequired: boolean;

  constructor(message: string, code: string, signInRequired = false) {
    super(message);
    this.code = code;
    this.signInRequired = signInRequired;
  }
}

type PendingAttempt = {
  verifier: string;
  nonce: string;
  clientId: string;
  registration: boolean;
  createdAt: number;
};

const pending: Map<string, PendingAttempt> =
  (globalThis as any).__chatgptPendingSignIns ?? new Map();
(globalThis as any).__chatgptPendingSignIns = pending;

const accountPath = () =>
  path.join(process.env.DATA_DIR || process.cwd(), 'data', 'chatgpt-plan.json');

const writeAccount = (account: ChatGPTAccount) => {
  const target = accountPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(account, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
};

/** Loads the saved record, creating this host's stable ID on first use. */
export const readAccount = (): ChatGPTAccount => {
  const target = accountPath();
  if (fs.existsSync(target)) {
    const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (typeof saved?.hostId === 'string' && saved.hostId) return saved;
  }
  const account = { hostId: `urn:uuid:${crypto.randomUUID()}` };
  writeAccount(account);
  return account;
};

const base64url = (buffer: Buffer) => buffer.toString('base64url');

const isPlanEnabled = (account: ChatGPTAccount) =>
  account.scopes?.includes(PLAN_SCOPE) === true;

export const getStatus = (): ChatGPTStatus => {
  const account = readAccount();
  return {
    signedIn: !!account.accessToken && !!account.refreshToken,
    email: account.email,
    planEnabled: isPlanEnabled(account),
    registered: !!account.clientId,
    redirectUri: REDIRECT_URI,
    usageUrl: USAGE_URL,
  };
};

/**
 * Builds the authorization URL. A saved registration is reused unless the
 * user asks for a different account, which registers a new client.
 */
export const startSignIn = (
  options: { newAccount?: boolean; requestConsent?: boolean } = {},
) => {
  const account = readAccount();
  const now = Date.now();
  for (const [state, attempt] of pending) {
    if (now - attempt.createdAt > PENDING_TTL_MS) pending.delete(state);
  }

  const registration = options.newAccount || !account.clientId;
  const clientId = registration ? REGISTRATION_CLIENT_ID : account.clientId!;
  const verifier = base64url(crypto.randomBytes(48));
  const state = base64url(crypto.randomBytes(24));
  const nonce = base64url(crypto.randomBytes(24));
  pending.set(state, {
    verifier,
    nonce,
    clientId,
    registration,
    createdAt: now,
  });
  while (pending.size > 20) pending.delete(pending.keys().next().value!);

  const url = new URL(AUTHORIZE_URL);
  const params: Record<string, string> = {
    client_id: clientId,
    ext_agent_host_id: account.hostId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: base64url(
      crypto.createHash('sha256').update(verifier).digest(),
    ),
  };
  if (registration) params.agent_name_hint = AGENT_NAME;
  else {
    if (account.idToken) params.id_token_hint = account.idToken;
    if (account.email) params.login_hint = account.email;
  }
  if (options.requestConsent) params.prompt = 'consent';
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  return { authorizeUrl: url.toString(), redirectUri: REDIRECT_URI };
};

const postForm = async (
  url: string,
  form: Record<string, string>,
): Promise<{ status: number; body: any }> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { detail: text.slice(0, 300) };
  }
  return { status: response.status, body };
};

let jwksCache: { keys: any[]; fetchedAt: number } | undefined;

const getSigningKey = async (kid: string | undefined) => {
  const find = () =>
    jwksCache?.keys.find((key) => !kid || key.kid === kid) as any;
  if (!jwksCache || Date.now() - jwksCache.fetchedAt > 3_600_000 || !find()) {
    const response = await fetch(JWKS_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new ChatGPTAuthError(
        'Could not load OpenAI signing keys.',
        'jwks_unavailable',
      );
    const body = await response.json();
    jwksCache = {
      keys: Array.isArray(body?.keys) ? body.keys : [],
      fetchedAt: Date.now(),
    };
  }
  const jwk = find();
  if (!jwk)
    throw new ChatGPTAuthError(
      'The ID token was signed with an unknown key.',
      'invalid_id_token',
    );
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
};

/** Verifies an RS256 ID token's signature, issuer, audience, expiry and nonce. */
export const verifyIdToken = async (
  idToken: string,
  expected: { clientId: string; nonce: string },
) => {
  const invalid = (detail: string) =>
    new ChatGPTAuthError(
      `OpenAI returned an ID token that failed validation (${detail}).`,
      'invalid_id_token',
    );
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw invalid('format');
  const [encodedHeader, encodedPayload, signature] = parts;
  let header: any;
  let claims: any;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString());
    claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
  } catch {
    throw invalid('encoding');
  }
  if (header.alg !== 'RS256') throw invalid('algorithm');
  const key = await getSigningKey(header.kid);
  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    key,
    Buffer.from(signature, 'base64url'),
  );
  if (!valid) throw invalid('signature');
  if (claims.iss !== ISSUER) throw invalid('issuer');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(expected.clientId)) throw invalid('audience');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() - 60_000)
    throw invalid('expired');
  if (claims.nonce !== expected.nonce) throw invalid('nonce');
  if (typeof claims.sub !== 'string' || !claims.sub) throw invalid('subject');
  return claims as { sub: string; email?: string };
};

const toMillis = (value: unknown) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return number > 1e12 ? number : number * 1000;
};

const tokenFields = (body: any, now: number) => ({
  accessToken: String(body.access_token),
  refreshToken: String(body.refresh_token),
  expiresAt: now + Math.max(60, Number(body.expires_in) || 3600) * 1000,
  earliestRefreshAt: toMillis(body.earliest_refresh_at),
  scopes: String(body.scope || '')
    .split(/\s+/)
    .filter(Boolean),
  savedAt: new Date(now).toISOString(),
});

const oauthError = (body: any) =>
  String(body?.error || body?.code || body?.detail || 'unknown_error');

/**
 * Finishes sign-in from the pasted callback address (or its query string).
 * The code only works with the verifier this server kept for the attempt.
 */
export const completeSignIn = async (callback: string) => {
  const trimmed = String(callback || '').trim();
  let params: URLSearchParams;
  try {
    params = trimmed.includes('?')
      ? new URL(trimmed, REDIRECT_URI).searchParams
      : new URLSearchParams(trimmed);
  } catch {
    throw new ChatGPTAuthError(
      'Paste the full address from the page that failed to load.',
      'invalid_callback',
    );
  }
  const state = params.get('state') || '';
  const attempt = pending.get(state);
  if (!attempt || Date.now() - attempt.createdAt > PENDING_TTL_MS) {
    pending.delete(state);
    throw new ChatGPTAuthError(
      'This sign-in link expired or was already used. Choose Continue with ChatGPT again.',
      'unknown_state',
    );
  }
  pending.delete(state);

  const error = params.get('error');
  if (error) {
    throw new ChatGPTAuthError(
      error === 'access_denied'
        ? 'Sign-in was cancelled, so ChatGPT plan use is not enabled.'
        : `ChatGPT sign-in failed: ${error}.`,
      error,
    );
  }
  const code = params.get('code');
  if (!code)
    throw new ChatGPTAuthError(
      'The pasted address has no authorization code.',
      'invalid_callback',
    );

  const returnedClientId = params.get('client_id');
  let clientId = attempt.clientId;
  if (attempt.registration) {
    if (!returnedClientId || returnedClientId === REGISTRATION_CLIENT_ID)
      throw new ChatGPTAuthError(
        'Registration did not finish because OpenAI returned no client ID. Try again.',
        'registration_incomplete',
      );
    clientId = returnedClientId;
  } else if (returnedClientId && returnedClientId !== attempt.clientId) {
    throw new ChatGPTAuthError(
      'OpenAI returned a different client than this account uses. Try again.',
      'client_mismatch',
    );
  }

  const now = Date.now();
  const { status, body } = await postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: attempt.verifier,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
  });
  if (status !== 200 || !body.access_token || !body.refresh_token) {
    throw new ChatGPTAuthError(
      `OpenAI did not accept the sign-in code (${oauthError(body)}). Choose Continue with ChatGPT again.`,
      oauthError(body),
    );
  }
  const claims = await verifyIdToken(body.id_token, {
    clientId,
    nonce: attempt.nonce,
  });

  const account = readAccount();
  if (
    !attempt.registration &&
    account.subject &&
    account.subject !== claims.sub
  ) {
    throw new ChatGPTAuthError(
      'You signed in with a different ChatGPT account. Use "Use a different account" instead.',
      'account_mismatch',
    );
  }

  const next: ChatGPTAccount = {
    hostId: account.hostId,
    clientId,
    subject: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : account.email,
    idToken: String(body.id_token),
    ...tokenFields(body, now),
  };
  writeAccount(next);
  return getStatus();
};

const UNUSABLE_REFRESH = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

const clearTokens = (account: ChatGPTAccount): ChatGPTAccount => ({
  hostId: account.hostId,
  clientId: account.clientId,
  subject: account.subject,
  email: account.email,
});

let refreshing: Promise<ChatGPTAccount> | undefined;

const refreshAccount = async (account: ChatGPTAccount) => {
  const now = Date.now();
  const { status, body } = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: account.clientId!,
    refresh_token: account.refreshToken!,
    resource: RESOURCE,
  });
  if (status === 200 && body.access_token && body.refresh_token) {
    const next = { ...account, ...tokenFields(body, now) };
    writeAccount(next);
    return next;
  }
  const code = oauthError(body);
  if (UNUSABLE_REFRESH.has(code)) {
    writeAccount(clearTokens(account));
    throw new ChatGPTAuthError(
      'Your ChatGPT sign-in has ended. Sign in again in Settings → Models.',
      code,
      true,
    );
  }
  // Network and server failures keep the saved credentials.
  throw new ChatGPTAuthError(
    `Could not renew the ChatGPT sign-in (${code}). Try again shortly.`,
    code,
  );
};

/** Returns a current access token, renewing it near expiry. */
export const getAccessToken = async (): Promise<string> => {
  let account = readAccount();
  if (!account.accessToken || !account.refreshToken || !account.clientId) {
    throw new ChatGPTAuthError(
      'Sign in with ChatGPT in Settings → Models to use your plan.',
      'not_signed_in',
      true,
    );
  }
  if (!isPlanEnabled(account)) {
    throw new ChatGPTAuthError(
      'ChatGPT plan use was not approved for Perplexica. Enable it in Settings → Models.',
      'plan_not_enabled',
      true,
    );
  }
  const now = Date.now();
  const expiresAt = account.expiresAt ?? 0;
  const dueForRefresh =
    now >= expiresAt ||
    (expiresAt - now < REFRESH_MARGIN_MS &&
      now >= (account.earliestRefreshAt ?? 0));
  if (dueForRefresh) {
    refreshing ??= refreshAccount(account).finally(() => {
      refreshing = undefined;
    });
    account = await refreshing;
  }
  return account.accessToken!;
};

/** Revokes the renewable session, then clears tokens but keeps the registration. */
export const signOut = async () => {
  const account = readAccount();
  let revoked = !account.refreshToken;
  if (account.refreshToken && account.clientId) {
    for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
      try {
        const { status } = await postForm(REVOKE_URL, {
          token: account.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: account.clientId,
        });
        revoked = status === 200;
        if (status < 500) break;
      } catch {
        // Retry network failures below.
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  writeAccount(clearTokens(account));
  return { revoked };
};
