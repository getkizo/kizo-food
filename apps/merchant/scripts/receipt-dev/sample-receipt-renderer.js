/**
 * demo-receipt-renderer.js
 * ═══════════════════════════════════════════════════════════
 * Professional receipt rendering via HTML → Image → Printer
 * 
 * Instead of receiptline's monospace bitmap approach, this renders
 * receipts as beautiful HTML with proper fonts, then screenshots
 * via Puppeteer and sends the raster image to the Star TSP100III.
 *
 * SETUP:
 *   npm install puppeteer sharp
 *
 * USAGE:
 *   const renderer = require('./demo-receipt-renderer');
 *   await renderer.init();  // launch browser once
 *   
 *   const html = renderer.templates.check(orderData);
 *   await renderer.printHTML(html, '192.168.1.100');
 *   
 *   // or get PNG buffer for display
 *   const pngBuffer = await renderer.renderToImage(html);
 *
 *   await renderer.close();  // shutdown browser
 * ═══════════════════════════════════════════════════════════
 */

const puppeteer = require('puppeteer');
const sharp = require('sharp');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
    // Printer: Star TSP100III
    // 80mm paper ≈ 72mm printable area
    // At 203 DPI: 72mm = ~576 pixels
    paperWidthPx: 576,

    // TCP printer settings
    printerPort: 9100,
    timeout: 5000,

    // Image processing
    threshold: 128,     // 0-255 for monochrome conversion
    
    // Restaurant info
    restaurant: {
        name: 'HANUMAN THAI CAFE',
        website: 'www.demo-restaurant.example.com',
    },
    locations: {
        kirkland: {
            address: '115 Central Way',
            cityState: 'Kirkland WA 98033',
            phone: '425-322-2629',
        },
        seattle: {
            address: '252 S Main St',
            cityState: 'Seattle, WA 98104',
            phone: '(206) 357-7433',
        }
    },
    tipPercentages: [18, 20, 22, 25],
};

// ============================================================
// LOGO (base64 monochrome PNG — embedded for portability)
// ============================================================
// Load from file if available, otherwise skip
let LOGO_B64 = '';
try {
    LOGO_B64 = fs.readFileSync(
        path.join(__dirname, 'logo-final-sm-b64.txt'), 'utf8'
    ).trim();
} catch (e) {
    // Will render without logo
}

// ============================================================
// BROWSER INSTANCE (reusable for performance)
// ============================================================
let browser = null;

async function init() {
    if (!browser) {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
    }
    return browser;
}

async function close() {
    if (browser) {
        await browser.close();
        browser = null;
    }
}

// ============================================================
// CORE: HTML → Monochrome PNG → Star Raster Commands
// ============================================================

/**
 * Render HTML string to a monochrome PNG buffer.
 * Returns { png: Buffer, width: number, height: number }
 */
async function renderToImage(html) {
    const b = await init();
    const page = await b.newPage();

    await page.setViewport({
        width: CONFIG.paperWidthPx,
        height: 100,  // auto-expands
        deviceScaleFactor: 1,
    });

    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Get actual content height
    const height = await page.evaluate(() => {
        return document.querySelector('#receipt').offsetHeight;
    });

    await page.setViewport({
        width: CONFIG.paperWidthPx,
        height: height,
        deviceScaleFactor: 1,
    });

    // Screenshot as PNG
    const pngBuffer = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: CONFIG.paperWidthPx, height },
        omitBackground: false,
    });

    await page.close();
    return { png: pngBuffer, width: CONFIG.paperWidthPx, height };
}

/**
 * Convert PNG to 1-bit monochrome raster data.
 * Returns raw pixel buffer where each bit = 1 pixel.
 */
async function toMonochrome(pngBuffer) {
    const { data, info } = await sharp(pngBuffer)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;

    // Pack into 1-bit-per-pixel (MSB first, padded to byte boundary)
    const bytesPerRow = Math.ceil(width / 8);
    const mono = Buffer.alloc(bytesPerRow * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const gray = data[y * width + x];
            // Black pixel (print) when gray < threshold
            if (gray < CONFIG.threshold) {
                const byteIndex = y * bytesPerRow + Math.floor(x / 8);
                const bitIndex = 7 - (x % 8);
                mono[byteIndex] |= (1 << bitIndex);
            }
        }
    }

    return { data: mono, width, height, bytesPerRow };
}

