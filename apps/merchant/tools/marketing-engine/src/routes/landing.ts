/**
 * Landing page for kizo.example
 * Simple mobile-first page with a link to the online store.
 */

import { Hono } from 'hono'
import { config } from '../config'

export const landing = new Hono()

const HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Demo Restaurant — Kirkland</title>
  <meta name="description" content="Authentic Thai cuisine in Kirkland, WA. Order online for pickup or dine-in.">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #1a1008;
      color: #f5ede0;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem 1.5rem;
      text-align: center;
    }

    .lotus {
      font-size: 3rem;
      margin-bottom: 1.25rem;
      filter: drop-shadow(0 0 16px rgba(212,160,60,0.5));
    }

    h1 {
      font-size: clamp(1.6rem, 5vw, 2.4rem);
      font-weight: 700;
      letter-spacing: -0.01em;
      color: #f5ede0;
      line-height: 1.15;
    }

    .tagline {
      margin-top: 0.5rem;
      font-size: 1rem;
      color: #c9a96e;
      font-style: italic;
      letter-spacing: 0.02em;
    }

    .divider {
      width: 48px;
      height: 2px;
      background: #c9a96e;
      margin: 1.75rem auto;
      border-radius: 2px;
      opacity: 0.6;
    }

    .order-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: #c9a96e;
      color: #1a1008;
      font-size: 1.05rem;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-decoration: none;
      padding: 0.9rem 2.25rem;
      border-radius: 100px;
      transition: background 0.15s, transform 0.1s;
      -webkit-tap-highlight-color: transparent;
    }

    .order-btn:hover  { background: #dbb97e; }
    .order-btn:active { transform: scale(0.97); }

    .address {
      margin-top: 2.25rem;
      font-size: 0.875rem;
      color: #a08060;
      line-height: 1.6;
    }

    .address a {
      color: inherit;
      text-decoration: none;
      border-bottom: 1px solid #a08060;
    }

    .phone {
      display: block;
      margin-top: 0.25rem;
      color: #a08060;
      text-decoration: none;
    }
    .phone:hover { color: #c9a96e; }
  </style>
</head>
<body>
  <div class="lotus">🪷</div>
  <h1>Demo Restaurant</h1>
  <p class="tagline">Authentic Thai Cuisine · Kirkland, WA</p>

  <div class="divider"></div>

  <a class="order-btn" href="https://demo-restaurant.kizo.example">
    Order Online →
  </a>

  <div class="address">
    <a href="https://maps.google.com/?q=115+Central+Way+Kirkland+WA+98033" target="_blank" rel="noopener">
      115 Central Way, Kirkland WA 98033
    </a>
    <a class="phone" href="tel:+14258222629">425.822.2629</a>
  </div>
</body>
</html>`

landing.get('/', (c) => {
  // Serves kizo.example and www.kizo.example.
  // On qr.kizo.example the redirect routes match /c/:slug first.
  return c.html(HTML)
})
