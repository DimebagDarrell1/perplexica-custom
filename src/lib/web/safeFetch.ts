import http from 'node:http';
import https from 'node:https';
import { createBrotliDecompress, createUnzip } from 'node:zlib';
import type { LookupFunction } from 'node:net';
import { parsePublicHttpUrl, resolvePublicAddresses } from './urlSafety';

const MAX_BYTES = 10_000_000;

export const publicLookup: LookupFunction = (hostname, options, callback) => {
  resolvePublicAddresses(hostname).then(
    (addresses) => {
      const candidates = options.family
        ? addresses.filter((item) => item.family === options.family)
        : addresses;
      if (!candidates.length) {
        callback(new Error('No public address for requested family'), '', 0);
      } else if (options.all) {
        callback(null, candidates);
      } else {
        callback(null, candidates[0].address, candidates[0].family);
      }
    },
    (error) => callback(error, '', 0),
  );
};

/** Every connection resolves and validates DNS inside the socket lookup. */
const requestPage = (url: URL, signal: AbortSignal): Promise<Response> =>
  new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(
      url,
      {
        agent: false,
        lookup: publicLookup,
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Perplexica/1.0)',
          'Accept-Encoding': 'identity',
        },
      },
      (response) => {
        const headers = new Headers();
        Object.entries(response.headers).forEach(([key, value]) => {
          if (Array.isArray(value))
            value.forEach((item) => headers.append(key, item));
          else if (value !== undefined) headers.set(key, value);
        });
        const status = response.statusCode || 502;
        if (status >= 300 && status < 400) {
          response.destroy();
          resolve(new Response(null, { status, headers }));
          return;
        }
        if (Number(headers.get('content-length')) > MAX_BYTES) {
          response.destroy();
          reject(new Error('Page exceeded the extraction size limit'));
          return;
        }
        let wireBytes = 0;
        response.on('data', (chunk: Buffer) => {
          wireBytes += chunk.length;
          if (wireBytes > MAX_BYTES)
            response.destroy(
              new Error('Page exceeded the extraction size limit'),
            );
        });
        const encoding = headers.get('content-encoding')?.toLowerCase();
        const decoder =
          encoding === 'br'
            ? createBrotliDecompress()
            : encoding === 'gzip' || encoding === 'deflate'
              ? createUnzip()
              : undefined;
        if (encoding && encoding !== 'identity' && !decoder) {
          response.destroy();
          reject(new Error('Unsupported response encoding'));
          return;
        }
        const stream = decoder ? response.pipe(decoder) : response;
        response.on('error', (error) => {
          decoder?.destroy(error);
          reject(error);
        });
        void (async () => {
          const chunks: Buffer[] = [];
          let size = 0;
          try {
            for await (const chunk of stream) {
              const bytes = Buffer.from(chunk);
              size += bytes.length;
              if (size > MAX_BYTES)
                throw new Error('Page exceeded the extraction size limit');
              chunks.push(bytes);
            }
            headers.delete('content-encoding');
            headers.delete('content-length');
            headers.delete('transfer-encoding');
            resolve(
              new Response(
                [204, 205, 304].includes(status)
                  ? null
                  : new Uint8Array(Buffer.concat(chunks)),
                { status, headers },
              ),
            );
          } catch (error) {
            response.destroy();
            decoder?.destroy();
            reject(error);
          }
        })();
      },
    );
    request.on('error', reject);
  });

export const safeFetch = async (value: string, signal?: AbortSignal) => {
  const deadline = AbortSignal.timeout(15_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let url = parsePublicHttpUrl(value);
  for (let redirects = 0; redirects <= 5; redirects++) {
    requestSignal.throwIfAborted();
    // Literal addresses bypass Node's lookup callback, so parsePublicHttpUrl
    // validates them before opening a socket.
    const response = await requestPage(url, requestSignal);
    if (response.status < 300 || response.status >= 400) {
      return { response, url: url.href };
    }
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect response had no location');
    url = parsePublicHttpUrl(new URL(location, url).href);
  }
  throw new Error('Page exceeded the redirect limit');
};
