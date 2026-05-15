/**
 * demo-receipts.js
 * ═══════════════════════════════════════════════════════
 * Demo Restaurant — POS Receipt System
 * 4 Ticket Types for Star TSP100III via receiptline
 * ═══════════════════════════════════════════════════════
 * 
 * SETUP:
 *   npm install receiptline
 *   Copy logo files (logo-sm-b64.txt, logo-lg-b64.txt, logo-inv-b64.txt)
 *   to the same directory as this module.
 *
 * USAGE:
 *   const receipts = require('./demo-receipts');
 *   const md = receipts.kitchenTicket(orderData);
 *   await receipts.print(md, '192.168.1.100');
 * 
 * TICKET TYPES:
 *   1. kitchenTicket()    — Dine-in counter, large text, no prices
 *   2. takeoutTicket()    — Bag staple, branded, with logo
 *   3. checkTicket()      — Pre-payment, shows suggested tips
 *   4. customerReceipt()  — Post-payment, with payment details
 */

const receiptline = require('receiptline');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURATION — Edit these for your setup
// ============================================================

const CONFIG = {
    restaurant: {
        name: 'HANUMAN THAI CAFE',
        website: 'www.demoth.com',
    },

    locations: {
        kirkland: {
            address: '12516 Totem Lake Blvd NE',
            cityState: 'Kirkland, WA 98034',
            phone: '(425) 820-3357',
        },
        seattle: {
            address: '252 S Main St',
            cityState: 'Seattle, WA 98104',
            phone: '(206) 357-7433',
        }
    },

    // Star TSP100III printer settings
    printer: {
        cpl: 48,                    // characters per line (48 for 80mm paper)
        encoding: 'cp1252',         // Western European
        upsideDown: false,
        spacing: true,              // line spacing for readability
        cutting: true,              // auto paper cut
        gamma: 1.8,
        command: 'stargraphic',     // TSP100LAN (network)
        // command: 'starlinesbcs', // ← Use this for USB/Bluetooth
    },

    // Suggested tip percentages
    tipPercentages: [18, 20, 22, 25],

    // TCP connection settings
    printerPort: 9100,
    printerTimeout: 5000,
};

// ============================================================
// LOGO — Load base64 encoded monochrome PNGs
// ============================================================
// These are generated from the Demo mask artwork,
// converted to 1-bit monochrome for thermal printing.
// 
// To regenerate, use the convert-logo.py script.

let LOGO = '';
let LOGO_INV = '';

try {
    const logoDir = __dirname;
    LOGO = fs.readFileSync(path.join(logoDir, 'logo-sm-b64.txt'), 'utf8').trim();
    LOGO_INV = fs.readFileSync(path.join(logoDir, 'logo-inv-b64.txt'), 'utf8').trim();
} catch (e) {
    console.warn('Warning: Logo files not found. Receipts will print without logo.');
    console.warn('Place logo-sm-b64.txt and logo-inv-b64.txt in:', __dirname);
}

// ============================================================
// HELPERS
// ============================================================

function getLocation(locationKey) {
    return CONFIG.locations[locationKey || 'kirkland'] || CONFIG.locations.kirkland;
}

function logoLine(inverted = false) {
    const b64 = inverted ? LOGO_INV : LOGO;
    return b64 ? `{i:${b64}}` : '';
}

function headerBlock(loc, options = {}) {
    const { showPhone = true, nameSize = '^^' } = options;
    const lines = [];
    if (logoLine(options.invertedLogo)) {
        lines.push(logoLine(options.invertedLogo));
        lines.push('');
    }
    lines.push(`${nameSize}"${CONFIG.restaurant.name}"`);
    lines.push(loc.address);
    lines.push(loc.cityState);
    if (showPhone) lines.push(loc.phone);
    return lines;
}

function itemsBlock(items, options = {}) {
    const { showPrices = true, largeText = false } = options;
    const lines = [];
    
    for (const item of items) {
        const proteinStr = item.protein ? ` (${item.protein})` : '';
        const prefix = largeText ? '^^^' : '';
        const modPrefix = largeText ? '   ^^' : '  ';
        
        if (showPrices) {
            const sizePrefix = largeText ? '^' : '';
            lines.push(`${sizePrefix}${item.qty}${largeText ? '' : ''} ${item.name}${proteinStr} | $${item.total.toFixed(2)}`);
            
            if (item.qty > 1) {
                lines.push(`  @ $${item.price.toFixed(2)} each |`);
            }
        } else {
            lines.push(`${prefix}${item.qty} ${item.name}${proteinStr}`);
        }
        
        if (item.modifiers && item.modifiers.length > 0) {
            for (const mod of item.modifiers) {
                if (largeText) {
                    // Inverted for kitchen visibility
                    lines.push(`${modPrefix}\`${mod}\``);
                } else if (showPrices) {
                    lines.push(`  ${mod} |`);
                } else {
                    lines.push(`${modPrefix}${mod}`);
                }
            }
        }
        
        if (largeText) lines.push('');
    }
    
    return lines;
}

