const apiBaseUrl = document.querySelector('meta[name="store-api-url"]')?.content.trim() || "";
const cart = new Map();
const products = new Map();
const countElements = document.querySelectorAll("[data-cart-count]");
const itemsElement = document.querySelector("[data-cart-items]");
const totalElement = document.querySelector("[data-cart-total]");
const feedbackElement = document.querySelector("[data-cart-feedback]");
const productGrid = document.querySelector("[data-product-grid]");
const priceFormatter = new Intl.NumberFormat("fr-CI", {
  style: "currency",
  currency: "XOF",
  maximumFractionDigits: 0,
});

function showCatalogMessage(message) {
  const paragraph = document.createElement("p");
  paragraph.className = "product-empty";
  paragraph.setAttribute("role", "status");
  paragraph.textContent = message;
  productGrid.replaceChildren(paragraph);
}

function formatPrice(priceXof) {
  return priceFormatter.format(priceXof);
}

function renderProduct(product) {
  const card = document.createElement("article");
  card.className = "card product-card";

  const shop = document.createElement("p");
  shop.className = "product-category";
  shop.textContent = product.shopName;

  const name = document.createElement("h3");
  name.textContent = product.name;

  const variant = document.createElement("p");
  variant.className = "product-description";
  variant.textContent = product.variantLabel;

  const stock = document.createElement("p");
  stock.className = "product-description";
  stock.textContent = `Stock indiqué : ${product.available}`;

  const price = document.createElement("p");
  price.className = "product-price";
  price.textContent = formatPrice(product.priceXof);

  const button = document.createElement("button");
  button.className = "button button-green add-to-cart";
  button.type = "button";
  button.dataset.addToCart = product.id;
  button.textContent = "Ajouter au panier";

  card.append(shop, name);
  if (product.variantLabel) card.append(variant);
  card.append(stock, price, button);
  return card;
}

function isValidProduct(product) {
  return product !== null
    && typeof product === "object"
    && !Array.isArray(product)
    && typeof product.id === "string"
    && /^[a-zA-Z0-9_-]{1,80}$/.test(product.id)
    && typeof product.name === "string"
    && product.name.trim().length > 0
    && product.name.length <= 160
    && typeof product.variantLabel === "string"
    && product.variantLabel.length <= 80
    && typeof product.shopName === "string"
    && product.shopName.trim().length > 0
    && product.shopName.length <= 120
    && Number.isSafeInteger(product.priceXof)
    && product.priceXof > 0
    && Number.isSafeInteger(product.available)
    && product.available > 0;
}

function updateCart(message = "") {
  const count = Array.from(cart.values()).reduce((total, quantity) => total + quantity, 0);
  countElements.forEach((element) => {
    element.textContent = count;
  });
  itemsElement.replaceChildren();

  if (cart.size === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.className = "cart-empty";
    emptyMessage.textContent = "Votre panier est vide.";
    itemsElement.append(emptyMessage);
    totalElement.textContent = "—";
  } else {
    const list = document.createElement("ul");
    list.className = "cart-list";
    let totalXof = 0;

    cart.forEach((quantity, id) => {
      const product = products.get(id);
      if (!product) return;
      totalXof += product.priceXof * quantity;

      const item = document.createElement("li");
      item.className = "cart-item";
      const details = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = product.name;
      const note = document.createElement("span");
      const variant = product.variantLabel ? ` · ${product.variantLabel}` : "";
      note.textContent = `${product.shopName}${variant} · ${quantity} × ${formatPrice(product.priceXof)}`;
      details.append(name, note);

      const removeButton = document.createElement("button");
      removeButton.className = "cart-remove";
      removeButton.type = "button";
      removeButton.dataset.cartAction = "remove";
      removeButton.dataset.productId = id;
      const variantDescription = product.variantLabel ? ` ${product.variantLabel}` : "";
      removeButton.setAttribute("aria-label", `Retirer un article : ${product.name}${variantDescription}`);
      removeButton.textContent = "−";
      item.append(details, removeButton);
      list.append(item);
    });

    itemsElement.append(list);
    totalElement.textContent = Number.isSafeInteger(totalXof) ? formatPrice(totalXof) : "Indisponible";
  }

  feedbackElement.textContent = message;
}

function getCatalogUrl() {
  if (!apiBaseUrl) return null;

  const baseUrl = new URL(apiBaseUrl);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password) {
    throw new Error("L’adresse de l’API doit être une URL HTTPS valide.");
  }
  return new URL("/api/products", baseUrl);
}

async function loadCatalog() {
  if (!apiBaseUrl) {
    showCatalogMessage("Le catalogue réel sera affiché lorsque l’API sécurisée sera connectée.");
    return;
  }

  let catalogUrl;
  try {
    catalogUrl = getCatalogUrl();
  } catch {
    showCatalogMessage("Le catalogue ne peut pas être chargé : la configuration de l’API est invalide.");
    return;
  }

  try {
    const response = await fetch(catalogUrl, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      showCatalogMessage(
        response.status === 503
          ? "Le catalogue n’est pas encore ouvert."
          : "Le catalogue est momentanément indisponible.",
      );
      return;
    }

    const result = await response.json();
    if (!result || !Array.isArray(result.products) || result.products.length > 100
      || !result.products.every(isValidProduct)) {
      showCatalogMessage("Le catalogue reçu n’a pas un format valide.");
      return;
    }

    products.clear();
    result.products.forEach((product) => products.set(product.id, product));
    productGrid.replaceChildren();
    if (products.size === 0) {
      showCatalogMessage("Aucun article réel n’est disponible pour le moment.");
      return;
    }
    products.forEach((product) => productGrid.append(renderProduct(product)));
    updateCart();
  } catch {
    showCatalogMessage("Impossible de joindre le catalogue sécurisé pour le moment.");
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest?.("button");
  if (!button) return;

  if (button.dataset.addToCart) {
    const product = products.get(button.dataset.addToCart);
    if (!product) return;

    const quantity = cart.get(product.id) || 0;
    if (quantity >= Math.min(product.available, 10)) {
      updateCart("La quantité sélectionnée atteint la disponibilité affichée.");
      return;
    }
    cart.set(product.id, quantity + 1);
    updateCart("Article ajouté au panier temporaire. Aucune commande réelle n’est enregistrée.");
    return;
  }

  if (button.dataset.cartAction === "remove") {
    const id = button.dataset.productId;
    const quantity = cart.get(id);
    if (!quantity) return;

    if (quantity === 1) {
      cart.delete(id);
    } else {
      cart.set(id, quantity - 1);
    }
    updateCart("Article retiré du panier temporaire.");
  }
});

updateCart();
loadCatalog();