/**
 * Build Star Graphic Mode raster commands from monochrome data.
 * Star TSP100 graphic mode protocol:
 *   ESC * r A      — Enter raster mode
 *   b <n1> <n2>    — Transfer raster line (n1 + n2*256 bytes)
 *   ESC * r B      — End raster mode and feed/cut
 */
function toStarGraphicCommands(monoData) {
    const { data, width, height, bytesPerRow } = monoData;
    const commands = [];

    // Enter raster mode
    commands.push(Buffer.from([0x1b, 0x2a, 0x72, 0x41])); // ESC * r A

    // Send each raster line
    for (let y = 0; y < height; y++) {
        const lineData = data.slice(y * bytesPerRow, (y + 1) * bytesPerRow);
        const n1 = bytesPerRow & 0xff;
        const n2 = (bytesPerRow >> 8) & 0xff;
        commands.push(Buffer.from([0x62, n1, n2])); // b <n1> <n2>
        commands.push(lineData);
    }

    // Exit raster mode + paper cut
    commands.push(Buffer.from([0x1b, 0x2a, 0x72, 0x42])); // ESC * r B

    return Buffer.concat(commands);
}

/**
 * Full pipeline: HTML → render → monochrome → printer commands → send.
 */
async function printHTML(html, printerIP, port) {
    const { png, width, height } = await renderToImage(html);
    const mono = await toMonochrome(png);
    const commands = toStarGraphicCommands(mono);

    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        client.setTimeout(CONFIG.timeout);

        client.connect(port || CONFIG.printerPort, printerIP, () => {
            client.write(commands, () => {
                client.end();
            });
        });

        client.on('close', () => resolve({ width, height, bytes: commands.length }));
        client.on('error', (err) => reject(new Error(`Printer: ${err.message}`)));
        client.on('timeout', () => {
            client.destroy();
            reject(new Error('Printer timeout'));
        });
    });
}

// ============================================================
// SHARED CSS
// ============================================================

