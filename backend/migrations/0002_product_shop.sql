ALTER TABLE products
  ADD COLUMN shop_name TEXT NOT NULL DEFAULT ''
    CHECK (length(shop_name) <= 120);

ALTER TABLE order_items
  ADD COLUMN shop_name TEXT NOT NULL DEFAULT ''
    CHECK (length(shop_name) <= 120);

CREATE TRIGGER require_product_shop_name_before_insert
BEFORE INSERT ON products
WHEN trim(NEW.shop_name) = ''
BEGIN
  SELECT RAISE(ABORT, 'product shop name is required');
END;

CREATE TRIGGER require_product_shop_name_before_update
BEFORE UPDATE OF shop_name ON products
WHEN trim(NEW.shop_name) = ''
BEGIN
  SELECT RAISE(ABORT, 'product shop name is required');
END;

CREATE TRIGGER require_order_item_shop_name_before_insert
BEFORE INSERT ON order_items
WHEN trim(NEW.shop_name) = ''
BEGIN
  SELECT RAISE(ABORT, 'order item shop name is required');
END;
