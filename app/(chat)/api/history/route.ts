import { withAuth } from '@workos-inc/authkit-nextjs';
import type { NextRequest } from 'next/server';
import { getChatsByUserId, getDatabaseUserFromWorkOS } from '@/lib/db/queries';
import { ChatSDKError } from '@/lib/errors';
import { toNativeResponse } from '@/lib/server/next-response';

async function handleGET(request: NextRequest) {
  console.log('history route request', {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    xWorkosMiddleware: request.headers.get('x-workos-middleware'),
    xMiddlewareSubrequest: request.headers.get('x-middleware-subrequest'),
  });
  const { searchParams } = request.nextUrl;

  const limit = Number.parseInt(searchParams.get('limit') || '10');
  const startingAfter = searchParams.get('starting_after');
  const endingBefore = searchParams.get('ending_before');

  if (startingAfter && endingBefore) {
    return new ChatSDKError(
      'bad_request:api',
      'Only one of starting_after or ending_before can be provided.',
    ).toResponse();
  }

  const session = await withAuth();
  console.log('history route session', {
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
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  try {
    // Get the database user from the WorkOS user
    const databaseUser = await getDatabaseUserFromWorkOS({
      id: session.user.id,
      email: session.user.email,
      firstName: session.user.firstName ?? undefined,
      lastName: session.user.lastName ?? undefined,
    });

    if (!databaseUser) {
      return new ChatSDKError(
        'not_found:history',
        'User not found',
      ).toResponse();
    }

    const chats = await getChatsByUserId({
      id: databaseUser.id,
      limit,
      startingAfter,
      endingBefore,
    });

    return Response.json(chats);
  } catch (error) {
    console.error('Error in history API:', error);
    return new ChatSDKError(
      'bad_request:database',
      'Database error',
    ).toResponse();
  }
}

export async function GET(...args: Parameters<typeof handleGET>) {
  const response = await handleGET(...args);
  return toNativeResponse(response);
}