const BASE_CSS = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    #receipt {
        width: ${CONFIG.paperWidthPx}px;
        background: #fff;
        color: #1a1a1a;
        font-family: 'DM Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif;
        padding: 28px 24px 32px;
        -webkit-font-smoothing: antialiased;
    }

    .logo { text-align: center; margin-bottom: 12px; }
    .logo img { width: 72px; height: 72px; }

    .restaurant-name {
        text-align: center;
        font-size: 20px;
        font-weight: 700;
        letter-spacing: 0.12em;
        margin-bottom: 2px;
    }
    .restaurant-detail {
        text-align: center;
        font-size: 13px;
        color: #555;
        line-height: 1.5;
    }

    .divider { border-top: 2px solid #1a1a1a; margin: 12px 0; }
    .divider-light { border-top: 1px solid #ddd; margin: 10px 0; }

    .row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        font-size: 14px;
        line-height: 1.7;
    }
    .row-sm { font-size: 12.5px; }
    .row-lg { font-size: 19px; font-weight: 700; }

    .muted { color: #777; }
    .bold { font-weight: 700; }
    .center { text-align: center; }
    
    .item-mods {
        padding-left: 24px;
        font-size: 12px;
        color: #888;
        line-height: 1.6;
    }
    .mod-hot { color: #c0392b; font-weight: 500; }

    .gratuity-box {
        background: #f8f7f4;
        border-radius: 8px;
        padding: 14px 16px;
        margin: 16px 0;
    }
    .gratuity-title {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-align: center;
        margin-bottom: 10px;
    }
    .gratuity-grid {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr 1fr;
        gap: 6px;
    }
    .gratuity-option {
        text-align: center;
        padding: 8px 4px;
        border-radius: 6px;
        border: 1px solid #ddd;
        background: #fff;
    }
    .gratuity-option.highlight {
        border: 2px solid #1a1a1a;
        background: #1a1a1a;
        color: #fff;
    }
    .gratuity-pct { font-weight: 700; font-size: 15px; }
    .gratuity-amt { font-size: 11px; opacity: 0.65; margin-top: 1px; }

    .write-line {
        display: flex;
        align-items: baseline;
        margin: 14px 0;
        font-size: 14px;
    }
    .write-line-label { width: 60px; font-weight: 500; }
    .write-line-label.big { font-weight: 700; font-size: 16px; }
    .write-line-rule { flex: 1; border-bottom: 1px solid #ccc; margin-left: 8px; }
    .write-line-rule.bold { border-bottom: 2px solid #1a1a1a; }

    .footer {
        text-align: center;
        margin-top: 20px;
        font-size: 11px;
        color: #aaa;
        line-height: 1.6;
    }
    .footer-thanks {
        font-size: 13px;
        color: #666;
        margin-top: 4px;
    }

    /* Takeout-specific */
    .dark-header {
        background: #1a1a1a;
        color: #fff;
        padding: 24px 24px 20px;
        text-align: center;
        margin: -28px -24px 0 -24px;
    }
    .dark-header img { filter: invert(1); }
    .dark-header .restaurant-name { color: #fff; }
    .dark-header .restaurant-detail { color: #999; }

    .banner {
        background: #f0ede6;
        padding: 12px;
        text-align: center;
        margin: 0 -24px;
        border-bottom: 1px solid #ddd;
    }
    .banner-title { font-size: 24px; font-weight: 800; letter-spacing: 0.15em; }
    .banner-name { font-size: 20px; font-weight: 700; margin-top: 4px; }

    .paid-badge {
        text-align: center;
        margin: 14px 0;
        padding: 10px;
        background: #f0f9f0;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 600;
        color: #2d7a3a;
    }

    /* Kitchen-specific */
    .kitchen-header {
        text-align: center;
        padding: 8px 0;
    }
    .kitchen-type { font-size: 36px; font-weight: 800; letter-spacing: 0.1em; }
    .kitchen-table { font-size: 48px; font-weight: 800; }
    .kitchen-item { font-size: 24px; font-weight: 600; margin: 8px 0 2px; }
    .kitchen-mod {
        display: inline-block;
        background: #1a1a1a;
        color: #fff;
        font-size: 18px;
        font-weight: 600;
        padding: 3px 12px;
        border-radius: 4px;
        margin: 2px 0 2px 28px;
    }
`;

// ============================================================
// HTML RECEIPT TEMPLATES
// ============================================================

function loc(key) {
    const l = CONFIG.locations[key || 'kirkland'];
    return l || CONFIG.locations.kirkland;
}

function logoImg(inverted = false) {
    if (!LOGO_B64) return '';
    const filter = inverted ? ' style="filter:invert(1)"' : '';
    return `<img src="data:image/png;base64,${LOGO_B64}"${filter} />`;
}

const templates = {

    // ────────────────────────────────────────────
    // TYPE 1: KITCHEN TICKET
    // ────────────────────────────────────────────
    kitchen(order) {
        const items = order.items.map(item => {
            const protein = item.protein ? ` (${item.protein})` : '';
            const mods = (item.modifiers || []).map(m =>
                `<div class="kitchen-mod">${m}</div>`
            ).join('');
            return `
                <div class="kitchen-item">${item.qty}× ${item.name}${protein}</div>
                ${mods}
            `;
        }).join('');

        return `<!DOCTYPE html><html><head>
            <style>${BASE_CSS}</style>
        </head><body>
        <div id="receipt">
            <div class="kitchen-header">
                <div class="kitchen-type">${(order.orderType || 'DINE-IN').toUpperCase()}</div>
                ${order.table ? `<div class="kitchen-table">TABLE ${order.table}</div>` : ''}
            </div>
            <div class="row row-sm" style="margin-bottom:4px">
                <span>Order #${order.orderNumber}</span>
                <span>${order.time}</span>
            </div>
            <div class="row row-sm">
                <span>Server: ${order.server || ''}</span>
                <span>Guests: ${order.guests || ''}</span>
            </div>
            ${order.customerName ? `<div class="center bold" style="font-size:18px;margin:6px 0">${order.customerName}</div>` : ''}
            <div class="divider"></div>
            ${items}
            <div class="divider" style="margin-top:16px"></div>
            <div class="center muted" style="font-size:12px">${order.date} ${order.time}</div>
        </div>
        </body></html>`;
    },

    // ────────────────────────────────────────────
    // TYPE 2: TAKEOUT TICKET
    // ────────────────────────────────────────────
    takeout(order) {
        const l = loc(order.location);
        const items = order.items.map(item => {
            const protein = item.protein ? ` (${item.protein})` : '';
            const mods = (item.modifiers || []).map(m =>
                `<div class="item-mods ${m.toLowerCase().includes('hot') || m.toLowerCase().includes('spicy') ? 'mod-hot' : ''}">${m.includes('hot') || m.includes('spicy') ? '🌶 ' : ''}${m}</div>`
            ).join('');
            const qtyNote = item.qty > 1
                ? `<div class="item-mods">@ $${item.price.toFixed(2)} each</div>` : '';
            return `
                <div class="row" style="font-weight:600">
                    <span>${item.qty}× ${item.name}${protein}</span>
                    <span>$${item.total.toFixed(2)}</span>
                </div>
                ${mods}${qtyNote}
            `;
        }).join('');

        return `<!DOCTYPE html><html><head>
            <style>${BASE_CSS}</style>
        </head><body>
        <div id="receipt" style="padding-top:0">
            <div class="dark-header">
                <div class="logo">${logoImg(true)}</div>
                <div class="restaurant-name">${CONFIG.restaurant.name}</div>
                <div class="restaurant-detail">${l.address}, ${l.cityState} · ${l.phone}</div>
            </div>
            <div class="banner">
                <div class="banner-title">TAKEOUT</div>
                <div class="row-sm center muted">Order #${order.orderNumber} · ${order.time} · ${order.date}</div>
                ${order.customerName ? `<div class="banner-name">${order.customerName}</div>` : ''}
            </div>
            <div style="padding:16px 24px 28px">
                ${items}
                <div class="divider-light"></div>
                <div class="row row-sm muted"><span>Subtotal</span><span>$${order.subtotal.toFixed(2)}</span></div>
                <div class="row row-sm muted"><span>Tax (${order.taxRate}%)</span><span>$${order.tax.toFixed(2)}</span></div>
                <div class="divider"></div>
                <div class="row row-lg"><span>TOTAL</span><span>$${order.total.toFixed(2)}</span></div>
                <div class="paid-badge">✓ PAID $${order.total.toFixed(2)} · ${order.cardBrand || 'Card'} ····${order.last4}</div>
                <div class="footer">
                    ${CONFIG.restaurant.website}
                    <div class="footer-thanks">Thank you!</div>
                </div>
            </div>
        </div>
        </body></html>`;
    },

    // ────────────────────────────────────────────
    // TYPE 3: CHECK (pre-payment)
    // ────────────────────────────────────────────
    check(order) {
        const l = loc(order.location);
        const items = order.items.map(item => {
            const protein = item.protein ? ` (${item.protein})` : '';
            const mods = (item.modifiers || []).map(m =>
                `<div class="item-mods ${m.toLowerCase().includes('hot') || m.toLowerCase().includes('spicy') ? 'mod-hot' : ''}">${m}</div>`
            ).join('');
            const qtyNote = item.qty > 1
                ? `<div class="item-mods">@ $${item.price.toFixed(2)} each</div>` : '';
            return `
                <div class="row">
                    <span><span class="bold">${item.qty}</span>&nbsp;&nbsp;${item.name}${protein}</span>
                    <span>$${item.total.toFixed(2)}</span>
                </div>
                ${mods}${qtyNote}
            `;
        }).join('');

        const tips = CONFIG.tipPercentages.map((pct, i) => {
            const amt = (order.subtotal * pct / 100);
            return `
                <div class="gratuity-option ${i === 1 ? 'highlight' : ''}">
                    <div class="gratuity-pct">${pct}%</div>
                    <div class="gratuity-amt">$${amt.toFixed(2)}</div>
                </div>
            `;
        }).join('');

        return `<!DOCTYPE html><html><head>
            <style>${BASE_CSS}</style>
        </head><body>
        <div id="receipt">
            <div class="logo">${logoImg()}</div>
            <div class="restaurant-name">${CONFIG.restaurant.name}</div>
            <div class="restaurant-detail">${l.address}, ${l.cityState}</div>
            <div class="restaurant-detail">${l.phone}</div>
            <div style="height:16px"></div>
            <div class="row row-sm">
                <span>Table ${order.table || '-'} · Server: ${order.server || ''}</span>
                <span>${order.time}</span>
            </div>
            <div class="row row-sm muted"><span>${order.date}</span><span>Guests: ${order.guests || 1}</span></div>
            <div class="divider"></div>
            ${items}
            <div class="divider-light"></div>
            <div class="row row-sm"><span class="muted">Subtotal</span><span>$${order.subtotal.toFixed(2)}</span></div>
            <div class="row row-sm"><span class="muted">Tax (${order.taxRate}%)</span><span>$${order.tax.toFixed(2)}</span></div>
            <div class="divider"></div>
            <div class="row row-lg"><span>TOTAL</span><span>$${order.total.toFixed(2)}</span></div>
            <div class="divider"></div>
            <div class="gratuity-box">
                <div class="gratuity-title">SUGGESTED GRATUITY</div>
                <div class="gratuity-grid">${tips}</div>
            </div>
            <div class="write-line">
                <span class="write-line-label">Tip:</span>
                <span class="write-line-rule"></span>
            </div>
            <div class="write-line">
                <span class="write-line-label big">Total:</span>
                <span class="write-line-rule bold"></span>
            </div>
            <div class="footer">
                ${CONFIG.restaurant.website}
                <div class="footer-thanks">Thank you for dining with us!</div>
            </div>
        </div>
        </body></html>`;
    },

    // ────────────────────────────────────────────
    // TYPE 4: CUSTOMER RECEIPT (post-payment)
    // ────────────────────────────────────────────
    receipt(order, options = {}) {
        const { tipAmount = 0, includeSigLine = false } = options;
        const finalTotal = order.total + tipAmount;
        const l = loc(order.location);

        const items = order.items.map(item => {
            const protein = item.protein ? ` (${item.protein})` : '';
            const mods = (item.modifiers || []).map(m =>
                `<div class="item-mods">${m}</div>`
            ).join('');
            const qtyNote = item.qty > 1
                ? `<div class="item-mods">@ $${item.price.toFixed(2)} each</div>` : '';
            return `
                <div class="row">
                    <span>${item.qty} ${item.name}${protein}</span>
                    <span>$${item.total.toFixed(2)}</span>
                </div>
                ${mods}${qtyNote}
            `;
        }).join('');

        const sigBlock = includeSigLine ? `
            <div class="divider-light" style="margin-top:20px"></div>
            <div style="height:40px"></div>
            <div style="border-top:1px solid #999;font-size:10px;color:#999;padding-top:3px">
                x Signature
            </div>
            <div style="font-size:10px;color:#aaa;margin-top:8px;text-align:center">
                I agree to pay the above total per card issuer agreement
            </div>
        ` : `
            <div class="center muted" style="font-size:12px;font-style:italic;margin-top:8px">
                Signature captured on device
            </div>
        `;

        return `<!DOCTYPE html><html><head>
            <style>${BASE_CSS}</style>
        </head><body>
        <div id="receipt">
            <div class="logo">${logoImg()}</div>
            <div class="restaurant-name">${CONFIG.restaurant.name}</div>
            <div class="restaurant-detail">${l.address}, ${l.cityState}</div>
            <div class="restaurant-detail">${l.phone}</div>
            <div style="height:14px"></div>
            <div class="row row-sm">
                <span>Order #${order.orderNumber}</span>
                <span>${order.orderType}</span>
            </div>
            <div class="row row-sm">
                <span>${order.date}</span>
                <span>${order.time}</span>
            </div>
            ${order.table ? `<div class="row row-sm"><span>Table: ${order.table}</span><span>Server: ${order.server || ''}</span></div>` : ''}
            ${order.customerName ? `<div class="row row-sm"><span>Customer: ${order.customerName}</span></div>` : ''}
            <div class="divider"></div>
            ${items}
            <div class="divider-light"></div>
            <div class="row row-sm"><span class="muted">Subtotal</span><span>$${order.subtotal.toFixed(2)}</span></div>
            <div class="row row-sm"><span class="muted">Tax (${order.taxRate}%)</span><span>$${order.tax.toFixed(2)}</span></div>
            ${tipAmount > 0 ? `<div class="row row-sm"><span class="muted">Tip</span><span>$${tipAmount.toFixed(2)}</span></div>` : ''}
            <div class="divider"></div>
            <div class="row row-lg"><span>TOTAL</span><span>$${finalTotal.toFixed(2)}</span></div>
            <div class="divider"></div>
            <div class="paid-badge">✓ PAID $${finalTotal.toFixed(2)} · ${order.cardBrand || 'Card'} ····${order.last4}</div>
            ${sigBlock}
            <div class="footer">
                ${CONFIG.restaurant.website}
                <div class="footer-thanks">Thank you!</div>
            </div>
        </div>
        </body></html>`;
    },
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    init,
    close,
    renderToImage,
    toMonochrome,
    toStarGraphicCommands,
    printHTML,
    templates,
    CONFIG,
};
