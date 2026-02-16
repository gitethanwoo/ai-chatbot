import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { toNativeResponse } from '@/lib/server/next-response';
import {
  getAudioTranscriptionById,
  getDatabaseUserFromWorkOS,
  updateAudioTranscriptionSpeakerNames,
} from '@/lib/db/queries';

async function handleGET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await withAuth();

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbUser = await getDatabaseUserFromWorkOS({
    id: session.user.id,
    email: session.user.email,
    firstName: session.user.firstName || undefined,
    lastName: session.user.lastName || undefined,
  });

  if (!dbUser) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const { id } = await context.params;
  const record = await getAudioTranscriptionById({
    id,
    userId: dbUser.id,
  });

  if (!record) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(record);
}

async function handlePATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await withAuth();

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbUser = await getDatabaseUserFromWorkOS({
    id: session.user.id,
    email: session.user.email,
    firstName: session.user.firstName || undefined,
    lastName: session.user.lastName || undefined,
  });

  if (!dbUser) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const { speakerNames } = (await request.json()) as {
    speakerNames: Record<string, string>;
  };

  const { id } = await context.params;
  const updated = await updateAudioTranscriptionSpeakerNames({
    id,
    userId: dbUser.id,
    speakerNames,
  });

  if (!updated) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(updated);
}

export async function GET(...args: Parameters<typeof handleGET>) {
  const response = await handleGET(...args);
  return toNativeResponse(response);
}

export async function PATCH(...args: Parameters<typeof handlePATCH>) {
  const response = await handlePATCH(...args);
  return toNativeResponse(response);
}
