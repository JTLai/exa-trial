import { z } from "zod";
import { krogerProductCode } from "./upc";

// Kroger has no national price: every price belongs to one store. The public Kroger Products API
// (developer.kroger.com, free client credentials) returns a given store's price by product code,
// so we pin one reference store instead of taking whichever store a crawler happens to land on.
// Server-only: credentials never reach the client.
const API = "https://api.kroger.com/v1";

export function krogerApiConfigured() {
  return !!(process.env.KROGER_CLIENT_ID && process.env.KROGER_CLIENT_SECRET);
}

let token: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  const basic = Buffer.from(`${process.env.KROGER_CLIENT_ID}:${process.env.KROGER_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${API}/connect/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "product.compact" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Kroger auth failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = z.object({ access_token: z.string(), expires_in: z.number() }).parse(await res.json());
  token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return token.value;
}

async function krogerGet(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Kroger ${path.split("?")[0]} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const locationSchema = z.object({
  data: z.array(z.object({ locationId: z.string(), name: z.string().nullish(), chain: z.string().nullish() })),
});

let location: Promise<{ id: string; name: string }> | null = null;

/** The reference store: KROGER_LOCATION_ID, else the Kroger store nearest KROGER_ZIP. */
export function referenceStore(): Promise<{ id: string; name: string }> {
  location ??= (async () => {
    const id = process.env.KROGER_LOCATION_ID;
    if (id) return { id, name: `store ${id}` };
    const zip = process.env.KROGER_ZIP;
    if (!zip) throw new Error("Set KROGER_LOCATION_ID or KROGER_ZIP to pick the Kroger reference store");
    const body = locationSchema.parse(await krogerGet(`/locations?filter.zipCode.near=${encodeURIComponent(zip)}&filter.chain=Kroger&filter.limit=1`));
    const store = body.data[0];
    if (!store) throw new Error(`No Kroger store near ${zip}`);
    return { id: store.locationId, name: store.name ?? `store ${store.locationId}` };
  })().catch((e) => {
    location = null;
    throw e;
  });
  return location;
}

const productSchema = z.object({
  data: z.object({
    productId: z.string(),
    upc: z.string().nullish(),
    description: z.string().nullish(),
    items: z
      .array(
        z.object({
          size: z.string().nullish(),
          price: z.object({ regular: z.number().nullish(), promo: z.number().nullish() }).nullish(),
          inventory: z.object({ stockLevel: z.string().nullish() }).nullish(),
        }),
      )
      .nullish(),
  }),
});

export type KrogerPrice = {
  found: boolean;
  storeId: string;
  storeName: string;
  description: string | null;
  size: string | null;
  /** Price a shopper pays now (promo if any). */
  price: number | null;
  regularPrice: number | null;
  availability: "in_stock" | "out_of_stock" | "unknown";
};

/** That store's price for the UPC, looked up by Kroger's product code (UPC without check digit). */
export async function krogerStorePrice(upc: string): Promise<KrogerPrice> {
  const store = await referenceStore();
  const raw = await krogerGet(`/products/${krogerProductCode(upc)}?filter.locationId=${encodeURIComponent(store.id)}`);
  const base = { storeId: store.id, storeName: store.name };
  if (!raw) return { ...base, found: false, description: null, size: null, price: null, regularPrice: null, availability: "unknown" };

  const { data } = productSchema.parse(raw);
  const item = data.items?.[0];
  const regular = item?.price?.regular || null;
  const promo = item?.price?.promo || null;
  const stock = item?.inventory?.stockLevel;
  return {
    ...base,
    found: true,
    description: data.description ?? null,
    size: item?.size ?? null,
    price: promo ?? regular,
    regularPrice: promo != null && regular != null && regular > promo ? regular : null,
    availability: stock === "TEMPORARILY_OUT_OF_STOCK" ? "out_of_stock" : stock ? "in_stock" : "unknown",
  };
}
