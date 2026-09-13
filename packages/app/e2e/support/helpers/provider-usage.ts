import type { Page } from "@playwright/test";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import { daemonWsRoutePattern } from "./daemon-port";

interface ProviderUsageFixturePayload {
  fetchedAt: string;
  providers: ProviderUsage[];
}

interface PluginCatalogFixtureEntry {
  id: string;
  clientBundle: string;
  requirements?: { paseo: string };
}

interface ProviderUsageFixtureOptions {
  pluginCatalog?: PluginCatalogFixtureEntry[];
}

export interface ProviderUsageFixture {
  requestCount(): number;
  waitForRequestCount(count: number): Promise<void>;
}

type WebSocketMessage = string | Buffer;

function parseJson(message: WebSocketMessage): unknown {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const envelope = parseJson(message);
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const maybeEnvelope = envelope as { type?: unknown; message?: unknown };
  if (maybeEnvelope.type !== "session" || !maybeEnvelope.message) {
    return null;
  }
  if (typeof maybeEnvelope.message !== "object") {
    return null;
  }
  return maybeEnvelope.message as Record<string, unknown>;
}

function withProviderUsageFeature(
  message: WebSocketMessage,
  pluginsEnabled: boolean,
): string | null {
  const envelope = parseJson(message);
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const maybeEnvelope = envelope as {
    type?: unknown;
    message?: {
      type?: unknown;
      payload?: Record<string, unknown>;
    };
  };
  const payload = maybeEnvelope.message?.payload;
  if (
    maybeEnvelope.type !== "session" ||
    maybeEnvelope.message?.type !== "status" ||
    payload?.status !== "server_info"
  ) {
    return null;
  }
  return JSON.stringify({
    ...maybeEnvelope,
    message: {
      ...maybeEnvelope.message,
      payload: {
        ...payload,
        features: {
          ...(typeof payload.features === "object" && payload.features !== null
            ? payload.features
            : {}),
          providerUsageList: true,
          ...(pluginsEnabled ? { plugins: true } : {}),
        },
      },
    },
  });
}

export async function installProviderUsageFixture(
  page: Page,
  payloads: ProviderUsageFixturePayload[],
  options: ProviderUsageFixtureOptions = {},
): Promise<ProviderUsageFixture> {
  let requests = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];

  function notifyWaiters() {
    for (const waiter of waiters.splice(0)) {
      if (requests >= waiter.count) {
        waiter.resolve();
      } else {
        waiters.push(waiter);
      }
    }
  }

  function payloadForRequest(): ProviderUsageFixturePayload {
    const index = Math.min(requests - 1, payloads.length - 1);
    const payload = payloads[index];
    if (!payload) {
      throw new Error("Provider usage fixture requires at least one payload.");
    }
    return payload;
  }

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      if (sessionMessage?.type === "provider.usage.list.request") {
        requests += 1;
        const requestId = sessionMessage.requestId;
        if (typeof requestId !== "string") {
          throw new Error("provider.usage.list.request missing requestId");
        }
        const payload = payloadForRequest();
        notifyWaiters();
        ws.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "provider.usage.list.response",
              payload: {
                requestId,
                fetchedAt: payload.fetchedAt,
                providers: payload.providers,
              },
            },
          }),
        );
        return;
      }
      if (sessionMessage?.type === "plugin.catalog.get.request" && options.pluginCatalog) {
        const requestId = sessionMessage.requestId;
        if (typeof requestId !== "string") {
          throw new Error("plugin.catalog.get.request missing requestId");
        }
        ws.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "plugin.catalog.get.response",
              payload: { requestId, plugins: options.pluginCatalog },
            },
          }),
        );
        return;
      }
      server.send(message);
    });

    server.onMessage((message) => {
      const serverInfo =
        typeof message === "string"
          ? withProviderUsageFeature(message, Boolean(options.pluginCatalog))
          : null;
      ws.send(serverInfo ?? message);
    });
  });

  return {
    requestCount() {
      return requests;
    },
    waitForRequestCount(count: number) {
      if (requests >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
      });
    },
  };
}
