import type { NextRequest } from 'next/server';
import { authkit, handleAuthkitHeaders } from '@workos-inc/authkit-nextjs';

// Prefer explicit redirect URI; fall back to preview deployment URL
const fallbackHost =
  process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL || 'localhost:3000';

const fallbackProto = fallbackHost.includes('localhost') ? 'http' : 'https';
const computedRedirectUri = `${fallbackProto}://${fallbackHost}/callback`;
const REDIRECT_URI =
  process.env.WORKOS_REDIRECT_URI ||
  process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ||
  computedRedirectUri;

const unauthenticatedPaths = [
  '/login',
  '/register',
  '/callback',
  '/ping',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/:path*',
  '/.well-known/oauth-authorization-server',
  '/.well-known/workflow/v1/flow',
  '/.well-known/workflow/v1/step',
  '/.well-known/workflow/v1/webhook/:token',
  '/mcp',
  '/sse',
  '/message',
  '/api/mcp',
  '/api/transcripts/:id/download',
];

const matchesPathPattern = (pathname: string, pattern: string) => {
  const pathSegments = pathname.split('/').filter(Boolean);
  const patternSegments = pattern.split('/').filter(Boolean);

  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index];

    if (patternSegment?.startsWith(':') && patternSegment.endsWith('*')) {
      return true;
    }

    const pathSegment = pathSegments[index];
    if (!pathSegment) {
      return false;
    }

    if (patternSegment?.startsWith(':')) {
      continue;
    }

    if (patternSegment !== pathSegment) {
      return false;
    }
  }

  return pathSegments.length === patternSegments.length;
};

const isUnauthenticatedPath = (pathname: string, allowlist: string[]) =>
  allowlist.some((pattern) => matchesPathPattern(pathname, pattern));

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Keep Playwright/webServer readiness independent from AuthKit.
  if (pathname === '/ping') {
    return new Response('ok', {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  const allowlist = [...unauthenticatedPaths];

  if (REDIRECT_URI) {
    const redirectPathname = new URL(REDIRECT_URI).pathname;
    if (!allowlist.includes(redirectPathname)) {
      allowlist.push(redirectPathname);
    }
  }

  const { session, headers, authorizationUrl } = await authkit(request, {
    redirectUri: REDIRECT_URI,
    debug: true,
  });

  const isAllowed = isUnauthenticatedPath(pathname, allowlist);

  const toRuntimeResponse = (response: Response) =>
    new Response(response.body, response);

  const respond = (redirect?: string) => {
    const response = handleAuthkitHeaders(
      request,
      headers,
      redirect ? { redirect } : undefined,
    );

    return toRuntimeResponse(response);
  };

  if (!isAllowed && !session.user && authorizationUrl) {
    return respond(authorizationUrl);
  }

  return respond();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     */
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};
