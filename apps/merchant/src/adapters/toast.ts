/**
 * Toast Menu Importer (stub)
 * Placeholder for future Toast POS menu import integration.
 */

import type { MenuImportAdapter, POSMenuData } from './types'

export class ToastMenuImporter implements MenuImportAdapter {
  async fetchMenu(): Promise<POSMenuData> {
    throw new Error('Toast menu import is not yet implemented.')
  }
}
