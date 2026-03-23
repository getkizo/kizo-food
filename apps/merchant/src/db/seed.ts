/**
 * Database seeding script for development
 * Creates sample merchants, menus, and dishes
 */

import { getDatabase } from './connection'
import { randomBytes } from 'node:crypto'

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`
}

async function seed() {
  console.log('🌱 Seeding database...')

  const db = getDatabase()

  // Clear existing data
  db.exec('DELETE FROM orders')
  db.exec('DELETE FROM dishes')
  db.exec('DELETE FROM menus')
  db.exec('DELETE FROM api_keys')
  db.exec('DELETE FROM encryption_keys')
  db.exec('DELETE FROM merchants')

  // Create sample merchants
  const merchants = [
    {
      id: generateId('m'),
      business_name: "Joe's Pizza",
      slug: 'joes-pizza',
      description: 'Authentic New York style pizza since 1985',
      cuisine_types: JSON.stringify(['italian', 'pizza']),
      phone_number: '+1-555-0101',
      email: 'joe@joespizza.com',
      status: 'active',
    },
    {
      id: generateId('m'),
      business_name: 'Sushi Heaven',
      slug: 'sushi-heaven',
      description: 'Fresh sushi and sashimi made daily',
      cuisine_types: JSON.stringify(['japanese', 'sushi']),
      phone_number: '+1-555-0102',
      email: 'info@sushiheaven.com',
      status: 'active',
    },
    {
      id: generateId('m'),
      business_name: 'Burger Shack',
      slug: 'burger-shack',
      description: 'Gourmet burgers and craft beers',
      cuisine_types: JSON.stringify(['american', 'burgers']),
      phone_number: '+1-555-0103',
      email: 'hello@burgershack.com',
      status: 'active',
    },
  ]

  const insertMerchant = db.prepare(`
    INSERT INTO merchants (id, business_name, slug, description, cuisine_types, phone_number, email, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const merchant of merchants) {
    insertMerchant.run(
      merchant.id,
      merchant.business_name,
      merchant.slug,
      merchant.description,
      merchant.cuisine_types,
      merchant.phone_number,
      merchant.email,
      merchant.status
    )
  }

  console.log(`   ✅ Created ${merchants.length} merchants`)

  // Create menus for each merchant
  const menus: Array<{ id: string; merchant_id: string; name: string }> = []

  for (const merchant of merchants) {
    const menuId = generateId('menu')
    db.run(
      `INSERT INTO menus (id, merchant_id, name, description, is_active)
       VALUES (?, ?, ?, ?, ?)`,
      [menuId, merchant.id, 'Main Menu', `${merchant.business_name} menu`, 1]
    )
    menus.push({ id: menuId, merchant_id: merchant.id, name: 'Main Menu' })
  }

  console.log(`   ✅ Created ${menus.length} menus`)

  // Create sample dishes
  const dishTemplates = {
    'joes-pizza': [
      {
        name: 'Margherita Pizza',
        description: 'Fresh mozzarella, basil, tomato sauce',
        base_price_cents: 1499,
        category: 'pizza',
      },
      {
        name: 'Pepperoni Pizza',
        description: 'Classic pepperoni with mozzarella',
        base_price_cents: 1699,
        category: 'pizza',
      },
      {
        name: 'Caesar Salad',
        description: 'Romaine lettuce, parmesan, croutons',
        base_price_cents: 899,
        category: 'salads',
      },
      {
        name: 'Garlic Bread',
        description: 'Fresh baked with garlic butter',
        base_price_cents: 599,
        category: 'appetizers',
      },
    ],
    'sushi-heaven': [
      {
        name: 'California Roll',
        description: 'Crab, avocado, cucumber',
        base_price_cents: 1299,
        category: 'rolls',
      },
      {
        name: 'Spicy Tuna Roll',
        description: 'Fresh tuna with spicy mayo',
        base_price_cents: 1499,
        category: 'rolls',
      },
      {
        name: 'Salmon Sashimi',
        description: '6 pieces of fresh salmon',
        base_price_cents: 1899,
        category: 'sashimi',
      },
      {
        name: 'Miso Soup',
        description: 'Traditional Japanese soup',
        base_price_cents: 399,
        category: 'appetizers',
      },
    ],
    'burger-shack': [
      {
        name: 'Classic Burger',
        description: 'Beef patty, lettuce, tomato, onion',
        base_price_cents: 1199,
        category: 'burgers',
      },
      {
        name: 'Bacon Cheeseburger',
        description: 'With crispy bacon and cheddar',
        base_price_cents: 1399,
        category: 'burgers',
      },
      {
        name: 'Sweet Potato Fries',
        description: 'Crispy and seasoned',
        base_price_cents: 599,
        category: 'sides',
      },
      {
        name: 'Craft Beer',
        description: 'Rotating selection of local brews',
        base_price_cents: 699,
        category: 'drinks',
      },
    ],
  }

  let dishCount = 0

  for (const merchant of merchants) {
    const menu = menus.find((m) => m.merchant_id === merchant.id)!
    const dishes = dishTemplates[merchant.slug as keyof typeof dishTemplates] || []

    for (const dish of dishes) {
      db.run(
        `INSERT INTO dishes (id, menu_id, merchant_id, name, description, base_price_cents, category, is_available)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          generateId('dish'),
          menu.id,
          merchant.id,
          dish.name,
          dish.description,
          dish.base_price_cents,
          dish.category,
          1,
        ]
      )
      dishCount++
    }
  }

  console.log(`   ✅ Created ${dishCount} dishes`)

  // Display summary
  console.log('\n📊 Seed Summary:')
  console.log(`   Merchants: ${merchants.length}`)
  merchants.forEach((m) => console.log(`     - ${m.business_name} (/${m.slug})`))
  console.log(`   Menus: ${menus.length}`)
  console.log(`   Dishes: ${dishCount}`)
  console.log('\n✅ Seeding complete')
}

// Run if executed directly
if (import.meta.main) {
  try {
    await seed()
    process.exit(0)
  } catch (error) {
    console.error('❌ Seeding failed:', error)
    process.exit(1)
  }
}

export { seed }
