const API_BASE_URL = "https://api.cinetpay.net/v1";
const REQUEST_TIMEOUT_MS = 10000;

export class CinetPayConfigurationError extends Error {
  constructor() {
    super("La configuration CinetPay Sandbox est indisponible.");
    this.name = "CinetPayConfigurationError";
  }
}

export class CinetPayProviderError extends Error {
  constructor() {
    super("CinetPay n’a pas pu initialiser le paiement de test.");
    this.name = "CinetPayProviderError";
  }
}

function parseHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function getSandboxCredentials(env) {
  if (env.CINETPAY_MODE !== "sandbox"
    || typeof env.CINETPAY_SANDBOX_API_KEY !== "string"
    || !env.CINETPAY_SANDBOX_API_KEY.startsWith("sk_test_")
    || typeof env.CINETPAY_SANDBOX_API_PASSWORD !== "string"
    || env.CINETPAY_SANDBOX_API_PASSWORD.length === 0) {
    throw new CinetPayConfigurationError();
  }

  const allowedOrigin = parseHttpsUrl(env.ALLOWED_ORIGIN);
  const successUrl = parseHttpsUrl(env.CINETPAY_SUCCESS_URL);
  const failedUrl = parseHttpsUrl(env.CINETPAY_FAILED_URL);
  const notifyUrl = parseHttpsUrl(env.CINETPAY_NOTIFY_URL);
  if (!allowedOrigin || !successUrl || !failedUrl || !notifyUrl
    || successUrl.origin !== allowedOrigin.origin
    || failedUrl.origin !== allowedOrigin.origin) {
    throw new CinetPayConfigurationError();
  }

  return {
    apiKey: env.CINETPAY_SANDBOX_API_KEY,
    apiPassword: env.CINETPAY_SANDBOX_API_PASSWORD,
    successUrl: successUrl.href,
    failedUrl: failedUrl.href,
    notifyUrl: notifyUrl.href,
  };
}

async function postJson(fetchImpl, url, body, headers = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new CinetPayProviderError();
  }

  if (!response.ok) throw new CinetPayProviderError();

  try {
    return await response.json();
  } catch {
    throw new CinetPayProviderError();
  }
}

function getPaymentResult(response) {
  const paymentToken = response?.payment_token
    ?? response?.paymentToken
    ?? response?.data?.payment_token
    ?? response?.data?.paymentToken;
  const paymentUrl = response?.payment_url
    ?? response?.paymentUrl
    ?? response?.data?.payment_url
    ?? response?.data?.paymentUrl;

  if (typeof paymentToken !== "string" || paymentToken.length < 1 || paymentToken.length > 2048
    || typeof paymentUrl !== "string" || paymentUrl.length < 1 || paymentUrl.length > 2048) {
    throw new CinetPayProviderError();
  }

  let url;
  try {
    url = new URL(paymentUrl);
  } catch {
    throw new CinetPayProviderError();
  }

  const trustedHost = url.hostname === "cinetpay.com"
    || url.hostname.endsWith(".cinetpay.com")
    || url.hostname === "cinetpay.co"
    || url.hostname.endsWith(".cinetpay.co");
  if (url.protocol !== "https:" || !trustedHost || url.username || url.password) {
    throw new CinetPayProviderError();
  }

  return {
    paymentToken,
    paymentUrl: url.href,
  };
}

export async function initializeCinetPaySandboxPayment(
  { orderId, amountXof },
  env,
  fetchImpl = fetch,
) {
  const credentials = getSandboxCredentials(env);
  if (typeof orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(orderId)
    || !Number.isSafeInteger(amountXof) || amountXof < 1) {
    throw new TypeError("La demande de paiement Sandbox est invalide.");
  }

  const auth = await postJson(fetchImpl, `${API_BASE_URL}/oauth/login`, {
    api_key: credentials.apiKey,
    api_password: credentials.apiPassword,
  });
  if (typeof auth?.access_token !== "string"
    || auth.access_token.length < 1 || auth.access_token.length > 4096) {
    throw new CinetPayProviderError();
  }

  const result = await postJson(fetchImpl, `${API_BASE_URL}/payment`, {
    currency: "XOF",
    merchant_transaction_id: orderId,
    amount: amountXof,
    lang: "fr",
    designation: `Commande de test ${orderId}`,
    success_url: credentials.successUrl,
    failed_url: credentials.failedUrl,
    notify_url: credentials.notifyUrl,
    channel: "PUSH",
    direct_pay: false,
  }, {
    Authorization: `Bearer ${auth.access_token}`,
  });

  return getPaymentResult(result);
}
