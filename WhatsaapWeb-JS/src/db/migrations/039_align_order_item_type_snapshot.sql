-- Match the inventory types accepted by the commercial product editor.
ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS chk_order_items_item_type_snapshot,
  ADD CONSTRAINT chk_order_items_item_type_snapshot CHECK (
    item_type_snapshot IN ('physical_product', 'digital_product', 'service', 'course', 'subscription', 'custom')
  );
