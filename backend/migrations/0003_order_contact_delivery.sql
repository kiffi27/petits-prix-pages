ALTER TABLE orders
  ADD COLUMN customer_name TEXT NOT NULL DEFAULT ''
    CHECK (length(customer_name) <= 160);

ALTER TABLE orders
  ADD COLUMN customer_phone TEXT NOT NULL DEFAULT ''
    CHECK (length(customer_phone) <= 32);

ALTER TABLE orders
  ADD COLUMN customer_email TEXT NOT NULL DEFAULT ''
    CHECK (length(customer_email) <= 254);

ALTER TABLE orders
  ADD COLUMN delivery_shop_name TEXT NOT NULL DEFAULT ''
    CHECK (length(delivery_shop_name) <= 120);

ALTER TABLE orders
  ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'not_enabled'
    CHECK (payment_status IN ('not_enabled', 'pending', 'paid', 'failed'));

ALTER TABLE orders
  ADD COLUMN dispatched_at TEXT
    CHECK (dispatched_at IS NULL OR length(dispatched_at) > 0);

ALTER TABLE orders
  ADD COLUMN cancelled_at TEXT
    CHECK (cancelled_at IS NULL OR length(cancelled_at) > 0);

CREATE TRIGGER require_order_contact_and_delivery_shop
BEFORE INSERT ON orders
WHEN trim(NEW.customer_name) = ''
  OR trim(NEW.customer_phone) = ''
  OR trim(NEW.customer_email) = ''
  OR trim(NEW.delivery_shop_name) = ''
BEGIN
  SELECT RAISE(ABORT, 'order contact and delivery shop are required');
END;

CREATE TRIGGER require_orders_to_start_pending_and_unpaid
BEFORE INSERT ON orders
WHEN NEW.status != 'pending'
  OR NEW.payment_status != 'not_enabled'
  OR NEW.dispatched_at IS NOT NULL
  OR NEW.cancelled_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'orders must start pending with payment disabled');
END;

CREATE TRIGGER require_order_items_to_match_delivery_shop
BEFORE INSERT ON order_items
WHEN NEW.shop_name != (
  SELECT delivery_shop_name FROM orders WHERE id = NEW.order_id
)
BEGIN
  SELECT RAISE(ABORT, 'order item shop must match delivery shop');
END;

CREATE TRIGGER require_unpaid_pending_order_for_cancellation
BEFORE UPDATE OF status ON orders
WHEN NEW.status = 'cancelled'
  AND OLD.status != 'cancelled'
  AND (
    OLD.status != 'pending'
    OR OLD.payment_status != 'not_enabled'
    OR OLD.dispatched_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'only a non-payment-enabled pending order can be cancelled');
END;

CREATE TRIGGER require_paid_pending_order_for_dispatch
BEFORE UPDATE OF dispatched_at ON orders
WHEN NEW.dispatched_at IS NOT NULL
  AND (
    OLD.status != 'pending'
    OR OLD.payment_status != 'paid'
    OR OLD.cancelled_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'only a paid pending order can be dispatched');
END;

CREATE TRIGGER prevent_rewriting_dispatch_timestamp
BEFORE UPDATE OF dispatched_at ON orders
WHEN OLD.dispatched_at IS NOT NULL
  AND NEW.dispatched_at IS NOT OLD.dispatched_at
BEGIN
  SELECT RAISE(ABORT, 'dispatch timestamp cannot be changed');
END;

CREATE TRIGGER prevent_reopening_cancelled_order
BEFORE UPDATE OF status ON orders
WHEN OLD.status = 'cancelled'
  AND NEW.status != 'cancelled'
BEGIN
  SELECT RAISE(ABORT, 'cancelled order cannot be reopened');
END;

CREATE TRIGGER require_cancellation_timestamp
BEFORE UPDATE OF status ON orders
WHEN NEW.status = 'cancelled'
  AND NEW.cancelled_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'cancellation timestamp is required');
END;

CREATE TRIGGER prevent_cancellation_timestamp_without_cancel
BEFORE UPDATE OF cancelled_at ON orders
WHEN NEW.cancelled_at IS NOT NULL
  AND NEW.status != 'cancelled'
BEGIN
  SELECT RAISE(ABORT, 'cancellation timestamp requires cancelled order');
END;

CREATE TRIGGER prevent_rewriting_cancellation_timestamp
BEFORE UPDATE OF cancelled_at ON orders
WHEN OLD.cancelled_at IS NOT NULL
  AND NEW.cancelled_at IS NOT OLD.cancelled_at
BEGIN
  SELECT RAISE(ABORT, 'cancellation timestamp cannot be changed');
END;

CREATE TRIGGER restore_stock_after_shop_cancellation
AFTER UPDATE OF status ON orders
WHEN OLD.status != 'cancelled'
  AND NEW.status = 'cancelled'
BEGIN
  UPDATE products
  SET stock = stock + (
    SELECT quantity FROM order_items
    WHERE order_id = NEW.id AND product_id = products.id
  )
  WHERE id IN (SELECT product_id FROM order_items WHERE order_id = NEW.id);
END;
