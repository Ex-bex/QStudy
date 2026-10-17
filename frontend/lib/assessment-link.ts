/** Only an ID is accepted; the API independently checks ownership. */
export function assessmentSessionFromQuery(query: string): number | null {
  const values = new URLSearchParams(query).getAll("session");
  if (values.length !== 1 || !/^[1-9][0-9]{0,14}$/.test(values[0])) return null;
  const id = Number(values[0]);
  return Number.isSafeInteger(id) ? id : null;
}
