/**
 * Category and subcategory seed data using URL-style ids (aligned with customsportscards.com).
 * Use for seeding and for migration from old ids.
 */

/** Category id (URL slug) → { name, order } */
export const DEFAULT_CATEGORIES = [
  { id: "sports-cards-trading-cards", name: "Sports", order: 0 },
  { id: "weddings-save-the-date", name: "Weddings Save the Date", order: 1 },
  { id: "birth-announcements-trading-cards", name: "Birth Announcements", order: 2 },
  { id: "pets-trading-cards", name: "Pets", order: 3 },
  { id: "military-public-safety", name: "Military & Public Safety", order: 4 },
  { id: "promotional-corporate", name: "Promotional Corporate", order: 5 },
  { id: "music", name: "Music", order: 6 },
  { id: "life-style", name: "Life Style", order: 7 },
];

/** Subcategory: id (URL slug), categoryId (category slug), name, order */
export const DEFAULT_SUBCATEGORIES = [
  { id: "baseball", name: "Baseball", categoryId: "sports-cards-trading-cards", order: 0 },
  { id: "basketball", name: "Basketball", categoryId: "sports-cards-trading-cards", order: 1 },
  { id: "football", name: "Football", categoryId: "sports-cards-trading-cards", order: 2 },
  { id: "soccer", name: "Soccer", categoryId: "sports-cards-trading-cards", order: 3 },
  { id: "icehockey", name: "Ice Hockey", categoryId: "sports-cards-trading-cards", order: 4 },
  { id: "swimming", name: "Swimming", categoryId: "sports-cards-trading-cards", order: 5 },
  { id: "softball", name: "Softball", categoryId: "sports-cards-trading-cards", order: 6 },
  { id: "cheerleader", name: "Cheerleader", categoryId: "sports-cards-trading-cards", order: 7 },
  { id: "gymnastics", name: "Gymnastics", categoryId: "sports-cards-trading-cards", order: 8 },
  { id: "lacrosse", name: "Lacrosse", categoryId: "sports-cards-trading-cards", order: 9 },
  { id: "pickleball", name: "Pickleball", categoryId: "sports-cards-trading-cards", order: 10 },
  { id: "golf", name: "Golf", categoryId: "sports-cards-trading-cards", order: 11 },
  { id: "track-and-field", name: "Track and Field", categoryId: "sports-cards-trading-cards", order: 12 },
  { id: "motor-sports", name: "Motor Sports", categoryId: "sports-cards-trading-cards", order: 13 },
  { id: "martial-arts", name: "Martial Arts", categoryId: "sports-cards-trading-cards", order: 14 },
  { id: "racing", name: "Racing", categoryId: "sports-cards-trading-cards", order: 15 },
  { id: "basketball-weddings-save-the-date", name: "Basketball", categoryId: "weddings-save-the-date", order: 0 },
  { id: "baseball-weddings-save-the-date", name: "Baseball", categoryId: "weddings-save-the-date", order: 1 },
  { id: "football-weddings-save-the-date", name: "Football", categoryId: "weddings-save-the-date", order: 2 },
  { id: "hockey-weddings-save-the-date", name: "Hockey", categoryId: "weddings-save-the-date", order: 3 },
  { id: "baseball-birth-announcements-trading-cards", name: "Baseball", categoryId: "birth-announcements-trading-cards", order: 0 },
  { id: "basketball-birth-announcements-trading-cards", name: "Basketball", categoryId: "birth-announcements-trading-cards", order: 1 },
  { id: "football-birth-announcements-trading-cards", name: "Football", categoryId: "birth-announcements-trading-cards", order: 2 },
  { id: "hockey", name: "Hockey", categoryId: "birth-announcements-trading-cards", order: 3 },
  { id: "dog", name: "Dog", categoryId: "pets-trading-cards", order: 0 },
  { id: "horse", name: "Horse", categoryId: "pets-trading-cards", order: 1 },
  { id: "cats", name: "Cats", categoryId: "pets-trading-cards", order: 2 },
  { id: "parrots", name: "Parrots", categoryId: "pets-trading-cards", order: 3 },
  { id: "police", name: "Police", categoryId: "military-public-safety", order: 0 },
  { id: "firefighters", name: "Firefighters", categoryId: "military-public-safety", order: 1 },
  { id: "canine-police", name: "K9 / Canine Police", categoryId: "military-public-safety", order: 2 },
  { id: "employee", name: "Employee", categoryId: "promotional-corporate", order: 0 },
  { id: "music", name: "Music", categoryId: "music", order: 0 },
  { id: "life-style", name: "Life Style", categoryId: "life-style", order: 0 },
];

