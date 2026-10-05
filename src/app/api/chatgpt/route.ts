import configManager from '@/lib/config';
import { requireAdminToken } from '@/lib/config/security';
import {
  ChatGPTAuthError,
  completeSignIn,
  getStatus,
  signOut,
  startSignIn,
} from '@/lib/chatgpt/auth';
import { clearChatGPTModelCache } from '@/lib/models/providers/chatgpt';

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

// Sign-in creates the connection. Providers with no settings share one
// config hash, so start-up cannot add this one automatically.
const ensureProvider = () => {
  const providers = configManager.getCurrentConfig().modelProviders;
  if (!providers.some((provider) => provider.type === 'chatgpt')) {
    configManager.addModelProvider('chatgpt', 'ChatGPT plan', {});
  }
};

const failure = (error: unknown) => {
  if (error instanceof ChatGPTAuthError) {
    return Response.json(
      { message: error.message, code: error.code },
      { status: 400, headers: noStore },
    );
  }
  console.error('ChatGPT sign-in error:', error);
  return Response.json(
    { message: 'ChatGPT sign-in failed. Check the server logs.' },
    { status: 500, headers: noStore },
  );
};

/** Account status only; tokens never leave the server. */
export const GET = async (request: Request) => {
  const unauthorized = requireAdminToken(request);
  if (unauthorized) return unauthorized;
  try {
    const status = getStatus();
    if (status.signedIn) ensureProvider();
    return Response.json(status, { headers: noStore });
  } catch (error) {
    return failure(error);
  }
};

export const POST = async (request: Request) => {
  const unauthorized = requireAdminToken(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.action === 'start') {
      return Response.json(
        startSignIn({
          newAccount: body.newAccount === true,
          requestConsent: body.requestConsent === true,
        }),
        { headers: noStore },
      );
    }
    if (body?.action === 'complete') {
      const status = await completeSignIn(String(body.callbackUrl ?? ''));
      clearChatGPTModelCache();
      if (status.signedIn) ensureProvider();
      return Response.json(status, { headers: noStore });
    }
    return Response.json(
      { message: 'Unknown action.' },
      { status: 400, headers: noStore },
    );
  } catch (error) {
    return failure(error);
  }
};

export const DELETE = async (request: Request) => {
  const unauthorized = requireAdminToken(request);
  if (unauthorized) return unauthorized;
  try {
    const result = await signOut();
    clearChatGPTModelCache();
    return Response.json({ ...result, ...getStatus() }, { headers: noStore });
  } catch (error) {
    return failure(error);
  }
};
