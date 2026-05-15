/**
 * example-usage.js
 * Quick demo of the HTML receipt renderer
 * 
 * Run: node example-usage.js
 * Requires: npm install puppeteer sharp
 */

const renderer = require('./demo-receipt-renderer');
const fs = require('fs');

const sampleOrder = {
    orderNumber: '7D9D41',
    orderType: 'Dine-in',
    table: '2',
    date: 'Feb 27, 2026',
    time: '11:14 AM',
    server: 'Noi',
    customerName: 'JJ',
    guests: 2,
    location: 'kirkland',
    items: [
        {
            qty: 1,
            name: 'Combo 1',
            protein: 'Chicken',
            price: 16.00,
            total: 16.00,
            modifiers: ['Side: Spring rolls', 'Extra hot']
        },
    ],
    subtotal: 16.00,
    taxRate: 10.4,
    tax: 1.66,
    total: 17.66,
    paymentMethod: 'card',
    cardBrand: 'Visa',
    last4: '8821',
};

async function main() {
    console.log('Initializing renderer (launching headless Chrome)...');
    await renderer.init();

    // ── Generate all 4 ticket types as PNG previews ──
    const tickets = [
        ['kitchen',  renderer.templates.kitchen(sampleOrder)],
        ['takeout',  renderer.templates.takeout({ ...sampleOrder, orderType: 'Takeout' })],
        ['check',    renderer.templates.check(sampleOrder)],
        ['receipt',  renderer.templates.receipt(sampleOrder, { tipAmount: 3.20 })],
    ];

    for (const [name, html] of tickets) {
        // Save the HTML for inspection
        fs.writeFileSync(`preview-${name}.html`, html);

        // Render to PNG
        const { png, width, height } = await renderer.renderToImage(html);
        fs.writeFileSync(`preview-${name}.png`, png);

        console.log(`  ${name}: ${width}x${height}px → preview-${name}.png`);
    }

    // ── To actually print to a Star TSP100III: ──
    // const html = renderer.templates.check(sampleOrder);
    // await renderer.printHTML(html, '192.168.1.100');

    await renderer.close();
    console.log('\nDone! Open the PNG files to see the results.');
    console.log('Open the HTML files in a browser to tweak the design.');
}

main().catch(console.error);
