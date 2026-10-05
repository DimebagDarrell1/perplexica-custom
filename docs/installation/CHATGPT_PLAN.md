# Use your ChatGPT plan

Perplexica can send answer, research-planning and classifier requests through
the usage included in your ChatGPT plan instead of OpenAI API credits. It uses
OpenAI's [Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source).
OpenAI calls this a preview, and eligibility depends on your plan and workspace.

Embeddings are not part of the plan. Keep your current embedding provider
(for example OpenRouter or OpenAI). Jev and Firecrawl keep their own settings.

## Sign in

1. Open **Settings → Models**. The **Use your ChatGPT plan** panel sits above
   your connections.
2. Choose **Continue with ChatGPT**. A ChatGPT sign-in tab opens. If your
   browser blocks it, use the link in the panel.
3. Sign in, keep the name **Perplexica** (or edit it), and approve plan use.
4. The tab then goes to `http://127.0.0.1:1459/auth/callback?...` and shows a
   "can't connect" error. That is expected: OpenAI only allows callbacks to
   `127.0.0.1`, and Perplexica runs on your server, not on the computer with
   the browser.
5. Copy the full address from that tab, paste it into the panel and choose
   **Finish sign-in**. Do this within 15 minutes, and before restarting the
   server.
6. Choose **Got it**. The page reloads, and the model picker lists your plan's
   models under **ChatGPT plan**.

The pasted address contains a one-time code. It only works together with a
secret the server kept for that attempt, and it cannot be reused.

## What is stored

The server keeps one file, `data/chatgpt-plan.json`, with owner-only
permissions. It holds this server's host ID, the client ID OpenAI issued at
registration, your account email, and the access, refresh and ID tokens.
Tokens never go to the browser or into `config.json`. Back up and protect the
data directory as you would an API key.

Access tokens last an hour and renew automatically. If renewal is refused,
Perplexica clears the tokens and asks you to sign in again; the registration
and host ID stay, so the next sign-in skips registration.

**Sign out** asks OpenAI to revoke the session, then clears the tokens. If
OpenAI does not confirm, the panel says so; you can also disconnect Perplexica
in ChatGPT settings.

## Usage and limits

Plan requests count toward your ChatGPT plan. On Plus, the five-hour limit is
shared with every other app using your plan. Review or limit Perplexica's use
at [ChatGPT settings → Usage](https://chatgpt.com/settings/usage). The model
picker shows **Using ChatGPT plan** and a **Manage usage** link when a plan
model is selected.

Perplexica never switches to a paid API key when the plan refuses a request.
You get a message instead, for example when the usage limit is reached.

Plan requests use the Responses API with `store: false` and streaming, as
OpenAI requires. They cannot set temperature or output-length limits, so those
model options are ignored for plan models.

## Status

The sign-in flow and request format follow OpenAI's documentation and are
covered by tests with mocked OpenAI responses. OpenAI accepted the sign-in
request and showed its login page in a browser check. A real sign-in and plan
answer had not been run when this was written, because that needs your
account.
