/**
 * POS Adapter types and interfaces
 * Defines the contract for integrating with merchant POS systems
 */

/**
 * Order item for POS submission
 */
export interface POSOrderItem {
  dishId: string
  dishName: string
  quantity: number
  priceCents: number
  modifiers?: Array<{
    name: string
    priceCents: number
  }>
  specialInstructions?: string
}

/**
 * Order data for POS submission
 */
export interface POSOrderData {
  orderId: string
  customerName: string
  customerPhone: string
  customerEmail?: string
  items: POSOrderItem[]
  subtotalCents: number
  taxCents: number
  totalCents: number
  orderType: 'pickup' | 'delivery' | 'dine_in'
  pickupTime?: string
  deliveryAddress?: string
  specialInstructions?: string
}

/**
 * Result from POS order submission
 */
export interface POSOrderResult {
  success: boolean
  posOrderId?: string
  estimatedMinutes?: number
  error?: string
  errorCode?: string
}

/**
 * Order status from POS system
 */
export type POSOrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'picked_up'
  | 'completed'   // legacy — kept for backward compat
  | 'cancelled'
  | 'error'

/**
 * Status query result
 */
export interface POSStatusResult {
  status: POSOrderStatus
  estimatedMinutes?: number
  completedAt?: string
  error?: string
}

/**
 * Individual modifier option (e.g., "Mild", "Extra Cheese")
 */
export interface POSModifier {
  id: string
  posModifierId?: string
  name: string
  priceCents: number
  isAvailable: boolean
  sortOrder: number
}

/**
 * Modifier group (e.g., "Spice Level", "Add-ons")
 */
export interface POSModifierGroup {
  id: string
  posGroupId?: string
  name: string
  minRequired: number       // 0 = optional
  maxAllowed: number | null // null = unlimited
  modifiers: POSModifier[]
}

/**
 * Menu item from POS system
 */
export interface POSMenuItem {
  id: string
  posItemId?: string
  name: string
  description?: string
  priceCents: number
  priceType: 'FIXED' | 'VARIABLE' | 'PER_UNIT'
  categoryId?: string
  isAvailable: boolean
  imageUrl?: string
  sortOrder: number
  modifierGroups: POSModifierGroup[]
}

/**
 * Menu category (e.g., "Appetizers", "Entrees")
 */
export interface POSMenuCategory {
  id: string
  posCategoryId?: string
  name: string
  sortOrder: number
  items: POSMenuItem[]
}

/**
 * Full menu data from POS system — categories → items → modifierGroups → modifiers
 */
export interface POSMenuData {
  categories: POSMenuCategory[]
  /** Items not assigned to any category */
  uncategorizedItems: POSMenuItem[]
  lastUpdated: string
}

/**
 * Connection test result
 */
export interface POSConnectionTest {
  ok: boolean
  latencyMs?: number
  version?: string
  error?: string
}

/**
 * POS Adapter interface
 * All POS integrations must implement this contract
 */
export interface POSAdapter {
  /**
   * Unique identifier for this POS type
   */
  readonly posType: string

  /**
   * Submits an order to the POS system
   */
  submitOrder(order: POSOrderData): Promise<POSOrderResult>

  /**
   * Gets the current status of an order
   */
  getOrderStatus(posOrderId: string): Promise<POSStatusResult>

  /**
   * Fetches the full menu from the POS system
   * Returns categories → items → modifierGroups → modifiers
   */
  fetchMenu(): Promise<POSMenuData>

  /**
   * Tests the connection to the POS system
   */
  testConnection(): Promise<POSConnectionTest>

  /**
   * Registers a webhook for order status updates (optional)
   * Returns true if webhook was successfully registered
   */
  registerWebhook?(callbackUrl: string): Promise<boolean>

  /**
   * Cancels an order in the POS system (optional)
   */
  cancelOrder?(posOrderId: string): Promise<boolean>
}

/**
 * Minimal interface for POS menu import adapters.
 * Implemented by CloverMenuImporter, ToastMenuImporter, SquareMenuImporter.
 */
export interface MenuImportAdapter {
  fetchMenu(): Promise<POSMenuData>
}

/**
 * POS adapter configuration
 */
export interface POSAdapterConfig {
  merchantId: string
  posType: string
  apiKey?: string
  webhookSecret?: string
  sandboxMode?: boolean
  customSettings?: Record<string, unknown>
}
