CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  price_xof INTEGER NOT NULL CHECK (price_xof > 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1))
);

CREATE INDEX products_catalogue_idx
  ON products (is_active, stock, name);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'cancelled', 'fulfilled')),
  total_xof INTEGER NOT NULL CHECK (total_xof > 0),
  created_at TEXT NOT NULL
);

CREATE INDEX orders_created_at_idx ON orders (created_at);

CREATE TABLE order_items (
  order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  unit_price_xof INTEGER NOT NULL CHECK (unit_price_xof > 0),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  line_total_xof INTEGER NOT NULL CHECK (line_total_xof = unit_price_xof * quantity),
  PRIMARY KEY (order_id, product_id)
);

CREATE TRIGGER reserve_order_item_stock
AFTER INSERT ON order_items
BEGIN
  UPDATE products
  SET stock = stock - NEW.quantity
  WHERE id = NEW.product_id
    AND is_active = 1
    AND price_xof = NEW.unit_price_xof
    AND stock >= NEW.quantity;

  SELECT CASE
    WHEN changes() != 1 THEN RAISE(ABORT, 'product is no longer available')
  END;
END;
