// Replace this asset when the final Q-ID logo is ready.
export const QID_LOGO = "/brand/qid-placeholder.svg";

export function isIdentityPath(pathname: string): boolean {
  return [
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
  ].includes(pathname);
}
