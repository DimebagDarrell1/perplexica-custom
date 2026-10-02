import configManager from '@/lib/config';
import { requireAdminToken } from '@/lib/config/security';
import { getJevStatus } from '@/lib/jev';

export const dynamic = 'force-dynamic';

/** Read configuration without contacting a paid inference service. */
export const GET = async (request: Request) => {
  const unauthorized = requireAdminToken(request);
  if (unauthorized) return unauthorized;
  return Response.json(getJevStatus(configManager.getConfig('search', {})), {
    headers: { 'Cache-Control': 'no-store' },
  });
};
