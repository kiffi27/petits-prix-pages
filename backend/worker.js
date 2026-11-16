const MAX_BODY_BYTES = 8192;
const MAX_ITEMS = 20;
const MAX_QUANTITY = 10;

function jsonResponse(body, status, origin, additionalHeaders = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin",
  };

  Object.assign(headers, additionalHeaders);
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "600";
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(message, status, origin, additionalHeaders) {
  return jsonResponse({ error: message }, status, origin, additionalHeaders);
}

function requestOriginIsAllowed(request, env) {
  return Boolean(env.ALLOWED_ORIGIN)
    && request.headers.get("Origin") === env.ALLOWED_ORIGIN;
}

async function rateLimitResponse(request, env) {
  const origin = requestOriginIsAllowed(request, env)
    ? request.headers.get("Origin")
    : null;
  const address = request.headers.get("CF-Connecting-IP");
  if (!env.API_RATE_LIMITER
    || typeof env.API_RATE_LIMITER.limit !== "function"
    || !address) {
    return errorResponse("La protection de l’API est indisponible.", 503, origin);
  }

  const result = await env.API_RATE_LIMITER.limit({
    key: address,
    delta: request.method === "POST" ? 10 : 1,
  });
  if (!result.success) {
    return errorResponse(
      "Trop de demandes. Réessayez dans une minute.",
      429,
      origin,
      { "Retry-After": "60" },
    );
  }

  return null;
}

function parseItems(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1 || !Array.isArray(body.items)
    || body.items.length < 1 || body.items.length > MAX_ITEMS) {
    return null;
  }

  const seen = new Set();
  const items = [];

  for (const item of body.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).length !== 2
      || typeof item.productId !== "string"
      || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.productId)
      || !Number.isSafeInteger(item.quantity)
      || item.quantity < 1 || item.quantity > MAX_QUANTITY
      || seen.has(item.productId)) {
      return null;
    }

    seen.add(item.productId);
    items.push({ productId: item.productId, quantity: item.quantity });
  }

  return items;
}

async function getProducts(env, origin) {
  if (env.STORE_ENABLED !== "true") {
    return errorResponse("La boutique est désactivée.", 503, origin);
  }
  if (!env.DB) return errorResponse("Catalogue indisponible.", 503, origin);

  const result = await env.DB.prepare(
    "SELECT id, shop_name AS shopName, name, price_xof AS priceXof, stock AS available "
      + "FROM products WHERE is_active = 1 AND stock > 0 AND trim(shop_name) != '' "
      + "ORDER BY name LIMIT 100",
  ).all();

  return jsonResponse({ products: result.results }, 200, origin);
}

