import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const unsafeHostnames = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);

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
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
};

const isPrivateIpv6 = (address: string): boolean => {
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = normalized.split('::');
  const prefix = left ? left.split(':') : [];
  const suffix = right ? right.split(':') : [];
  const groups = normalized.includes('::')
    ? [
        ...prefix,
        ...Array(8 - prefix.length - suffix.length).fill('0'),
        ...suffix,
      ]
    : prefix;
  const words = groups.map((part) => parseInt(part, 16));

  // URL parsing converts dotted IPv4 tails into hexadecimal IPv6 words.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isPrivateIpv4(
      [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.'),
    );
  }

  // Only global unicast, excluding special-purpose and transition ranges.
  return (
    (words[0] & 0xe000) !== 0x2000 ||
    (words[0] === 0x2001 && words[1] < 0x200) ||
    (words[0] === 0x2001 && words[1] === 0xdb8) ||
    words[0] === 0x2002 ||
    (words[0] === 0x3fff && words[1] < 0x1000)
  );
};

export const isPrivateIpAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) {
    try {
      return isPrivateIpv6(address);
    } catch {
      return true;
    }
  }
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

  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
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

  await resolvePublicAddresses(hostname);

  return url;
};

export const resolvePublicAddresses = async (
  hostname: string,
  resolver: typeof lookup = lookup,
) => {
  const addresses = await resolver(hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateIpAddress(address))
  ) {
    throw new Error('URL resolves to a private or reserved IP address');
  }
  return addresses;
};
