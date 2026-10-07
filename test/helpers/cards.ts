import type { CardListing, ItemDetail } from "../../src/vinted/types.js";

export function makeCard(overrides: Partial<CardListing> = {}): CardListing {
  return {
    vintedId: "1001",
    title: "iPhone 15 128GB",
    brand: "Apple",
    model: "iPhone 15",
    condition: "very_good",
    pricePence: 26320,
    itemPricePence: 24999,
    photoUrl: "https://images1.vinted.net/t/1001/310x430/a.webp",
    url: "https://www.vinted.co.uk/items/1001-iphone-15",
    ...overrides,
  };
}

export function makeDetail(overrides: Partial<ItemDetail> = {}): ItemDetail {
  return {
    description: "Battery 89%, always in a case",
    attributes: { internal_memory_capacity: "128 GB", sim_lock: "Unlocked", status: "Very good", upload_date: "2 min ago" },
    photos: ["https://images1.vinted.net/t/1001/f800/a.webp"],
    sellerRating: 0.98,
    sellerFeedbackCount: 122,
    unavailable: false,
    uploadedText: "2 min ago",
    ...overrides,
  };
}
