/**
 * Square Menu Importer (stub)
 * Placeholder for future Square POS menu import integration.
 */

import type { MenuImportAdapter, POSMenuData } from './types'

export class SquareMenuImporter implements MenuImportAdapter {
  async fetchMenu(): Promise<POSMenuData> {
    throw new Error('Square menu import is not yet implemented.')
  }
}
