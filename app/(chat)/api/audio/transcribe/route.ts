import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { start } from 'workflow/api';
import { transcribeAudioWorkflow } from '@/workflows/audio-transcription';
import { getDatabaseUserFromWorkOS } from '@/lib/db/queries';
import { toNativeResponse } from '@/lib/server/next-response';

export const maxDuration = 300;

async function handlePOST(request: Request) {
  const session = await withAuth();

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { audioUrl, fileName } = (await request.json()) as {
    audioUrl: string;
    fileName: string | null;
  };
  const dbUser = await getDatabaseUserFromWorkOS({
    id: session.user.id,
    email: session.user.email,
    firstName: session.user.firstName || undefined,
    lastName: session.user.lastName || undefined,
  });

  if (!dbUser) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const run = await start(transcribeAudioWorkflow, [
    {
      audioUrl,
      userId: dbUser.id,
      fileName,
    },
  ]);
  const result = await run.returnValue;

  return NextResponse.json(result);
}

export async function POST(...args: Parameters<typeof handlePOST>) {
  const response = await handlePOST(...args);
  return toNativeResponse(response);
}
