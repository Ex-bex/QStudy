import { pwaApp, pwaManifest } from "@/lib/pwa";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ app: string }> },
) {
  const { app: id } = await context.params;
  const app = pwaApp(id);
  if (!app) return new Response("Приложение не найдено", { status: 404 });
  return Response.json(pwaManifest(app.id), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
