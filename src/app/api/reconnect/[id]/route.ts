import { sessionResponse } from '@/lib/sessionResponse';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import SessionManager from '@/lib/session';
import { and, eq } from 'drizzle-orm';

export const POST = async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;

    const session = SessionManager.getSession(id);

    if (!session) {
      await db
        .update(messages)
        .set({ status: 'error' })
        .where(
          and(eq(messages.backendId, id), eq(messages.status, 'answering')),
        )
        .execute();

      return Response.json({ message: 'Session not found' }, { status: 404 });
    }

    return sessionResponse(session, req.signal);
  } catch (err) {
    console.error('Error in reconnecting to session stream: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};
