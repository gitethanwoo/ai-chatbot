import { withAuth } from '@workos-inc/authkit-nextjs';
import { NextResponse } from 'next/server';
import {
  getChatById,
  getDatabaseUserFromWorkOS,
  getVotesByChatId,
  voteMessage,
} from '@/lib/db/queries';
import { ChatSDKError } from '@/lib/errors';
import { toNextResponse, toNativeResponse } from '@/lib/server/next-response';

async function handleGET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get('chatId');

  if (!chatId) {
    return toNextResponse(
      new ChatSDKError(
        'bad_request:api',
        'Parameter chatId is required.',
      ).toResponse(),
    );
  }

  const session = await withAuth();

  if (!session?.user) {
    return toNextResponse(
      new ChatSDKError('unauthorized:vote').toResponse(),
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
      new ChatSDKError('unauthorized:vote', 'User not found').toResponse(),
    );
  }

  const chat = await getChatById({ id: chatId });

  if (!chat) {
    return toNextResponse(new ChatSDKError('not_found:chat').toResponse());
  }

  if (chat.userId !== databaseUser.id) {
    return toNextResponse(new ChatSDKError('forbidden:vote').toResponse());
  }

  const votes = await getVotesByChatId({ id: chatId });

  return NextResponse.json(votes, { status: 200 });
}

async function handlePATCH(request: Request) {
  const {
    chatId,
    messageId,
    type,
  }: { chatId: string; messageId: string; type: 'up' | 'down' } =
    await request.json();

  if (!chatId || !messageId || !type) {
    return toNextResponse(
      new ChatSDKError(
        'bad_request:api',
        'Parameters chatId, messageId, and type are required.',
      ).toResponse(),
    );
  }

  const session = await withAuth();

  if (!session?.user) {
    return toNextResponse(
      new ChatSDKError('unauthorized:vote').toResponse(),
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
      new ChatSDKError('unauthorized:vote', 'User not found').toResponse(),
    );
  }

  const chat = await getChatById({ id: chatId });

  if (!chat) {
    return toNextResponse(new ChatSDKError('not_found:vote').toResponse());
  }

  if (chat.userId !== databaseUser.id) {
    return toNextResponse(new ChatSDKError('forbidden:vote').toResponse());
  }

  await voteMessage({
    chatId,
    messageId,
    type: type,
  });

  return new NextResponse('Message voted', { status: 200 });
}

export async function GET(...args: Parameters<typeof handleGET>) {
  const response = await handleGET(...args);
  return toNativeResponse(response);
}

export async function PATCH(...args: Parameters<typeof handlePATCH>) {
  const response = await handlePATCH(...args);
  return toNativeResponse(response);
}
