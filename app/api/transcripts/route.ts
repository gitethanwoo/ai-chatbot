import { type NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { createClient } from '@supabase/supabase-js';

const toNativeResponse = (response: Response) =>
  new Response(response.body, response);

export async function GET(request: NextRequest) {
  console.log('transcripts route request', {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    xWorkosMiddleware: request.headers.get('x-workos-middleware'),
    xMiddlewareSubrequest: request.headers.get('x-middleware-subrequest'),
  });
  let session:
    | Awaited<ReturnType<typeof withAuth>>
    | undefined;
  const logResponse = (
    label: string,
    response: Response,
    payload?: unknown,
  ) => {
    console.log('transcripts route response', {
      label,
      payload,
      response,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
      isResponseInstance: response instanceof Response,
      isNextResponseInstance: response instanceof NextResponse,
      responseConstructor: response.constructor?.name,
      responseProto: Object.getPrototypeOf(response)?.constructor?.name,
      responseTag: Object.prototype.toString.call(response),
      responseHasBody: response.body !== null,
      responseJsonType: typeof Response.json,
      responseName: Response.name,
    });
  };
  try {
    console.log('transcripts route before withAuth');
    session = await withAuth();
    console.log('transcripts route session raw', session);
    console.log('transcripts route session', {
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

    const { user } = session;

    if (!user) {
      const payload = { error: 'Unauthorized' };
      const response = NextResponse.json(payload, { status: 401 });
      logResponse('unauthorized', response, payload);
      return toNativeResponse(response);
    }

    // Parse pagination parameters
    const { searchParams } = new URL(request.url);
    const page = Number.parseInt(searchParams.get('page') || '1', 10);
    const limit = Number.parseInt(searchParams.get('limit') || '20', 10);
    const offset = (page - 1) * limit;

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      const payload = { error: 'Database configuration missing' };
      const response = NextResponse.json(payload, { status: 500 });
      logResponse('missing-db-config', response, payload);
      return toNativeResponse(response);
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Build base query
    let baseQuery = supabase
      .from('transcripts')
      .select(
        'id, recording_start, summary, projects, clients, meeting_type, extracted_participants, verified_participant_emails',
      );

    // Only return transcripts where user is a verified participant (applies to all users)
    if (user.email) {
      baseQuery = baseQuery.contains('verified_participant_emails', [
        user.email,
      ]);
    }

    // Get total count for pagination - match main query filtering
    let countQuery = supabase
      .from('transcripts')
      .select('*', { count: 'exact', head: true });

    if (user.email) {
      countQuery = countQuery.contains('verified_participant_emails', [
        user.email,
      ]);
    }

    const { count, error: countError } = await countQuery;
    console.log('transcripts route count result', {
      count,
      countError,
    });

    // Get paginated results
    const { data, error } = await baseQuery
      .order('recording_start', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Database error:', error);
      const payload = { error: 'Failed to fetch transcripts' };
      const response = NextResponse.json(payload, { status: 500 });
      logResponse('query-error', response, payload);
      return toNativeResponse(response);
    }

    const payload = {
      data: data || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
        hasNext: page < Math.ceil((count || 0) / limit),
        hasPrev: page > 1,
      },
    };
    const response = NextResponse.json(payload);
    logResponse('success', response, payload);
    return toNativeResponse(response);
  } catch (error) {
    console.error('API error:', error);
    console.log('transcripts route session raw on error', session);
    const payload = { error: 'Internal server error' };
    const response = NextResponse.json(payload, { status: 500 });
    logResponse('catch', response, payload);
    return toNativeResponse(response);
  }
}
