import SessionManager from '@/lib/session';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = SessionManager.getSession(id);
  if (!session)
    return Response.json({ message: 'Session not found' }, { status: 404 });
  session.cancel();
  return Response.json({ stopped: session.signal.aborted });
}
