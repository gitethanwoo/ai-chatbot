import { withAuth } from '@workos-inc/authkit-nextjs';
import { NextResponse } from 'next/server';
import type { ArtifactKind } from '@/components/artifact';
import {
  deleteDocumentsByIdAfterTimestamp,
  getDatabaseUserFromWorkOS,
  getDocumentsById,
  saveDocument,
} from '@/lib/db/queries';
import { ChatSDKError } from '@/lib/errors';
import { toNextResponse, toNativeResponse } from '@/lib/server/next-response';

async function handleGET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return toNextResponse(
      new ChatSDKError(
        'bad_request:api',
        'Parameter id is missing',
      ).toResponse(),
    );
  }

  const session = await withAuth();

  if (!session?.user) {
    return toNextResponse(
      new ChatSDKError('unauthorized:document').toResponse(),
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
        'unauthorized:document',
        'User not found',
      ).toResponse(),
    );
  }

  const documents = await getDocumentsById({ id });

  const [document] = documents;

  if (!document) {
    return toNextResponse(
      new ChatSDKError('not_found:document').toResponse(),
    );
  }

  if (document.userId !== databaseUser.id) {
    return toNextResponse(
      new ChatSDKError('forbidden:document').toResponse(),
    );
  }

  return NextResponse.json(documents, { status: 200 });
}

async function handlePOST(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return toNextResponse(
      new ChatSDKError(
        'bad_request:api',
        'Parameter id is required.',
      ).toResponse(),
    );
  }

  const session = await withAuth();

  if (!session?.user) {
    return toNextResponse(
      new ChatSDKError('unauthorized:document').toResponse(),
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
        'unauthorized:document',
        'User not found',
      ).toResponse(),
    );
  }

  const {
    content,
    title,
    kind,
  }: { content: string; title: string; kind: ArtifactKind } =
    await request.json();

  const documents = await getDocumentsById({ id });

  if (documents.length > 0) {
    const [document] = documents;

    if (document.userId !== databaseUser.id) {
      return toNextResponse(
        new ChatSDKError('forbidden:document').toResponse(),
      );
    }
  }

  const document = await saveDocument({
    id,
    content,
    title,
    kind,
    userId: databaseUser.id,
  });

  return NextResponse.json(document, { status: 200 });
}

async function handleDELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const timestamp = searchParams.get('timestamp');

  if (!id) {
    return toNextResponse(
      new ChatSDKError(
        'bad_request:api',
        'Parameter id is required.',
      ).toResponse(),
    );
  }

  if (!timestamp) {
    return toNextResponse(
      new ChatSDKError(
        'bad_request:api',
        'Parameter timestamp is required.',
      ).toResponse(),
    );
  }

  const session = await withAuth();

  if (!session?.user) {
    return toNextResponse(
      new ChatSDKError('unauthorized:document').toResponse(),
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
        'unauthorized:document',
        'User not found',
      ).toResponse(),
    );
  }

  const documents = await getDocumentsById({ id });

  const [document] = documents;

  if (document.userId !== databaseUser.id) {
    return toNextResponse(
      new ChatSDKError('forbidden:document').toResponse(),
    );
  }

  const documentsDeleted = await deleteDocumentsByIdAfterTimestamp({
    id,
    timestamp: new Date(timestamp),
  });

  return NextResponse.json(documentsDeleted, { status: 200 });
}

export async function GET(...args: Parameters<typeof handleGET>) {
  const response = await handleGET(...args);
  return toNativeResponse(response);
}

export async function POST(...args: Parameters<typeof handlePOST>) {
  const response = await handlePOST(...args);
  return toNativeResponse(response);
}

export async function DELETE(...args: Parameters<typeof handleDELETE>) {
  const response = await handleDELETE(...args);
  return toNativeResponse(response);
}
