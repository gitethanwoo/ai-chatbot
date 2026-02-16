import 'server-only';
import { NextResponse } from 'next/server';

export const toNativeResponse = (response: Response) =>
  new Response(response.body, response);

export const toNextResponse = (response: Response) =>
  toNativeResponse(
    new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  );
