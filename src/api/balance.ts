export type BalanceInfo = {
  currency: "CNY" | "USD" | string;
  total_balance: string;
  granted_balance?: string;
  topped_up_balance?: string;
};

export type UserBalance = {
  is_available: boolean;
  balance_infos: BalanceInfo[];
};

/** Fetches the DeepSeek account balance with the stored API key (BYOK). */
export async function fetchUserBalance(apiBase: string, apiKey: string): Promise<UserBalance> {
  const base = apiBase.replace(/\/$/, "");
  const response = await fetch(`${base}/user/balance`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`余额查询失败 ${response.status}: ${errText.slice(0, 200)}`);
  }
  return (await response.json()) as UserBalance;
}

/** Picks the preferred balance row (CNY first) for display. */
export function pickBalance(balance: UserBalance | null): BalanceInfo | null {
  if (!balance?.balance_infos?.length) {
    return null;
  }
  return (
    balance.balance_infos.find((b) => b.currency === "CNY") ?? balance.balance_infos[0] ?? null
  );
}
