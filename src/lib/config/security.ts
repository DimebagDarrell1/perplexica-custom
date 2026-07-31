import { timingSafeEqual } from 'node:crypto';
import type { Config, ConfigModelProvider, UIConfigSections } from './types';

export const REDACTED_SECRET = '********';

const tokensMatch = (provided: string, expected: string): boolean => {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
};

export const requireAdminToken = (request: Request): Response | null => {
  const expected = process.env.PERPLEXICA_ADMIN_TOKEN;
  if (!expected) return null;

  const authorization = request.headers.get('authorization') || '';
  const provided = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';

  if (provided && tokensMatch(provided, expected)) return null;

  return Response.json(
    { message: 'A valid admin bearer token is required.' },
    { status: 401 },
  );
};

const redactProvider = (
  provider: ConfigModelProvider,
  sections: UIConfigSections,
): ConfigModelProvider => {
  const providerSection = sections.modelProviders.find(
    (section) => section.key === provider.type,
  );
  const passwordKeys = new Set(
    providerSection?.fields
      .filter((field) => field.type === 'password')
      .map((field) => field.key) || [],
  );

  return {
    ...provider,
    config: Object.fromEntries(
      Object.entries(provider.config).map(([key, value]) => [
        key,
        passwordKeys.has(key) && value ? REDACTED_SECRET : value,
      ]),
    ),
  };
};

export const redactConfigSecrets = (
  config: Config,
  sections: UIConfigSections,
): Config => ({
  ...config,
  modelProviders: config.modelProviders.map((provider) =>
    redactProvider(provider, sections),
  ),
});

export const redactModelProvider = (
  provider: ConfigModelProvider,
  sections: UIConfigSections,
) => redactProvider(provider, sections);

export const isKnownServerConfigKey = (
  key: string,
  sections: UIConfigSections,
): boolean =>
  [
    ...sections.preferences.map((field) => ({ section: 'preferences', field })),
    ...sections.personalization.map((field) => ({
      section: 'personalization',
      field,
    })),
    ...sections.search.map((field) => ({ section: 'search', field })),
  ].some(
    ({ section, field }) =>
      field.scope === 'server' && key === `${section}.${field.key}`,
  );

export const preserveRedactedSecrets = (
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(next).map(([key, value]) => [
      key,
      value === REDACTED_SECRET ? previous[key] : value,
    ]),
  );
