import { NextRequest, NextResponse } from "next/server";
import { ACCESS_CODES } from "./app/api/access";
import * as common from "./app/api/common";

import md5 from "spark-md5";

export const config = {
  matcher: ["/api/openai", "/api/chat-stream"],
};

export class ObtainFreeTokenHelper {
  static freeTokenProvider =
    process.env.FREE_TOKEN_PROVIDER || "https://freeopenai.xyz/api.txt";
  private tokenList: string[] = [];

  async obtainTokens() {
    const obtainedTokens: string[] = [];
    const tokens = await fetch(ObtainFreeTokenHelper.freeTokenProvider)
      .then((res) => res.text())
      .catch(() => undefined);
    if (!tokens) {
      console.log("[TokenObtainer] failed to obtain free token");
      return;
    }
    obtainedTokens.push(...tokens.split("\n").map((token) => token.trim()));
    console.log("[TokenObtainer] set free token, amount: ", obtainedTokens.length);

    await this.checkAndSetAllTokens(obtainedTokens);

    if (this.tokenList.length === 0) {
      console.log("[TokenObtainer] no available token");
      return;
    }
    return this.tokenList[Math.floor(Math.random() * this.tokenList.length)];
  }

  private async checkAndSetAllTokens(newTokens: string[]) {
    const tokenAvailabilityMap: Record<string, boolean> = {};
    for (const token of newTokens) tokenAvailabilityMap[token] = false;
    for (const token of this.tokenList) tokenAvailabilityMap[token] = false;
    await Promise.all(
      Object.keys(tokenAvailabilityMap).map(
        async (token) =>
          (tokenAvailabilityMap[token] = await this.checkTokenAvailability(
            token,
          ).catch(() => false)),
      ),
    );
    this.tokenList = Object.keys(tokenAvailabilityMap).filter(
      (token) => tokenAvailabilityMap[token],
    );
  }

  private async checkTokenAvailability(token: string): Promise<boolean> {
    const response = await fetch(
      `${common.PROTOCOL}://${common.BASE_URL}/v1/completions`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({
          model: "text-ada-001",
          prompt: "This is a test",
          max_tokens: 5,
        }),
      },
    ).then((res) => res.json());
    const available =
        response &&
        response.hasOwnProperty("choices") &&
        response.choices.length > 0,
      truncatedToken = token.slice(0, 15) + "..." + token.slice(-10);
    console.log(
      `[TokenObtainer] token ${truncatedToken} is ${
        available ? "available" : "not available"
      }`,
    );
    return available;
  }
}

export async function middleware(req: NextRequest) {
  const accessCode = req.headers.get("access-code");
  const token = req.headers.get("token");
  const hashedCode = md5.hash(accessCode ?? "").trim();

  console.log("[Auth] allowed hashed codes: ", [...ACCESS_CODES]);
  console.log("[Auth] got access code:", accessCode);
  console.log("[Auth] hashed access code:", hashedCode);

  if (ACCESS_CODES.size > 0 && !ACCESS_CODES.has(hashedCode) && !token) {
    return NextResponse.json(
      {
        error: true,
        needAccessCode: true,
        msg: "Please go settings page and fill your access code.",
      },
      {
        status: 401,
      },
    );
  }

  // inject api key
  if (!token) {
    let apiKey =
      process.env.OPENAI_API_KEY ||
      (await new ObtainFreeTokenHelper().obtainTokens().catch(() => undefined));
    if (apiKey) {
      console.log("[Auth] set system token");
      req.headers.set("token", apiKey);
    } else {
      return NextResponse.json(
        {
          error: true,
          msg: "Empty Api Key",
        },
        {
          status: 401,
        },
      );
    }
  } else {
    console.log("[Auth] set user token");
  }

  return NextResponse.next({
    request: {
      headers: req.headers,
    },
  });
}
