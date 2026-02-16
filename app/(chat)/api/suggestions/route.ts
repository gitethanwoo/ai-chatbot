import { withAuth } from '@workos-inc/authkit-nextjs';
import { NextResponse } from 'next/server';
import {
  getDatabaseUserFromWorkOS,
  getSuggestionsByDocumentId,
} from '@/lib/db/queries';
import { ChatSDKError } from '@/lib/errors';
import { toNextResponse, toNativeResponse } from '@/lib/server/next-response';

async function handleGET(request: Request) {
  const { searchParams } = new URL(request.url);
  const documentId = searchParams.get('documentId');

  if (!documentId) {
    return toNextResponse(
      new ChatSDKError(
        'bad_request:api',
        'Parameter documentId is required.',
      ).toResponse(),
    );
  }

  const session = await withAuth();

  if (!session?.user) {
    return toNextResponse(
      new ChatSDKError('unauthorized:suggestions').toResponse(),
    );
  }

  // Get the database user from the WorkOS user
  const databaseUser = await getDatabaseUserFromWorkOS({
    id: session.user.id,
    email: session.user.email,
    firstName: session.user.firstName ?? undefined,
    lastName: session.user.lastName ?? undefined,
  });

  if (!databaseUser) {
    return toNextResponse(
      new ChatSDKError(
        'unauthorized:suggestions',
        'User not found',
      ).toResponse(),
    );
  }

  const suggestions = await getSuggestionsByDocumentId({
    documentId,
  });

  const [suggestion] = suggestions;

  if (!suggestion) {
    return NextResponse.json([], { status: 200 });
  }

  if (suggestion.userId !== databaseUser.id) {
    return toNextResponse(new ChatSDKError('forbidden:api').toResponse());
  }

  return NextResponse.json(suggestions, { status: 200 });
}

export async function GET(...args: Parameters<typeof handleGET>) {
  const response = await handleGET(...args);
  return toNativeResponse(response);
}
