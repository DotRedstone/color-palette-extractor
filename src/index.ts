/**
 * Color Palette Extractor — Cloudflare Worker
 *
 * POST /api/extract  { "image": "<url>" }  → dominant color palette
 * GET  /api/health                          → health check
 */
import { decodePNG } from './png';
import { decodeJPEG } from './jpeg';
import { extractPalette } from './palette';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(req.url);

    // Health check
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // Extract palette
    if (url.pathname === '/api/extract' && req.method === 'POST') {
      const t0 = Date.now();
      try {
        const body = (await req.json()) as Record<string, unknown>;
        const imageUrl = (body.image ?? body.url) as string | undefined;
        if (!imageUrl || typeof imageUrl !== 'string') {
          return json({ error: 'image (URL string) is required' }, 400);
        }

        // Fetch image
        const resp = await fetch(imageUrl);
        if (!resp.ok) return json({ error: `Failed to fetch image: ${resp.status}` }, 400);
        const buf = new Uint8Array(await resp.arrayBuffer());

        // Detect format & decode
        const isPNG = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
        const isJPEG = buf[0] === 0xff && buf[1] === 0xd8;

        let decoded: { width: number; height: number; pixels: Uint8Array };
        if (isPNG) {
          decoded = decodePNG(buf);
        } else if (isJPEG) {
          decoded = decodeJPEG(buf);
        } else {
          return json({ error: 'Unsupported format. Use PNG or JPEG.' }, 400);
        }

        // Extract palette
        const numColors = typeof body.numColors === 'number' ? body.numColors : 8;
        const maxDim = typeof body.maxDim === 'number' ? body.maxDim : 512;
        const result = extractPalette(decoded.pixels, decoded.width, decoded.height, numColors, maxDim);
        result.processingTimeMs = Date.now() - t0;

        return json({ success: true, data: result });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ error: msg }, 400);
      }
    }

    return json({ error: 'Not found. Try POST /api/extract' }, 404);
  },
};
