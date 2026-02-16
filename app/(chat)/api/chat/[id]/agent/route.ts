import { withAuth } from '@workos-inc/authkit-nextjs';
import { NextResponse } from 'next/server';
import { getDatabaseUserFromWorkOS, getChatWithAgent } from '@/lib/db/queries';
import { ChatSDKError } from '@/lib/errors';
import { toNextResponse, toNativeResponse } from '@/lib/server/next-response';

async function handleGET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await withAuth({ ensureSignedIn: true });

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
          'unauthorized:chat',
          'User not found',
        ).toResponse(),
      );
    }

    const chatData = await getChatWithAgent(id, databaseUser.id);

    if (chatData?.agent) {
      return NextResponse.json({
        agentName: chatData.agent.name,
        agentDescription: chatData.agent.description,
        agentPrompt: chatData.agent.agentPrompt,
        vectorStoreId: chatData.agent.vectorStoreId,
      });
    }

    return NextResponse.json(null);
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return toNextResponse(error.toResponse());
    }

    console.error('Unhandled error in chat agent API:', error);
    return toNextResponse(new ChatSDKError('offline:chat').toResponse());
  }
}

export async function GET(...args: Parameters<typeof handleGET>) {
  const response = await handleGET(...args);
  return toNativeResponse(response);
}
