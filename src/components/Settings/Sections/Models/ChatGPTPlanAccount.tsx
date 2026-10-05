import { ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

type Status = {
  signedIn: boolean;
  email?: string;
  planEnabled: boolean;
  registered: boolean;
  redirectUri: string;
  usageUrl: string;
};

const button =
  'px-3 py-2 rounded-lg text-xs font-medium active:scale-95 transition duration-200 disabled:opacity-60 disabled:active:scale-100';
const secondaryButton = `${button} border border-light-200 dark:border-dark-200 text-black dark:text-white bg-light-secondary/50 dark:bg-dark-secondary/50 hover:bg-light-secondary hover:dark:bg-dark-secondary`;

const request = async (method: string, body?: unknown) => {
  const res = await fetch('/api/chatgpt', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Request failed.');
  return data;
};

/**
 * Sign in with ChatGPT so answers can use the plan's included usage.
 * The callback goes to 127.0.0.1 on the browser's machine, which this
 * server cannot receive, so the user pastes that address back here.
 */
const ChatGPTPlanAccount = () => {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [awaitingPaste, setAwaitingPaste] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [authorizeUrl, setAuthorizeUrl] = useState('');
  const [welcome, setWelcome] = useState(false);
  const inputId = useId();

  useEffect(() => {
    request('GET')
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const start = async (options: Record<string, boolean> = {}) => {
    setBusy(true);
    try {
      const { authorizeUrl } = await request('POST', {
        action: 'start',
        ...options,
      });
      setAuthorizeUrl(authorizeUrl);
      // Some browsers block this after an await; the link below covers that.
      window.open(authorizeUrl, '_blank', 'noopener');
      setCallbackUrl('');
      setAwaitingPaste(true);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      const next: Status = await request('POST', {
        action: 'complete',
        callbackUrl,
      });
      setStatus(next);
      setAwaitingPaste(false);
      setCallbackUrl('');
      if (next.planEnabled) setWelcome(true);
      else toast.message('Signed in, but ChatGPT plan use was not approved.');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      const result = await request('DELETE');
      setStatus(result);
      if (!result.revoked)
        toast.message(
          'Signed out here. OpenAI did not confirm revocation; you can disconnect Perplexica in ChatGPT settings.',
        );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;

  const manageUsage = (
    <a
      href={status.usageUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-accent dark:text-accent-dark hover:underline"
    >
      Manage usage
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );

  return (
    <section
      aria-labelledby={`${inputId}-title`}
      className="rounded-lg border border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary px-5 py-4 flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <h4
          id={`${inputId}-title`}
          className="text-sm font-medium text-black dark:text-white"
        >
          Use your ChatGPT plan
        </h4>
        <p className="text-xs text-black/60 dark:text-white/60">
          Answers can run on the usage included in your ChatGPT plan instead of
          API credits. Embeddings, Jev and Firecrawl still use their own
          settings.
        </p>
      </div>

      {welcome ? (
        <div
          role="status"
          className="rounded-lg bg-light-secondary dark:bg-dark-secondary px-4 py-3 flex flex-col gap-2"
        >
          <p className="text-sm font-medium text-black dark:text-white">
            You&apos;re using your ChatGPT plan
          </p>
          <p className="text-xs text-black/60 dark:text-white/60">
            Choose a ChatGPT plan model in the model picker. Its requests count
            toward your plan, which you can manage in ChatGPT settings.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={`${button} bg-black text-white dark:bg-white dark:text-black`}
              onClick={() => window.location.reload()}
            >
              Got it
            </button>
            {manageUsage}
          </div>
        </div>
      ) : status.signedIn ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-black/80 dark:text-white/80">
            Signed in as{' '}
            <span className="font-medium">
              {status.email || 'ChatGPT user'}
            </span>
          </p>
          {status.planEnabled ? (
            <p className="flex flex-wrap items-center gap-3 text-xs text-black/70 dark:text-white/70">
              <span>Using ChatGPT plan</span>
              {manageUsage}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-black/70 dark:text-white/70">
                ChatGPT plan use was not approved, so no plan models are
                available.
              </p>
              <button
                type="button"
                disabled={busy}
                className={`${button} self-start bg-black text-white dark:bg-white dark:text-black`}
                onClick={() => start({ requestConsent: true })}
              >
                Enable ChatGPT plan use
              </button>
            </div>
          )}
          <button
            type="button"
            disabled={busy}
            className={`${secondaryButton} self-start`}
            onClick={signOut}
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            className={`${button} bg-black text-white dark:bg-white dark:text-black inline-flex items-center gap-2`}
            onClick={() => start()}
          >
            {busy && !awaitingPaste && (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            )}
            Continue with ChatGPT
          </button>
          {status.registered && (
            <button
              type="button"
              disabled={busy}
              className="text-xs text-black/60 dark:text-white/60 hover:underline"
              onClick={() => start({ newAccount: true })}
            >
              Use a different account
            </button>
          )}
        </div>
      )}

      {awaitingPaste && !welcome && (
        <div className="flex flex-col gap-2 border-t border-light-200 dark:border-dark-200 pt-3">
          <ol className="list-decimal pl-4 text-xs text-black/70 dark:text-white/70 space-y-1">
            <li>
              Approve Perplexica in the tab that opened. If no tab opened,{' '}
              <a
                href={authorizeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent dark:text-accent-dark hover:underline"
              >
                open the ChatGPT sign-in page
              </a>
              .
            </li>
            <li>
              The tab then lands on a page at{' '}
              <code className="text-[11px]">127.0.0.1</code> that cannot load.
              That is expected.
            </li>
            <li>Copy the full address from that tab and paste it below.</li>
          </ol>
          <label
            htmlFor={inputId}
            className="text-xs font-medium text-black/80 dark:text-white/80"
          >
            Address from the page that failed to load
          </label>
          <input
            id={inputId}
            value={callbackUrl}
            onChange={(event) => setCallbackUrl(event.target.value)}
            placeholder={`${status.redirectUri}?code=…`}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary px-3 py-2 text-xs text-black/80 dark:text-white/80 placeholder:text-black/40 dark:placeholder:text-white/40 focus-visible:outline-none focus-visible:border-light-300 dark:focus-visible:border-dark-300"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || !callbackUrl.trim()}
              className={`${button} bg-black text-white dark:bg-white dark:text-black inline-flex items-center gap-2`}
              onClick={finish}
            >
              {busy && (
                <Loader2
                  size={14}
                  className="animate-spin"
                  aria-hidden="true"
                />
              )}
              Finish sign-in
            </button>
            <button
              type="button"
              disabled={busy}
              className="text-xs text-black/60 dark:text-white/60 hover:underline"
              onClick={() => setAwaitingPaste(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
};

export default ChatGPTPlanAccount;
