/**
 * update-descriptions.ts
 * Matches kiosk menu-data.js descriptions to DB menu_items and applies updates.
 * Run with: bun v2/scripts/update-descriptions.ts [--dry-run]
 */

import { Database } from "bun:sqlite";
import { join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

// ── All descriptions extracted from hanuman-thai-cafe/js/menu-data.js ──────
const kioskDishes: { name: string; desc: string }[] = [
  { name: "Fresh Rolls", desc: "Rice wrapper, tofu or prawns, fresh vegetables and basil. Served w/homemade plumb sauce or peanut Sauce" },
  { name: "Spring Rolls", desc: "Deep-fried spring roll stuffed w/carrots, bean thread noodle and cabbage. Includes a side of plum sauce." },
  { name: "Pot Sticker", desc: "Dumpling filled with chicken, mixed vegetables, steamed or deep-fried" },
  { name: "Chicken Satay", desc: "Strips of chicken marinated in curry, coconut milk, and spices, served with gluten-free peanut sauce and cucumber salad." },
  { name: "Tofu Satay", desc: "Strips of pan-fried tofu marinated in curry, coconut milk, and spices, served with gluten-free peanut sauce and cucumber salad." },
  { name: "Coconut Prawns", desc: "Crunchy, golden prawns, flecked with coconut and served with plum sauce." },
  { name: "Mixed Appetizers", desc: "2 skewers of chicken satay, 3 pieces of crab delight, 2 spring rolls, and 4 pieces of golden fried tofu." },
  { name: "Thai Style Fried Calamari", desc: "Served with our sweet plum sauce." },
  { name: "Chicken Wings", desc: "Home made, marinated and deep-fried served with sweet chili sauce." },
  { name: "Night Market Sausage", desc: "From Chiang Rai Night Bazaar: A unique blend of ground pork, kaffir lime leaves, curry paste, served with cucumber, lettuce, fresh chili, and ginger." },
  { name: "Vegetable Cakes", desc: "Rice cakes filled with Chinese Leeks, served with sweet and sour sauce." },
  { name: "Khao Taen (Rice Crackers)", desc: "Thai street food snacks made with fried crispy sticky rice drizzled with a variety of flavors." },
  { name: "Vegan Delight Sampler", desc: "4 pieces of vegetable cake, 3 spring rolls and 5 pieces of fried tofu with plum sauce and sweet chili sauce." },
  { name: "Golden Fried Tofu", desc: "Deep-fried tofu served with plum sauce and ground peanut." },
  { name: "Papaya Salad", desc: "Shredded fresh green papaya, carrot, tomatoes, green beans and peanuts in our spicy lime dressing." },
  { name: "Larb Gai", desc: "Ground chicken tossed with lime juice, Thai spices, onions, a touch of chili, roasted rice powder and cilantro." },
  { name: "Yum Nua (Thai Beef Salad)", desc: "Grilled marinated beef tossed in lime juice, Thai spices with a touch of our smoked chili paste, onions, cilantro, cucumber, tomatoes." },
  { name: "Duck Salad", desc: "Roasted duck with green & red onion, carrot, tomatoes, cucumber & cilantro in our lime dressing." },
  { name: "Yum Woon Sen", desc: "Steamed prawns & ground chicken tossed with bean thread noodles, onions, cilantro, tomatoes, cucumbers & lime juice." },
  { name: "Avocado Corn Salad", desc: "Prawns, young corn, and avocado salad in spicy lime dressing." },
  { name: "Mango Salad", desc: "Fresh Mango, carrot, tomato, red onion, apple and peanut in our lime dressing" },
  { name: "Tom Kha", desc: "The popular Thai coconut milk soup simmered with lemongrass, galangal, kaffir lime leaves, mushroom, onion and cilantro." },
  { name: "Tom Yum", desc: "Traditional Thai hot and sour soup with lemongrass and kaffir lime leaves infused broth, mushroom, onion, cilantro and tomatoes." },
  { name: "Wonton Soup", desc: "Homemade dumpling filled with ground chicken, prawns and mild spice cooked in a clear broth with bok choy." },
  { name: "Tom Zap", desc: "Hot and sour soup with chili, onions, galangal, lemongrass, tomatoes, mushrooms, lime juice and Thai herbs." },
  { name: "Tofu Soup", desc: "Spinach and soft tofu in clear broth, scallion, roasted garlic, cilantro." },
  { name: "Garlic Fish", desc: "Deep-fried whole trout marinated lightly in garlic sauce and black pepper." },
  { name: "Thai BBQ Beef", desc: "Grilled Flat Iron steak served with Jaew dipping sauce and sticky rice." },
  { name: "Duck Basil", desc: "Stir-fried duck with basil, green beans, onion, garlic, bell peppers served on a sizzling plate." },
  { name: "Hanuman's Prawns", desc: "Stir-fried chili sauce with prawns, broccoli, carrots, zucchini, bell peppers." },
  { name: "Thai Style Fried Chicken (Gai Tod)", desc: "A popular street food, deep fried chicken topped with fried shallots served with sticky rice and sweet chili sauce." },
  { name: "Hanuman's Typhoon", desc: "A combination of mussels, clams, prawns, squids, sauteed with chili paste, bell peppers, zucchini, basil and mushrooms." },
  { name: "Hanuman's Ginger Salmon", desc: "Salmon dipped in light batter and deep-fried, topped with ginger shiitake mushroom sauce, onions, bell peppers." },
  { name: "Panang Neua Yang", desc: "Grilled Flat Iron steak in hanuman curry sauce with basil, bell peppers and kaffir lime." },
  { name: "Cha-Cha-Cha", desc: "Pan-fried seafood, green beans, bell peppers, broccoli, zucchini, topped with crispy basil, served on a sizzling plate." },
  { name: "Pla Chu Chi", desc: "Deep fried trout topped with panang curry sauce, bell pepper and Thai basil." },
  { name: "Sweet And Sour Fish", desc: "Deep fried trout topped with bell tomato, onions, cucumber, pineapple, stir fried in hanuman sauce." },
  { name: "Cashew Nut Lovers", desc: "Sauteed meat or tofu in our own smoked chili sauce, zucchini, celery, onion, bell pepper, carrot, mushroom and roasted cashew nut." },
  { name: "Crispy Garlic Chicken", desc: "Stir-fried crispy chicken with roasted garlic in our special sauce, onion, bell peppers topped with crispy basil." },
  { name: "Orange Chicken", desc: "Strips of chicken breast dipped in batter and deep-fried to a crispy golden brown then sauteed with onion, carrot, orange, ginger." },
  { name: "Vegetable Deluxe", desc: "Broccoli, carrot, zucchini, snow pea, mushroom, celery, cabbage, stir fried with fresh garlic sauce." },
  { name: "Garlic Lover", desc: "Meat or tofu marinated lightly in garlic and black pepper then sauteed and served with steamed broccoli, carrot, cilantro." },
  { name: "Pad Basil", desc: "Very popular Thai dish for any time of the day. Meat or tofu sauteed with onion, bell peppers, Thai basil." },
  { name: "Kapow Gai with Fried Egg", desc: "The common Thai street food of ground chicken, stir-fried with fresh basil, garlic, onion, bell peppers with fried egg." },
  { name: "Lemongrass Chicken", desc: "Boneless chicken breast marinated in a mixture of curry, lemongrass, char-broiled, served with mixed vegetables and our sweet chili sauce." },
  { name: "Swimming Rama", desc: "Sauteed meat or tofu on a bed of spinach topped with peanut sauce." },
  { name: "Prik Khing", desc: "Meat or tofu, green beans, bell peppers sauteed with garlic, peanut sauce and a touch of Thai chili paste." },
  { name: "Heavenly Beef", desc: "Tender beef marinated with coriander powder sauteed in our special sweet sauce, served sizzling hot on a bed of onion." },
  { name: "Sweet'n Sour Stir-Fry", desc: "A medley of colorful vegetables sauteed with homemade sweet and sour sauce." },
  { name: "Ginger Garden", desc: "Stir-fried meat or tofu with fresh ginger, mushroom, bell pepper and onion." },
  { name: "Pad Thai", desc: "A traditional favorite stir-fried rice noodle with your choice of meat or tofu, eggs, onion and bean sprouts topped with ground peanuts." },
  { name: "Pad See-Ew", desc: "Wide fresh rice noodle stir-fried with eggs, broccoli, savory soy sauce and your choice of meat." },
  { name: "Pad Kee Mao", desc: "Wide rice noodle stir-fried with eggs, chili peppers, bamboo shoots, broccoli, bell pepper, tomatoes, onion and Thai basil." },
  { name: "Pad Woon Sen", desc: "Stir-fried bean thread noodle with eggs, tomatoes, green onion, bean sprouts and celery." },
  { name: "Mama Pad", desc: "Mama noodles with eggs, carrots, cabbage, broccoli, snow peas and bell peppers. Stir-fried in house sauce." },
  { name: "Golden Noodles", desc: "Wide rice noodle stir-fried with eggs, broccoli, bell peppers, tomatoes, onions, green beans, carrots and Thai basil in house sauce." },
  { name: "Rama Noodles", desc: "Sauteed rice noodle served on a bed of spinach topped with peanut sauce." },
  { name: "Rice Noodle Soup", desc: "Rice noodle, bean sprouts, carrots, snow peas, bok choy, green onions, cilantro." },
  { name: "Curry Noodle Soup", desc: "Rice noodle in curry broth, bean sprouts, carrots, snow peas, bok choy, green onion, cilantro." },
  { name: "Lard Nah", desc: "Wide fresh rice noodles lightly pan-fried in sweet soy sauce then topped with a gravy of garlic, broccoli and oyster sauce." },
  { name: "Kow Soi", desc: "Northern Thai style stewed chicken drumsticks served with steamed egg noodle in creamy curry topped with crispy noodle." },
  { name: "Bah Mee", desc: "Steamed egg noodle, bean sprouts, baby bok choy, garlic sauce, ground peanuts, green onions and cilantro." },
  { name: "Duck Noodle Soup", desc: "Slices of roasted duck in duck broth with rice noodle and baby bok choy." },
  { name: "Beef Noodle Soup", desc: "A warming and favorite Thai soup: Rice noodles, bok choy, roasted garlic, green onion, cilantro in Hanuman broth." },
  { name: "Tom Yum Noodle Soup", desc: "Rice noodle with chicken in hot and sour soup with broccoli, carrots, bean sprouts, snow peas, cilantro, green onions, baby bok choy." },
  { name: "Panang Curry", desc: "A very popular curry, cooked with your choice of meat or tofu with coconut milk chili paste, Thai herb, bell peppers and Thai sweet basil." },
  { name: "Red Curry", desc: "Red curry in coconut milk, bamboo shoots, green beans, zucchini, bell peppers, Thai sweet basil." },
  { name: "Yellow Curry", desc: "Your choice of meat or tofu in Yellow curry, bamboo shoots, potatoes, onions, carrots." },
  { name: "Massaman Curry", desc: "Your choice of meat or tofu in massaman curry, potatoes, carrots, pineapple, onions and roasted peanuts." },
  { name: "Roast Duck Curry", desc: "Roast duck in red curry and coconut milk with cherry tomatoes, pineapple, lychees, bell peppers and Thai sweet basil." },
  { name: "Northern Thai Curry (Gaeng Hang Lay)", desc: "Travel to Northern Thailand with this specialty dish, slow-cooked beef, an aromatic blend of ginger, garlic, tamarind, and local spices." },
  { name: "Salmon Curry", desc: "A 8 oz piece of Salmon in Panang curry, with bell peppers and basil." },
  { name: "Green Curry", desc: "One of our spicy curries with coconut milk, bamboo shoots, zucchini, green beans and Thai sweet basil, bell peppers." },
  { name: "Avocado Curry", desc: "Your choice of meat or tofu in green curry, avocado, bamboo shoots and basil." },
  { name: "Thai Fried Rice", desc: "A popular dish, stir-fried jasmine rice with eggs, onions, carrot, broccoli, tomatoes and cilantro." },
  { name: "Garlic Fried Rice", desc: "Roasted garlic stir-fried with jasmine rice, egg, broccoli, onions, carrots, bell peppers and cilantro." },
  { name: "Basil Fried Rice", desc: "Stir-fried jasmine rice with fresh basil, eggs, mushrooms, onions, bell peppers." },
  { name: "Crab Fried Rice", desc: "Stir-fried jasmine rice with crab meat, eggs, onion, carrots, green onions, served with cucumber." },
  { name: "Thai Chili Paste Fried Rice", desc: "Stir-fried jasmine rice with eggs, onions, broccoli, tomato, bell peppers, carrots, chili paste and cilantro." },
  { name: "Pineapple Fried Rice", desc: "Stir-fried rice with egg, onion, pineapple, carrots, peas, yellow powder, raisins, tomatoes and cashew nuts." },
  { name: "Steamed Rice & Vegetables", desc: "For the health-conscious palate, this dish contains no oil or gluten with your choice of Chicken or Steamed tofu." },
  { name: "Evergreen Stir-Fry", desc: "A medley of fresh green vegetables (broccoli, snow peas, green beans, and Bok choy), stir-fried with our signature house sauce." },
  { name: "Eggplants", desc: "Eggplant sauteed with chili, basil, bell peppers, onions." },
  { name: "Green Beans", desc: "Roasted garlic stir-fried with fresh green beans in oyster sauce." },
  { name: "Broccoli Oyster Sauce", desc: "Broccoli sauteed in garlic, Thai herbs and oyster sauce." },
  { name: "Mango Sweet Sticky Rice", desc: "The taste of this tropical rice pudding and mango is irresistible! This dessert is vegan." },
  { name: "Mango Ice Cream and Sticky Rice", desc: "A scoop of gourmet Mango Ice Cream, Sweet Pandan Sticky Rice, Whip Cream and Peanuts." },
  { name: "Kao Tom Mud", desc: "Thai sweet sticky rice pudding with bananas, black beans, coconut milk, and peanuts, wrapped and steamed in banana leaves." },
  { name: "Ice Cream", desc: "One scoop of our gourmet Thai Ice Cream with your choice of toppings." },
  { name: "Black Rice Pudding", desc: "Our Thai Black Rice combined with our coconut sauce and some blueberries, makes a delicious and healthy vegan dessert." },
  { name: "Guilt-Free Fried Bananas", desc: "Fried bananas with a scoop of coconut ice cream, whipped-cream and blueberries!" },
  { name: "Thai Ice Tea", desc: "A sweet and creamy Thai iced tea beverage." },
  { name: "Thai Ice Coffee", desc: "A rich and creamy Thai iced coffee beverage." },
  { name: "Matcha Thai Iced Tea", desc: "A creamy and slightly sweetened green tea beverage." },
  { name: "Mango Juice", desc: "Pure and refreshing mango juice." },
  { name: "Lemonade", desc: "One can of Minute Maid lemonade." },
  { name: "Hot Tea", desc: "Green Tea, Jasmine Tea, Mango Citron, Butterfly Tea, Lavender Camomille, Ginger Lemongrass" },
  { name: "Singha", desc: "Thai lager beer" },
  { name: "Sapporo", desc: "Japanese lager beer" },
  { name: "Space Dust IPA", desc: "Elysian Space Dust IPA" },
  { name: "Sauvignon Blanc", desc: "Chateau Ste-Michelle" },
  { name: "Chardonnay", desc: "Chateau Ste-Michelle" },
  { name: "Pinot Gris", desc: "A-Z Oregon" },
  { name: "Pinot Noir", desc: "A-Z Oregon" },
  { name: "Cabernet Sauvignon", desc: "Chateau Ste-Michelle" },
  { name: "Combo 1", desc: "Includes: Cashew Chicken or Tofu, Jasmine Rice, Two Spring Rolls, Orange Chicken" },
  { name: "Combo 2", desc: "Includes: Orange Chicken or Tofu, Jasmine Rice, Pad Thai, Ginger Chicken" },
  { name: "Combo 3", desc: "Includes: Ginger Chicken or Tofu, Jasmine Rice, Two Spring Rolls, Chicken Basil" },
  { name: "Combo 4", desc: "Includes: Basil Chicken or Tofu, Jasmine Rice, Pad Thai, Panang Curry" },
  { name: "Combo 5", desc: "Includes: Panang Curry (Chicken or Tofu), Jasmine Rice, Pad Thai, Yellow Curry" },
  { name: "Combo 6", desc: "Includes: Yellow Curry (Chicken or Fried Tofu), Jasmine Rice, Two Spring Rolls, Pad Thai" },
  { name: "Combo 7", desc: "Includes: Pad Thai, Jasmine Rice, Two Spring Rolls" },
  { name: "Combo 8", desc: "Includes: Vegetable Deluxe, Jasmine Rice, Two Spring Rolls" },
  { name: "Combo 9", desc: "Includes: Your choice of Tom Kha or Tom Yum soup, Jasmine Rice, Two Spring Rolls" },
  { name: "Combo 10", desc: "Tender poached chicken served over fragrant rice cooked in rich chicken broth. Accompanied by fresh cucumber slices, a tangy ginger-chili dipping sauce and a cup of vegetable broth." },
];

/**
 * Normalizes a dish name for fuzzy matching:
 * - Strips leading number prefix (e.g. "12. ", "56. ")
 * - Lowercases, removes apostrophes, collapses whitespace
 */
function norm(s: string): string {
  return s
    .replace(/^\d+\.\s*/, "")           // strip "12. "
    .replace(/COMBO\s+(\d+)\..+/i, "combo $1") // "COMBO 1. ..." → "combo 1"
    .toLowerCase()
    .replace(/[''']/g, "")              // apostrophes
    .replace(/\s+/g, " ")
    .trim();
}

// Build lookup map: normalized kiosk name → description
const kioskMap = new Map<string, string>();
for (const d of kioskDishes) {
  kioskMap.set(norm(d.name), d.desc);
}

// Manual aliases: normalized DB name → normalized kiosk name
// Used when the DB name and kiosk name differ beyond simple normalization.
const aliases = new Map<string, string>([
  ["coconut prawn",                               "coconut prawns"],
  ["pot stickers",                                "pot sticker"],
  ["kapow gai",                                   "kapow gai with fried egg"],
  ["chili paste fried rice",                      "thai chili paste fried rice"],
  ["mango sticky rice",                           "mango sweet sticky rice"],
  ["mango ice cream with sweet sticky rice",      "mango ice cream and sticky rice"],
  ["kao tom mud",                                 "kao tom mud"],        // trailing space in DB
  ["thai iced coffee",                            "thai ice coffee"],
  ["thai iced tea",                               "thai ice tea"],
  ["hot tea",                                     "hot tea"],
  ["steamed rice & vegetables with chicken or tofu", "steamed rice & vegetables"],
  ["tofu saty",                                   "tofu satay"],         // typo in DB
  ["veggy deluxe",                                "vegetable deluxe"],
  ["sweet and sour stir-fry",                     "sweetn sour stir-fry"],
  ["hanumanss prawns",                            "hanumanss prawns"],
  ["evergreen stir fry",                          "evergreen stir-fry"],
  ["combo 3 - ginger stir-fry",                   "combo 3"],
  ["combo 4 - basil stir-fry",                    "combo 4"],
  // wine variants — share the same base description
  ["sauvignon blanc (glass)",                     "sauvignon blanc"],
  ["sauvignon blanc (half bottle)",               "sauvignon blanc"],
  ["sauvignon blanc (full-bottle)",               "sauvignon blanc"],
  ["chardonnay (glass)",                          "chardonnay"],
  ["chardonnay (half-bottle)",                    "chardonnay"],
  ["pinot gris (half-bottle)",                    "pinot gris"],
  ["pinot noir (half-bottle)",                    "pinot noir"],
  ["cabernet sauvignon (half bottle)",            "cabernet sauvignon"],
]);

// ── Open DB ────────────────────────────────────────────────────────────────
const dbPath = join(import.meta.dir, "../data/merchant.db");
const db = new Database(dbPath);

const allItems = db
  .query<{ id: string; name: string; description: string | null }, []>(
    "SELECT id, name, description FROM menu_items"
  )
  .all();

const toUpdate: { id: string; dbName: string; desc: string }[] = [];
const unmatched: string[] = [];

for (const item of allItems) {
  const key = norm(item.name);
  const kioskKey = kioskMap.has(key) ? key : (aliases.get(key) ?? null);

  if (kioskKey && kioskMap.has(kioskKey)) {
    toUpdate.push({ id: item.id, dbName: item.name, desc: kioskMap.get(kioskKey)! });
  } else {
    unmatched.push(item.name);
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n=== WILL UPDATE (${toUpdate.length}) ===`);
for (const u of toUpdate) {
  console.log(`  ✓ ${JSON.stringify(u.dbName)}`);
  console.log(`      → ${u.desc.slice(0, 80)}${u.desc.length > 80 ? "…" : ""}`);
}

console.log(`\n=== NO MATCH (${unmatched.length}) — skipped ===`);
for (const n of unmatched) console.log(`  ✗ ${JSON.stringify(n)}`);

// ── Apply updates ──────────────────────────────────────────────────────────
if (!DRY_RUN) {
  const stmt = db.prepare(
    "UPDATE menu_items SET description = ?, updated_at = datetime('now') WHERE id = ?"
  );

  db.transaction(() => {
    for (const u of toUpdate) {
      stmt.run(u.desc, u.id);
    }
  })();

  console.log(`\n✅ Updated ${toUpdate.length} rows in menu_items.`);
} else {
  console.log("\n[DRY RUN] No changes written.");
}

db.close();
