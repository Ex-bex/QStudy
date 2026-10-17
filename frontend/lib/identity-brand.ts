export const QID_LOGO = "/brand/qforcelogo_q-id.png";
export const CONTROL_LOGO = "/brand/qforcelogo_qcontrol.png";

export function isIdentityPath(pathname: string): boolean {
  return [
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
  ].includes(pathname);
}