function totalsBlock(order, options = {}) {
    const { showTip = false, tipAmount = 0, totalSize = '^^' } = options;
    const finalTotal = order.total + (showTip ? tipAmount : 0);
    const lines = [];
    
    lines.push(`Subtotal | $${order.subtotal.toFixed(2)}`);
    lines.push(`Tax (${order.taxRate}%) | $${order.tax.toFixed(2)}`);
    
    if (showTip && tipAmount > 0) {
        lines.push(`Tip | $${tipAmount.toFixed(2)}`);
    }
    
    lines.push('---');
    lines.push(`${totalSize}"TOTAL" | ${totalSize}"$${finalTotal.toFixed(2)}"`);
    lines.push('---');
    
    return lines;
}

// ============================================================
// TYPE 1: KITCHEN / DINE-IN COUNTER TICKET
// ============================================================
// Purpose: Kitchen staff and servers
// Features: Very large text, inverted modifiers, NO prices
// ============================================================

function kitchenTicket(order) {
    const lines = [];

    // Big order type + table
    lines.push(`^^^^"${order.orderType.toUpperCase()}"`);
    if (order.table) {
        lines.push(`^^^^^"TABLE ${order.table}"`);
    }
    lines.push('');
    
    // Order meta
    lines.push(`Order #${order.orderNumber} | ${order.time}`);
    if (order.server) {
        lines.push(`Server: ${order.server} | Guests: ${order.guests || ''}`);
    }
    if (order.customerName) {
        lines.push(`^Customer: ${order.customerName}`);
    }
    lines.push('===');

    // Items — large, no prices
    lines.push(...itemsBlock(order.items, { showPrices: false, largeText: true }));

    lines.push('---');
    lines.push(`${order.date} ${order.time}`);
    lines.push('=');

    return lines.join('\n');
}

// ============================================================
// TYPE 2: TAKEOUT / ONLINE ORDER TICKET
// ============================================================
// Purpose: Stapled to bag, customer-facing
// Features: Branded with inverted logo, engaging, checklist-style
// ============================================================

function takeoutTicket(order) {
    const loc = getLocation(order.location);
    const lines = [];

    // Branded header with dramatic inverted logo
    lines.push(...headerBlock(loc, { invertedLogo: true, nameSize: '^^' }));
    lines.push('');

    // Big order type
    lines.push(`^^^"TAKEOUT"`);
    lines.push('');
    
    // Order info
    lines.push(`Order #${order.orderNumber} | ${order.time}`);
    lines.push(`${order.date}`);
    if (order.customerName) {
        lines.push(`^^"${order.customerName}"`);
    }
    lines.push('---');
    lines.push('');

    // Items with double-width qty prefix for easy scanning
    for (const item of order.items) {
        const proteinStr = item.protein ? ` (${item.protein})` : '';
        lines.push(`^${item.qty}x ${item.name}${proteinStr} | $${item.total.toFixed(2)}`);
        
        if (item.qty > 1) {
            lines.push(`    @ $${item.price.toFixed(2)} each |`);
        }
        if (item.modifiers && item.modifiers.length > 0) {
            for (const mod of item.modifiers) {
                lines.push(`    "${mod}" |`);
            }
        }
    }

    lines.push('');
    lines.push('---');
    lines.push(...totalsBlock(order, { totalSize: '^^' }));

    // Payment
    lines.push('');
    lines.push(`^"PAID"  $${order.total.toFixed(2)}`);
    if (order.last4) {
        lines.push(`${order.cardBrand || 'Card'} ending ${order.last4}`);
    }

    // Footer
    lines.push('');
    lines.push('---');
    lines.push('^Thank you!');
    lines.push('We appreciate your business');
    lines.push(CONFIG.restaurant.website);
    lines.push('=');

    return lines.join('\n');
}

// ============================================================
// TYPE 3: CHECK (PRE-PAYMENT)
// ============================================================
// Purpose: Presented to dine-in customer before payment
// Features: Itemized bill + suggested tip table + write-in lines
// ============================================================

