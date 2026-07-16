export type AlmaSet = {
  id: string;
  name: string;
  description?: string;
  type: { value: string; desc?: string };
  content: { value: string; desc?: string };
  created_date?: string;
  number_of_members?: { value?: number | string; link?: string };
};

export type SetMember = {
  id: string;
  description?: string;
  link?: string;
};

export type AlmaItem = {
  bib_data: { mms_id: string; title?: string };
  holding_data: { holding_id: string };
  item_data: { pid: string; barcode?: string; description?: string };
  [key: string]: unknown;
};

const DEFAULT_HOST = "https://api-eu.hosted.exlibrisgroup.com";

export class AlmaApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function isDuplicateBarcodeError(e: unknown): boolean {
  if (!(e instanceof AlmaApiError)) return false;
  if (e.code === "401873") return true;
  return (
    /barcode/i.test(e.message) &&
    /(exist|unique|already|duplicate|in use)/i.test(e.message)
  );
}

export class AlmaClient {
  private readonly apiKey: string;
  private readonly host: string;

  constructor(apiKey: string, host: string = DEFAULT_HOST) {
    this.apiKey = apiKey;
    this.host = host;
  }

  static fromEnv(): AlmaClient {
    const apiKey = process.env.ALMA_API_KEY;
    if (!apiKey) {
      throw new Error("Missing ALMA_API_KEY in environment.");
    }
    return new AlmaClient(apiKey, process.env.ALMA_API_HOST ?? DEFAULT_HOST);
  }

  private async request<T>(
    pathOrUrl: string,
    init: RequestInit & { query?: Record<string, string> } = {},
  ): Promise<T> {
    const url = pathOrUrl.startsWith("http")
      ? new URL(pathOrUrl)
      : new URL(`${this.host}/almaws/v1${pathOrUrl}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `apikey ${this.apiKey}`,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
        throw new AlmaApiError(
          `Non-JSON response from Alma (HTTP ${res.status}): ${snippet}`,
          undefined,
          res.status,
        );
      }
    }
    if (!res.ok) {
      const err = body as {
        errorList?: {
          error?: Array<{ errorMessage?: string; errorCode?: string }>;
        };
        errorMessage?: string;
      };
      const first = err?.errorList?.error?.[0];
      const message =
        first?.errorMessage ||
        err?.errorMessage ||
        `HTTP ${res.status} ${res.statusText}`;
      throw new AlmaApiError(message, first?.errorCode, res.status);
    }
    return body as T;
  }

  /** All sets whose content is physical items (itemized and logical). */
  async listItemSets(): Promise<AlmaSet[]> {
    const limit = 100;
    const all: AlmaSet[] = [];
    for (let offset = 0; ; offset += limit) {
      const data = await this.request<{
        total_record_count?: number;
        set?: AlmaSet[];
      }>("/conf/sets", {
        query: {
          content_type: "ITEM",
          limit: String(limit),
          offset: String(offset),
        },
      });
      const page = data.set ?? [];
      all.push(...page);
      const total = data.total_record_count ?? all.length;
      if (page.length === 0 || all.length >= total) break;
    }
    return all;
  }

  /** Full set details; unlike the list response this includes number_of_members. */
  async getSet(setId: string): Promise<AlmaSet> {
    return this.request<AlmaSet>(`/conf/sets/${encodeURIComponent(setId)}`);
  }

  async listSetMembers(
    setId: string,
    onProgress?: (fetched: number, total: number) => void,
  ): Promise<SetMember[]> {
    const limit = 100;
    const all: SetMember[] = [];
    for (let offset = 0; ; offset += limit) {
      const data = await this.request<{
        total_record_count?: number;
        member?: SetMember[];
      }>(`/conf/sets/${encodeURIComponent(setId)}/members`, {
        query: { limit: String(limit), offset: String(offset) },
      });
      const page = data.member ?? [];
      all.push(...page);
      const total = data.total_record_count ?? all.length;
      onProgress?.(all.length, total);
      if (page.length === 0 || all.length >= total) break;
    }
    return all;
  }

  async getItem(link: string): Promise<AlmaItem> {
    return this.request<AlmaItem>(link);
  }

  /** PUT the full item back with a new barcode. */
  async updateItemBarcode(item: AlmaItem, barcode: string): Promise<AlmaItem> {
    const { mms_id } = item.bib_data;
    const { holding_id } = item.holding_data;
    const { pid } = item.item_data;
    const updated: AlmaItem = {
      ...item,
      item_data: { ...item.item_data, barcode },
    };
    return this.request<AlmaItem>(
      `/bibs/${encodeURIComponent(mms_id)}/holdings/${encodeURIComponent(holding_id)}/items/${encodeURIComponent(pid)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      },
    );
  }
}
