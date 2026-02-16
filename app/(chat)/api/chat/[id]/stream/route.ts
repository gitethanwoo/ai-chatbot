import { withAuth } from '@workos-inc/authkit-nextjs';
import { NextResponse } from 'next/server';
import {
  getChatById,
  getDatabaseUserFromWorkOS,
  getMessagesByChatId,
  getStreamIdsByChatId,
} from '@/lib/db/queries';
import type { Chat } from '@/lib/db/schema';
import { ChatSDKError } from '@/lib/errors';
import { toNextResponse, toNativeResponse } from '@/lib/server/next-response';
import type { ChatMessage } from '@/lib/types';
import { createUIMessageStream, JsonToSseTransformStream } from 'ai';
import { getStreamContext } from '../../route';
import { differenceInSeconds } from 'date-fns';

async function handleGET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: chatId } = await params;

  const streamContext = getStreamContext();
  const resumeRequestedAt = new Date();

  if (!streamContext) {
    return new NextResponse(null, { status: 204 });
  }

  if (!chatId) {
    return toNextResponse(new ChatSDKError('bad_request:api').toResponse());
  }

  const session = await withAuth();

  if (!session?.user) {
    return toNextResponse(
      new ChatSDKError('unauthorized:chat').toResponse(),
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
      new ChatSDKError('unauthorized:chat', 'User not found').toResponse(),
    );
  }

  let chat: Chat | null;

  try {
    chat = await getChatById({ id: chatId });
  } catch {
    return toNextResponse(new ChatSDKError('not_found:chat').toResponse());
  }

  if (!chat) {
    return toNextResponse(new ChatSDKError('not_found:chat').toResponse());
  }

  if (chat.visibility === 'private' && chat.userId !== databaseUser.id) {
    return toNextResponse(new ChatSDKError('forbidden:chat').toResponse());
  }

  const streamIds = await getStreamIdsByChatId({ chatId });

  if (!streamIds.length) {
    return toNextResponse(new ChatSDKError('not_found:stream').toResponse());
  }

  const recentStreamId = streamIds.at(-1);

  if (!recentStreamId) {
    return toNextResponse(new ChatSDKError('not_found:stream').toResponse());
  }

  const emptyDataStream = createUIMessageStream<ChatMessage>({
    execute: () => {},
  });

  const stream = await streamContext.resumableStream(recentStreamId, () =>
    emptyDataStream.pipeThrough(new JsonToSseTransformStream()),
  );

  /*
   * For when the generation is streaming during SSR
   * but the resumable stream has concluded at this point.
   */
  if (!stream) {
    const messages = await getMessagesByChatId({ id: chatId });
    const mostRecentMessage = messages.at(-1);

    if (!mostRecentMessage) {
      return new NextResponse(emptyDataStream, { status: 200 });
    }

    if (mostRecentMessage.role !== 'assistant') {
      return new NextResponse(emptyDataStream, { status: 200 });
    }

    const messageCreatedAt = new Date(mostRecentMessage.createdAt);

    if (differenceInSeconds(resumeRequestedAt, messageCreatedAt) > 15) {
      return new NextResponse(emptyDataStream, { status: 200 });
    }

    const restoredStream = createUIMessageStream<ChatMessage>({
      execute: ({ writer }) => {
        writer.write({
          type: 'data-appendMessage',
          data: JSON.stringify(mostRecentMessage),
          transient: true,
        });
      },
    });

    return new NextResponse(
      restoredStream.pipeThrough(new JsonToSseTransformStream()),
      { status: 200 },
    );
  }

  return new NextResponse(stream, { status: 200 });
}

export async function GET(...args: Parameters<typeof handleGET>) {
  const response = await handleGET(...args);
  return toNativeResponse(response);
}
