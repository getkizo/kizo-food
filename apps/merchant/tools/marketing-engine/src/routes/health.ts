import { Hono } from 'hono'

const health = new Hono()

health.get('/', (c) => {
  c.header('Content-Type', 'text/html; charset=utf-8')
  return c.body(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Demo Restaurant — Kirkland</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Georgia, serif;
      background: #1a1208;
      color: #f5e9d0;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 2rem;
    }
    .lotus { font-size: 3.5rem; margin-bottom: 1.5rem; }
    h1 { font-size: 1.8rem; font-weight: normal; letter-spacing: .05em; margin-bottom: .4rem; }
    .sub { font-size: 1rem; color: #c9a96e; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 2.5rem; }
    p { font-size: 1.05rem; line-height: 1.7; color: #d4c4a0; max-width: 36ch; }
    .divider { width: 3rem; height: 1px; background: #c9a96e; margin: 2rem auto; }
    .order-link {
      display: inline-block;
      margin-top: 1.5rem;
      padding: .75rem 2rem;
      border: 1px solid #c9a96e;
      color: #c9a96e;
      text-decoration: none;
      letter-spacing: .08em;
      font-size: .9rem;
      text-transform: uppercase;
      transition: background .2s, color .2s;
    }
    .order-link:hover { background: #c9a96e; color: #1a1208; }
  </style>
</head>
<body>
  <div class="lotus">🪷</div>
  <h1>Demo Restaurant</h1>
  <div class="sub">Kirkland, Washington</div>
  <p>Authentic Thai cuisine made with care.<br>Our new website is coming soon.</p>
  <div class="divider"></div>
  <a class="order-link" href="https://demo-restaurant.kizo.example">Order Online</a>
</body>
</html>`)
})

health.get('/health', (c) => c.json({ ok: true, ts: Date.now() }))

health.get('/robots.txt', (c) => {
  c.header('Content-Type', 'text/plain')
  return c.text('User-agent: *\nDisallow: /')
})

export { health }