function checkTicket(order) {
    const loc = getLocation(order.location);
    const lines = [];

    // Header with standard logo
    lines.push(...headerBlock(loc, { showPhone: false, nameSize: '^' }));
    lines.push('');

    // Table/server info
    lines.push(`Table ${order.table || '-'} | Server: ${order.server || ''}`);
    lines.push(`${order.date} | ${order.time}`);
    lines.push(`Guests: ${order.guests || 1}`);
    lines.push('---');

    // Items with prices
    lines.push(...itemsBlock(order.items, { showPrices: true }));

    lines.push('---');
    lines.push(...totalsBlock(order, { totalSize: '^^' }));

    // Suggested tips
    lines.push('');
    lines.push('^Suggested Gratuity');
    lines.push('');
    
    for (const pct of CONFIG.tipPercentages) {
        const tipAmt = (order.subtotal * pct / 100);
        const totalWithTip = order.total + tipAmt;
        lines.push(`${pct}% | $${tipAmt.toFixed(2)} | Total: $${totalWithTip.toFixed(2)}`);
    }

    // Write-in lines
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('Tip:  ______________________ |');
    lines.push('');
    lines.push('^"Total:  ____________________" |');
    lines.push('');
    lines.push('');
    lines.push('Thank you for dining with us!');
    lines.push('');
    lines.push('=');

    return lines.join('\n');
}

// ============================================================
// TYPE 4: CUSTOMER RECEIPT (POST-PAYMENT)
// ============================================================
// Purpose: Final receipt after payment
// Features: Full details, payment info, optional signature line
// Digital signature note when using tap/chip
// ============================================================

function customerReceipt(order, options = {}) {
    const { tipAmount = 0, includeSigLine = false } = options;
    const finalTotal = order.total + tipAmount;
    const loc = getLocation(order.location);
    const lines = [];

    // Header
    lines.push(...headerBlock(loc, { nameSize: '^^' }));
    lines.push('');

    // Order info
    lines.push(`Order #${order.orderNumber} | ${order.orderType}`);
    lines.push(`${order.date} | ${order.time}`);
    if (order.table) {
        lines.push(`Table: ${order.table} | Server: ${order.server || ''}`);
    }
    if (order.customerName) {
        lines.push(`Customer: ${order.customerName}`);
    }
    lines.push('---');

    // Items
    lines.push(...itemsBlock(order.items, { showPrices: true }));

    lines.push('---');
    lines.push(...totalsBlock(order, { showTip: true, tipAmount, totalSize: '^' }));

    // Payment
    lines.push('');
    lines.push(`^"PAID"  $${finalTotal.toFixed(2)}`);
    if (order.last4) {
        lines.push(`${order.cardBrand || 'Card'} ending ${order.last4}`);
    }

    // Signature
    if (includeSigLine) {
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push('');
        lines.push('x ________________________________');
        lines.push('Signature');
        lines.push('');
        lines.push('I agree to pay the above total');
        lines.push('amount per the card issuer agreement');
    } else {
        lines.push('');
        lines.push('"Signature captured on device"');
    }

    // Footer
    lines.push('');
    lines.push('---');
    lines.push('^Thank you!');
    lines.push(CONFIG.restaurant.website);
    lines.push('=');

    return lines.join('\n');
}

// ============================================================
// PRINTING & PREVIEW
// ============================================================

/**
 * Send receipt markdown to printer via TCP.
 */
function print(markdown, printerIP, port) {
    return new Promise((resolve, reject) => {
        const commands = receiptline.transform(markdown, CONFIG.printer);
        const client = new net.Socket();
        
        client.setTimeout(CONFIG.printerTimeout);
        
        client.connect(port || CONFIG.printerPort, printerIP, () => {
            client.write(Buffer.from(commands, 'binary'), () => {
                client.end();
            });
        });

        client.on('close', () => resolve());
        client.on('error', (err) => reject(new Error(`Printer error: ${err.message}`)));
        client.on('timeout', () => {
            client.destroy();
            reject(new Error('Printer connection timed out'));
        });
    });
}

/**
 * Generate SVG preview for on-screen display.
 */
function preview(markdown) {
    return receiptline.transform(markdown, {
        cpl: CONFIG.printer.cpl,
        encoding: CONFIG.printer.encoding,
        spacing: CONFIG.printer.spacing,
    });
}

/**
 * Generate plain text version.
 */
function toText(markdown) {
    return receiptline.transform(markdown, {
        cpl: CONFIG.printer.cpl,
        encoding: CONFIG.printer.encoding,
        spacing: CONFIG.printer.spacing,
        command: 'text'
    });
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    // Ticket builders
    kitchenTicket,
    takeoutTicket,
    checkTicket,
    customerReceipt,
    
    // Output methods
    print,
    preview,
    toText,
    
    // Configuration (mutable)
    CONFIG,
};
