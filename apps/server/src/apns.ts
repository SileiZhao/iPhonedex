import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";

export type PushEnvironment = "sandbox" | "production";

export interface PushNotification {
  title: string;
  body: string;
  threadId: string;
  category: "approval" | "failure" | "reply";
  hostId?: string;
  approvalId?: string;
  commandPreview?: string;
}

export interface PushProvider {
  send(
    deviceToken: string,
    environment: PushEnvironment,
    notification: PushNotification,
  ): Promise<void>;
  readonly configured?: boolean;
}

export class NoopPushProvider implements PushProvider {
  readonly configured = false;

  async send(): Promise<void> {
    return;
  }
}

interface ApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  topic: string;
}

export function createPushProviderFromEnv(env = process.env): PushProvider {
  const keyPath = env.APNS_KEY_PATH;
  const keyId = env.APNS_KEY_ID;
  const teamId = env.APNS_TEAM_ID;
  const topic = env.APNS_TOPIC;

  if (!keyPath || !keyId || !teamId || !topic) {
    return new NoopPushProvider();
  }

  return new ApnsPushProvider({ keyPath, keyId, teamId, topic });
}

export class ApnsPushProvider implements PushProvider {
  readonly configured = true;
  private readonly signingKey: ReturnType<typeof createPrivateKey>;
  private currentToken?: { value: string; issuedAt: number };

  constructor(private readonly config: ApnsConfig) {
    this.signingKey = createPrivateKey(readFileSync(config.keyPath, "utf8"));
  }

  async send(
    deviceToken: string,
    environment: PushEnvironment,
    notification: PushNotification,
  ): Promise<void> {
    const origin =
      environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";

    const session = connect(origin);
    try {
      await this.sendRequest(session, deviceToken, notification);
    } finally {
      session.close();
    }
  }

  private async sendRequest(
    session: ClientHttp2Session,
    deviceToken: string,
    notification: PushNotification,
  ): Promise<void> {
    const payload = JSON.stringify({
      aps: {
        alert: {
          title: notification.title,
          body: notification.body,
        },
        sound: "default",
        "thread-id": notification.threadId,
        category: notification.category,
      },
      threadId: notification.threadId,
      category: notification.category,
      hostId: notification.hostId,
      approvalId: notification.approvalId,
      commandPreview: notification.commandPreview,
    });

    await new Promise<void>((resolve, reject) => {
      const request = session.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${this.authToken()}`,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-topic": this.config.topic,
        "content-type": "application/json",
      });

      let statusCode = 0;
      let responseBody = "";

      request.setEncoding("utf8");
      request.on("response", (headers) => {
        const status = headers[":status"];
        statusCode = typeof status === "number" ? status : 0;
      });
      request.on("data", (chunk: string) => {
        responseBody += chunk;
      });
      request.on("error", reject);
      request.on("end", () => {
        if (statusCode >= 200 && statusCode < 300) {
          resolve();
          return;
        }
        reject(new Error(`APNs rejected notification with status ${statusCode}: ${responseBody}`));
      });
      request.end(payload);
    });
  }

  private authToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.currentToken && now - this.currentToken.issuedAt < 50 * 60) {
      return this.currentToken.value;
    }

    const header = base64UrlJson({ alg: "ES256", kid: this.config.keyId });
    const claims = base64UrlJson({ iss: this.config.teamId, iat: now });
    const signingInput = `${header}.${claims}`;
    const signature = createSign("SHA256")
      .update(signingInput)
      .sign({ key: this.signingKey, dsaEncoding: "ieee-p1363" });
    const value = `${signingInput}.${base64Url(signature)}`;
    this.currentToken = { value, issuedAt: now };
    return value;
  }
}

function base64UrlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