async function createOrder(request, env, origin) {
  if (env.STORE_ENABLED !== "true" || env.ORDERS_ENABLED !== "true") {
    return errorResponse("Les commandes sont désactivées.", 503, origin);
  }
  if (!env.DB) return errorResponse("Commandes indisponibles.", 503, origin);

  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.split(";")[0].trim().toLowerCase() !== "application/json") {
    return errorResponse("Le format JSON est requis.", 415, origin);
  }

  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return errorResponse("La demande est trop volumineuse.", 413, origin);
  }

  const reader = request.body?.getReader();
  if (!reader) return errorResponse("La demande JSON est invalide.", 400, origin);
  const chunks = [];
  let bodySize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bodySize += value.byteLength;
    if (bodySize > MAX_BODY_BYTES) {
      await reader.cancel();
      return errorResponse("La demande est trop volumineuse.", 413, origin);
    }
    chunks.push(value);
  }
  const bodyBytes = new Uint8Array(bodySize);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const bodyText = new TextDecoder().decode(bodyBytes);

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return errorResponse("La demande JSON est invalide.", 400, origin);
  }

  const items = parseItems(body);
  if (!items) {
    return errorResponse("La sélection d’articles est invalide.", 400, origin);
  }

  const placeholders = items.map(() => "?").join(", ");
  const products = await env.DB.prepare(
    `SELECT id, shop_name AS shopName, name, price_xof AS priceXof, stock `
      + `FROM products WHERE is_active = 1 AND trim(shop_name) != '' `
      + `AND id IN (${placeholders})`,
  ).bind(...items.map((item) => item.productId)).all();

  if (products.results.length !== items.length) {
    return errorResponse("Un ou plusieurs articles ne sont pas disponibles.", 409, origin);
  }

  if (new Set(products.results.map((product) => product.shopName)).size !== 1) {
    return errorResponse("Les commandes de plusieurs boutiques ne sont pas ouvertes.", 409, origin);
  }

  const byId = new Map(products.results.map((product) => [product.id, product]));
  let totalXof = 0;
  for (const item of items) {
    const product = byId.get(item.productId);
    if (!Number.isSafeInteger(product.priceXof)
      || !Number.isSafeInteger(product.stock)
      || product.stock < item.quantity) {
      return errorResponse("Un ou plusieurs articles ne sont pas disponibles.", 409, origin);
    }

    const lineTotal = product.priceXof * item.quantity;
    if (!Number.isSafeInteger(lineTotal)
      || !Number.isSafeInteger(totalXof + lineTotal)) {
      return errorResponse("Le montant de la sélection ne peut pas être calculé.", 400, origin);
    }
    totalXof += lineTotal;
  }

  const orderId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const requestedValues = items.map(() => "(?, ?, ?)").join(", ");
  const requestedParams = items.flatMap((item) => [
    item.productId,
    item.quantity,
    byId.get(item.productId).priceXof,
  ]);
  const insertOrder = env.DB.prepare(
    `WITH requested(id, quantity, expected_price) AS (VALUES ${requestedValues}), `
      + "eligible AS ("
      + "SELECT p.id FROM products p JOIN requested r ON r.id = p.id "
      + "WHERE p.is_active = 1 AND p.price_xof = r.expected_price "
      + "AND p.stock >= r.quantity"
      + ") "
      + "INSERT INTO orders (id, status, total_xof, created_at) "
      + "SELECT ?, 'pending', ?, ? "
      + "WHERE (SELECT count(*) FROM eligible) = (SELECT count(*) FROM requested)",
  ).bind(...requestedParams, orderId, totalXof, createdAt);

  const statements = [insertOrder];
  for (const item of items) {
    const product = byId.get(item.productId);
    statements.push(env.DB.prepare(
      "INSERT INTO order_items "
        + "(order_id, product_id, product_name, shop_name, unit_price_xof, quantity, line_total_xof) "
        + "SELECT ?, id, name, shop_name, price_xof, ?, price_xof * ? "
        + "FROM products WHERE id = ? AND is_active = 1 AND stock >= ? "
        + "AND price_xof = ? AND shop_name = ? "
        + "AND EXISTS (SELECT 1 FROM orders WHERE id = ?)",
    ).bind(
      orderId,
      item.quantity,
      item.quantity,
      item.productId,
      item.quantity,
      product.priceXof,
      product.shopName,
      orderId,
    ));
  }

  const results = await env.DB.batch(statements);
  if (results[0]?.meta?.changes !== 1) {
    return errorResponse("Un ou plusieurs articles ne sont plus disponibles.", 409, origin);
  }

  return jsonResponse({
    order: {
      id: orderId,
      status: "pending",
      totalXof,
      payment: "not_enabled",
    },
  }, 201, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const limitError = await rateLimitResponse(request, env);
    if (limitError) return limitError;

    if (!requestOriginIsAllowed(request, env)) {
      return errorResponse("Origine non autorisée.", 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
          "Vary": "Origin",
        },
      });
    }

    const url = new URL(request.url);
    if (url.pathname === "/api/products" && request.method === "GET") {
      return getProducts(env, origin);
    }
    if (url.pathname === "/api/orders" && request.method === "POST") {
      return createOrder(request, env, origin);
    }

    if (url.pathname === "/api/products" || url.pathname === "/api/orders") {
      return errorResponse("Méthode non autorisée.", 405, origin);
    }
    return errorResponse("Route introuvable.", 404, origin);
  },
};
