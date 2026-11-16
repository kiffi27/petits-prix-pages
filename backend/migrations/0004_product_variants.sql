ALTER TABLE products
  ADD COLUMN variant_label TEXT NOT NULL DEFAULT ''
    CHECK (length(variant_label) <= 80);

ALTER TABLE order_items
  ADD COLUMN variant_label TEXT NOT NULL DEFAULT ''
    CHECK (length(variant_label) <= 80);
