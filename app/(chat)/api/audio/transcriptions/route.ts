import { withAuth } from '@workos-inc/authkit-nextjs';
import { toNativeResponse } from '@/lib/server/next-response';
import {
  getDatabaseUserFromWorkOS,
  listAudioTranscriptionsByUserId,
} from '@/lib/db/queries';

async function handleGET(request: Request) {
  console.log('audio transcriptions route request', {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    xWorkosMiddleware: request.headers.get('x-workos-middleware'),
    xMiddlewareSubrequest: request.headers.get('x-middleware-subrequest'),
  });
  const session = await withAuth();
  console.log('audio transcriptions route session', {
    user: session.user,
    sessionId: session.sessionId,
    organizationId: session.organizationId,
    role: session.role,
    roles: session.roles,
    permissions: session.permissions,
    entitlements: session.entitlements,
    featureFlags: session.featureFlags,
    impersonator: session.impersonator,
  });

  if (!session?.user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Number.parseInt(searchParams.get('limit') || '20', 10);

  const dbUser = await getDatabaseUserFromWorkOS({
    id: session.user.id,
    email: session.user.email,
    firstName: session.user.firstName || undefined,
    lastName: session.user.lastName || undefined,
  });

  if (!dbUser) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const rows = await listAudioTranscriptionsByUserId({
    userId: dbUser.id,
    limit,
  });

  return Response.json(rows);
}

export async function GET(...args: Parameters<typeof handleGET>) {
  const response = await handleGET(...args);
  return toNativeResponse(response);
}
