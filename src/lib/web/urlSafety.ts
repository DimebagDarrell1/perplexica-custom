import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const unsafeHostnames = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);
const dnsSafetyCache = new Map<string, { safe: boolean; expiresAt: number }>();
const DNS_SAFETY_CACHE_TTL_MS = 300_000;

const isPrivateIpv4 = (address: string): boolean => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }

  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
};

const isPrivateIpv6 = (address: string): boolean => {
  const normalized = address.toLowerCase().split('%')[0];
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];

  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('2001:db8') ||
    normalized.startsWith('ff')
  );
};

export const isPrivateIpAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
};

export const parsePublicHttpUrl = (value: string): URL => {
  const url = new URL(value);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs can be fetched');
  }

  if (url.username || url.password) {
    throw new Error('URLs containing credentials are not allowed');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !hostname ||
    unsafeHostnames.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    throw new Error('Private or local hostnames are not allowed');
  }

  if (isIP(hostname) && isPrivateIpAddress(hostname)) {
    throw new Error('Private or reserved IP addresses are not allowed');
  }

  return url;
};

/**
 * Resolve hostnames before server-side fetches so public-looking DNS names
 * cannot point at loopback, LAN, link-local, or cloud metadata addresses.
 */
export const assertSafePublicUrl = async (value: string): Promise<URL> => {
  const url = parsePublicHttpUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(hostname)) return url;

  const cached = dnsSafetyCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.safe) {
      throw new Error('URL resolves to a private or reserved IP address');
    }
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  const safe =
    addresses.length > 0 &&
    addresses.every(({ address }) => !isPrivateIpAddress(address));

  dnsSafetyCache.set(hostname, {
    safe,
    expiresAt: Date.now() + DNS_SAFETY_CACHE_TTL_MS,
  });

  if (!safe) {
    throw new Error('URL resolves to a private or reserved IP address');
  }

  return url;
};
