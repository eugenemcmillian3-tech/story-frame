/**
 * Single source of truth for product naming.
 * Rename the product here; every screen reads from this object.
 */
export const PRODUCT = {
  name: 'StoryFrame',
  tagline: 'A faceless educational and storytelling video studio',
} as const;

export type ProductName = typeof PRODUCT.name;
