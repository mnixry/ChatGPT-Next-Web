import { NextRequest, NextResponse } from "next/server";
import { ACCESS_CODES } from "./app/api/access";
import * as common from "./app/api/common";

import md5 from "spark-md5";

export const config = {
  matcher: ["/api/openai", "/api/chat-stream"],
};

export class ObtainFreeTokenHelper {
  private freeTokenProvider =
    process.env.FREE_TOKEN_PROVIDER || "https://freeopenai.xyz/api.txt";
  private tokenResponseCacheTime = process.env.TOKEN_RESPONSE_CACHE_TIME
    ? Number(process.env.TOKEN_RESPONSE_CACHE_TIME)
    : 5 * 60 * 1000;
  private tokenValidityTime = process.env.TOKEN_VALIDITY_TIME
    ? Number(process.env.TOKEN_VALIDITY_TIME)
    : 60 * 60 * 1000;

  async obtainTokens() {
    const obtainedTokens: string[] = [];
    let tokensText: string | undefined = undefined;

    tokensText = await fetch(this.freeTokenProvider, {
      next: { revalidate: this.tokenResponseCacheTime },
    })
      .then((res) => res.text())
      .catch(() => undefined);

    if (!tokensText) {
      console.log("[TokenObtainer] failed to obtain free token");
      return;
    }

    obtainedTokens.push(
      ...tokensText
        .split("\n")
        .map((token) => token.trim())
        .filter((token) => token.match(/^\w+?-\w+?$/)),
    );
    console.log(
      "[TokenObtainer] set free token, amount: ",
      obtainedTokens.length,
    );

    obtainedTokens.sort(() => Math.random() - 0.5);

    return this.raceAvailableToken(obtainedTokens);
  }

  private async raceAvailableToken(tokens: string[]) {
    const tokenAvailabilityMap: Record<string, boolean> = {};
    for (const token of tokens) tokenAvailabilityMap[token] = false;

    const token = await new Promise<string | undefined>((resolve, reject) =>
      Promise.allSettled(
        tokens.map((token) => this.checkTokenAvailability(token).then(resolve)),
      )
        .then(() => resolve(undefined))
        .catch(reject),
    );

    return token;
  }

  private async checkTokenAvailability(token: string) {
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
        next: { revalidate: this.tokenValidityTime },
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
    if (!available) throw null;
    return token;
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
      (await new ObtainFreeTokenHelper().obtainTokens());
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
