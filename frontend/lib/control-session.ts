import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// Check the current database role through the private API, never through a
// client-supplied role or a second account store.
export async function requireControlAdmin(): Promise<void> {
  const session = (await cookies()).get("qstudy_session")?.value;
  const login = "/login?next=%2Fqcontrol";
  if (!session) redirect(login);
  const backend = (process.env.BACKEND_URL || "http://127.0.0.1:8000").replace(
    /\/$/,
    "",
  );
  const response = await fetch(`${backend}/api/auth/me`, {
    headers: { Authorization: `Bearer ${session}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401 || response.status === 403) redirect(login);
  if (!response.ok) throw new Error("Не удалось проверить доступ к QControl");
  const user = await response.json();
  if (user.role !== "admin" || !user.is_active) redirect("/dashboard");
}
