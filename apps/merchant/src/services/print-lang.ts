/**
 * Shared translation strings for all receipt printer modules.
 *
 * This is the single source of truth for printable UI strings.
 * Import from here; do NOT copy this object into other service files.
 *
 * Imported by: printer.ts, webprnt.ts, star-raster.ts, html-receipt.ts
 */

export const LANG = {
  en: {
    kitchen:        'KITCHEN',
    counter:        'COUNTER',
    dineIn:         'Dine In',
    delivery:       'Delivery',
    takeout:        'Takeout',
    note:           'NOTE',
    receipt:        'RECEIPT',
    bill:           'BILL',
    order:          'Order',
    customer:       'Customer',
    subtotal:       'Subtotal',
    tax:            'Tax',
    tip:            'Tip',
    total:          'TOTAL',
    paid:           'PAID',
    paidByCard:     'paid by card',
    thankYou:       'Thank you! See you again soon.',
    thankYouDining: 'Thank you for dining with us!',
    gratuity:       'Suggested Gratuity',
    tipWriteIn:     'Tip: ____________________________',
    totalWriteIn:   'Total: __________________________',
    sigNote:        'Signature captured on device',
    utensils:       'UTENSILS REQUESTED',
  },
  es: {
    kitchen:        'COCINA',
    counter:        'MOSTRADOR',
    dineIn:         'Mesa',
    delivery:       'Entrega',
    takeout:        'Para llevar',
    note:           'NOTA',
    receipt:        'RECIBO',
    bill:           'CUENTA',
    order:          'Orden',
    customer:       'Cliente',
    subtotal:       'Subtotal',
    tax:            'Impuesto',
    tip:            'Propina',
    total:          'TOTAL',
    paid:           'PAGADO',
    paidByCard:     'pagado con tarjeta',
    thankYou:       '¡Gracias! ¡Hasta pronto!',
    thankYouDining: '¡Gracias por cenar con nosotros!',
    gratuity:       'Propina Sugerida',
    tipWriteIn:     'Propina: ________________________',
    totalWriteIn:   'Total: __________________________',
    sigNote:        'Firma capturada en el dispositivo',
    utensils:       'CUBIERTOS SOLICITADOS',
  },
} as const

export type Lang = keyof typeof LANG
