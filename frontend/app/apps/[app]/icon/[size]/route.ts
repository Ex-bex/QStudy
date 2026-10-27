import { pwaApp } from "@/lib/pwa";
import { pwaIconResponse } from "@/lib/pwa-icon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ app: string; size: string }> },
) {
  const { app: id, size: requested } = await context.params;
  const app = pwaApp(id);
  const size =
    requested === "180.png"
      ? 180
      : requested === "192.png"
        ? 192
        : requested === "512.png"
          ? 512
          : null;
  if (!app || !size) return new Response("Иконка не найдена", { status: 404 });
  return pwaIconResponse(
    app,
    size,
    new URL(request.url).searchParams.get("purpose") === "maskable",
  );
}