/** Old category id → new (URL slug) id for migration */
export const CATEGORY_OLD_TO_NEW = {
  sports: "sports-cards-trading-cards",
  "save-the-dates": "weddings-save-the-date",
  "birth-announcements": "birth-announcements-trading-cards",
  pets: "pets-trading-cards",
  "military-public-safety": "military-public-safety",
  promotional: "promotional-corporate",
  music: "music",
  lifestyle: "life-style",
};

/** Map key: "categoryId/subcategoryId" (old). Value: { categoryId: newCat, subcategoryId: newSub } */
export const SUBCATEGORY_OLD_TO_NEW = {
  "sports/baseball": { categoryId: "sports-cards-trading-cards", subcategoryId: "baseball" },
  "sports/basketball": { categoryId: "sports-cards-trading-cards", subcategoryId: "basketball" },
  "sports/football": { categoryId: "sports-cards-trading-cards", subcategoryId: "football" },
  "sports/soccer": { categoryId: "sports-cards-trading-cards", subcategoryId: "soccer" },
  "sports/hockey": { categoryId: "sports-cards-trading-cards", subcategoryId: "icehockey" },
  "sports/swimming": { categoryId: "sports-cards-trading-cards", subcategoryId: "swimming" },
  "sports/softball": { categoryId: "sports-cards-trading-cards", subcategoryId: "softball" },
  "sports/cheerleader": { categoryId: "sports-cards-trading-cards", subcategoryId: "cheerleader" },
  "sports/gymnastics": { categoryId: "sports-cards-trading-cards", subcategoryId: "gymnastics" },
  "sports/lacrosse": { categoryId: "sports-cards-trading-cards", subcategoryId: "lacrosse" },
  "sports/pickleball": { categoryId: "sports-cards-trading-cards", subcategoryId: "pickleball" },
  "sports/golf": { categoryId: "sports-cards-trading-cards", subcategoryId: "golf" },
  "sports/track-and-field": { categoryId: "sports-cards-trading-cards", subcategoryId: "track-and-field" },
  "sports/motor-sports": { categoryId: "sports-cards-trading-cards", subcategoryId: "motor-sports" },
  "sports/martial-arts": { categoryId: "sports-cards-trading-cards", subcategoryId: "martial-arts" },
  "sports/racing": { categoryId: "sports-cards-trading-cards", subcategoryId: "racing" },
  "save-the-dates/basketball": { categoryId: "weddings-save-the-date", subcategoryId: "basketball-weddings-save-the-date" },
  "save-the-dates/baseball": { categoryId: "weddings-save-the-date", subcategoryId: "baseball-weddings-save-the-date" },
  "save-the-dates/football": { categoryId: "weddings-save-the-date", subcategoryId: "football-weddings-save-the-date" },
  "save-the-dates/hockey": { categoryId: "weddings-save-the-date", subcategoryId: "hockey-weddings-save-the-date" },
  "birth-announcements/birth-announcement-baseball": { categoryId: "birth-announcements-trading-cards", subcategoryId: "baseball-birth-announcements-trading-cards" },
  "birth-announcements/birth-announcement-basketball": { categoryId: "birth-announcements-trading-cards", subcategoryId: "basketball-birth-announcements-trading-cards" },
  "birth-announcements/birth-announcement-foodball": { categoryId: "birth-announcements-trading-cards", subcategoryId: "football-birth-announcements-trading-cards" },
  "birth-announcements/birth-announcement-hockey": { categoryId: "birth-announcements-trading-cards", subcategoryId: "hockey" },
  "pets/dogs": { categoryId: "pets-trading-cards", subcategoryId: "dog" },
  "pets/horse": { categoryId: "pets-trading-cards", subcategoryId: "horse" },
  "pets/cats": { categoryId: "pets-trading-cards", subcategoryId: "cats" },
  "pets/parrots": { categoryId: "pets-trading-cards", subcategoryId: "parrots" },
  "military-public-safety/police": { categoryId: "military-public-safety", subcategoryId: "police" },
  "military-public-safety/firefighters": { categoryId: "military-public-safety", subcategoryId: "firefighters" },
  "military-public-safety/k9": { categoryId: "military-public-safety", subcategoryId: "canine-police" },
  "promotional/employee": { categoryId: "promotional-corporate", subcategoryId: "employee" },
  "music/music": { categoryId: "music", subcategoryId: "music" },
  "lifestyle/lifestyle": { categoryId: "life-style", subcategoryId: "life-style" },
};
