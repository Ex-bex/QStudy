/** Serialize cookie-creating requests while issuing a fresh one-use ticket each time. */
export class GameSessionQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(request: () => Promise<T>): Promise<T> {
    const result = this.tail.then(request);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const gameSessionRequests = new GameSessionQueue();

/** Only an explicit guest reset may retry; bans and QStudy auth errors remain errors. */
export function requestGameSession<T>(
  transport: typeof fetch = fetch,
): Promise<T> {
  return gameSessionRequests.run(async () => {
    const send = () =>
      transport("/api/lumaball/session", {
        method: "POST",
        body: "{}",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
      });
    let response = await send();
    if (
      response.status === 401 &&
      response.headers.get("X-QBall-Guest-Reset") === "1"
    ) {
      await response.text();
      response = await send();
    }
    const value = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        typeof value.detail === "string"
          ? value.detail
          : "Не удалось войти в игру. Повторите попытку.",
      );
    return value as T;
  });
}
