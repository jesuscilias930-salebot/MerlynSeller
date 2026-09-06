-- Image collections are reusable chat assets. They are independent from a
-- Control de ventas bundle, so their category is stored separately from the
-- bundle type used to group bundle photographs.
ALTER TABLE entrepreneur_packages
  ADD COLUMN IF NOT EXISTS image_category text;

ALTER TABLE entrepreneur_packages
  ADD CONSTRAINT entrepreneur_packages_image_category_length
  CHECK (image_category IS NULL OR char_length(image_category) <= 120);

CREATE INDEX IF NOT EXISTS entrepreneur_packages_image_category_idx
  ON entrepreneur_packages (organization_id, image_category, position)
  WHERE control_bundle_id IS NULL;
