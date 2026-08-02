export class TelegramError extends Error {
  constructor(method, errorCode, description, parameters = {}) {
    super(`Telegram ${method} failed (${errorCode}): ${description}`);
    this.name = "TelegramError";
    this.method = method;
    this.errorCode = errorCode;
    this.description = description;
    this.retryAfter = parameters.retry_after;
  }
}

export class TelegramApi {
  constructor(token, baseUrl = "https://api.telegram.org") {
    this.endpoint = `${baseUrl}/bot${token}`;
  }

  async call(method, parameters = {}, { signal } = {}) {
    const requestSignal = signal || AbortSignal.timeout(15_000);
    let response;
    try {
      response = await fetch(`${this.endpoint}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parameters),
        signal: requestSignal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error(`Could not reach Telegram while calling ${method}.`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Telegram returned an invalid response for ${method}.`);
    }

    if (!response.ok || payload.ok !== true) {
      throw new TelegramError(
        method,
        payload.error_code || response.status,
        payload.description || "Unknown error",
        payload.parameters,
      );
    }
    return payload.result;
  }
}
