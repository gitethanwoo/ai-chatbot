import { withAuth } from '@workos-inc/authkit-nextjs';
import { getDatabaseUserFromWorkOS, searchAgentsForUser } from '@/lib/db/queries';
import { ChatSDKError } from '@/lib/errors';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q');
    const limitParam = searchParams.get('limit');

    const session = await withAuth({ ensureSignedIn: true });
    const databaseUser = await getDatabaseUserFromWorkOS({
      id: session.user.id,
      email: session.user.email,
      firstName: session.user.firstName ?? undefined,
      lastName: session.user.lastName ?? undefined,
    });

    if (!databaseUser) {
      return new ChatSDKError('unauthorized:chat', 'User not found').toResponse();
    }

    const limit = (() => {
      const parsed = Number(limitParam);
      if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_LIMIT;
      return Math.min(parsed, MAX_LIMIT);
    })();

    const results = await searchAgentsForUser({
      userId: databaseUser.id,
      query,
      limit,
    });

    return Response.json({
      agents: results.map(({ agent }) => ({
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        description: agent.description,
        isPublic: agent.isPublic,
        isOwned: agent.userId === databaseUser.id,
        vectorStoreId: agent.vectorStoreId ?? null,
      })),
    });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    console.error('Unhandled error in agent search API:', error);
    return new ChatSDKError('offline:chat').toResponse();
  }
}
