import { useState } from "react";

const LOGO_B64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQAAAACFI5MzAAAEzUlEQVR4nO2XTWgcZRjHf+/OdHfTDJlpLbqVYLZSsIrgtF60pt1tKq2ezE0PFrZWpCeJ4EGkJJMq5iCIgmLQQ6NnhR4EQUp8tym0hyKxvQitOqlKF5E6KYudJpN5PMx+zE62Nw8edi7z8Xvf//N/nvfdZ2aVcI8jdy8wIAMyIAPSn1y4J1nsmSSdI64QzXRvze6Y+NfSqYv91W4x3z9O1CTw+5KGh2r0JQtVWOvrjWrJoGuuO2cDEHQftSYAy31IQBkI+5AFwExZUJ2urCiHf0XIpjkbrXN1E4mABuBvyido3dub8mmTjrkOaatEm4huneNNrhVQDKFjuz1H8njlHSZezcuqFVR1cutWVZ3Mxlkfnl04OTqsvmjUMiScn/jxm8oDp6+8eTaTaeCfvK+A/9z2QjvV9q6y7eX1dWpB1F2G1ghti8RURAIjUx29qnIx1JXTTjW1d8Qs1auQVQNgPP0kl67ZYwB4Se1yABdaxTrWGnGhQw4kD9Riq2YTHVVdEREw0CAikSEigoiIb0fMiJznhIhQCQpdUgjB1iauEcCYX+h4cyJgys3hWiOAX+xmGoM69PgGtUe3eJ0kRERCWzAoqFmvhkaCsU6ccERpC+UtKQ/X8KZSxPBqJdCvGVDKK90lEf54ALXxPNjjBpUUmbI1uCULVJBPSC4xaKxWodGwQJxLye8hB6C8vIcKmpRsjbqsvA6R2lWojK7ddHdNwHy+S5ikqqp3Nj6rOeLl2JJa7UZYzZ25NT1Tf+GO3gisFGk+jKoNQ/Vs3ocSAMl+CyMneuPhP5Cnt+0qPvtdaodwwhnShRzVwJgvHqFnv4VrS+c8uLq4x2kteYssTmO5oKwneL7dTRO18tLctrvnJw59FK4smT1qztdTf5vjHLT54HCxR83/yi57AObqPnrUnMJ7ZWECPzruWz1qe+56jgAeUnbSah7TDMfANZw4p9Jx3HpoRsDv2HHY62BZkbwXvGa7v4iIiH8ZGQvHCO1QvCeNlINSiDkV1shzt+4xmlL7GOKnqGNyWxNsT5H9GnbuAYZ2Q7wvRdZASuUyplnyki7c8ZaDo/on7jd+7vbYxNucxo7s2aASYKwY6e4iUzSNKzc+1XWGqmZarXodQ31+4Fu1wO6JnhrwDzHvz36JxulZheCI4hQAB/FeSfpYixzF820PFRQUN+xUdYpjWi84b/FQcU0Z7zrpOLq2wrY5ubaD0ypOOzAt/2VD13cOrev9ZrGcchA9iMy5GsNaEe+lSirTXHPptNFwMa3JycPBI6k5MhJjjYpIyWVmqqePhtNJyFfh+yCdqbzjYs2ISLwXsy6pTOU3t9Bqn751sUdtpCFJfquedamnolaz/W70S25PHJlrt3Zdkx41ounWRf04veuz0V79XDVDONM6z5Ah7ZGYuQwxtJcYirNqY07romhmSOy3TfoZsqOokxFOMUPM3cnYyAyyroM/AZgvZV2b+5ONUdtXzpDcsehD4PbysU5mrfrJrL45I/FNY1YyFUXOvqjhk2EvG4fqD7+g4nOvd1+j7clBwXKxXN/epFZce9uWYO+Cs2mOsCTMLKXuO1f+YY1xvtCHhDUgP9aHiAtY0o9cB57p3qrUf2fV/dgh/f2WPf5nX+sDMiADMiD/GfkXT3JFmdTwaqsAAAAASUVORK5CYII=";

const LOGO_INV_B64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQAAAACFI5MzAAAEkElEQVR4nO2VT4gbZRjGn5nZNWkJZKsWA4qJ0INCDykotLC7M1t6t+DFU1FBFATpWcvO17WHHoTqrQVtciuebBEsQtudbfAP/stSBEFwM3XbJkpLps1ud7L5Mo+HzJ9vJjl6M+9lvvl+3/O+z/fONzPANKYxjWn8RzGv3ujKWBzVxESiWafVdTPKohf8M0cmVsnt7HTdyXXymJvsrGzvBP5EzRsAnpgk0bi6M6SYoBmNrAmkAACoTiBVhaeJhQpkahdRkK2dARML8RojlmYjx1G4Y5p8eJ0bI3OZFQmphNe4P1psLTsz7l9kiBYAbkcC9bE62xSXtx5TXM6S2W3b6vy1TfO8myH5zmL5zNrfy88/HW8ojKL5+wPJ8tUH0sta0pq9IVebPZEFpgQMOqMBgOQkWgbRQY7JltWdljqHs6kAkCQ3STKlscJmPQYAiNGkDiTvzWZ4nY9JI5y5GVq+kVh2AIMMaJIOYMiYlD2DDrDAzwCDbjE592U/R3rmgC1ZJN2yH9fxngCwvq7DkY8AVBICALR/01BvDkTqyOU8j5J9Lts1miwW3YQ8DMweA/taYLMp7XMKCexamzQvSLLdD8yEGDTbNbLW6JP9tqSjOKjvc4HqgV1g9vAwMQCNP5Nkm22SPKS8rLC/JoNij13PJt8OFE3tqk32+hdqTTJ40BdJneqMQ7F39m7dowjcXSSkBIdv7hOnzSt7LGNuSyEFIKhvAzi5WwE6AKKzU9Dhn9t4FkuXuoR79IqyH9czqs9owPmC8MPnpgMAsZTPm8cAlFfW/ZtQvAErwQe3BPjoU3wJRQNoDZHzASz6rYtKBwA2a3toaNdFK3e+P6CqqRzzXBuAkLlfZSob9gsEAWwHfB3pbOy3NF5ny6ixl8rmn0FbB3AXWPHUbGJ9Ib87A+A53F7Zm3ZQBYCjYQ+VML8i3KLHopcDf5GKJn8W8hNcxFvImyhuKb0+mIeexyF83Cta0DcUzY+AdskFkPsDwLpCdACe70Le9wVwQvUWAFcqL+Kf4VOxq5DQQlW+hINuAUNLdV3+sEl5eHHxVMFkb8NXyZEeh2xwjTU2QxL1ei8CvCJOwIIXqNmK3wRskCQbtP/0UoS26dsMyjLg556Szb9jWVb3LB79oJPpZ2rVK+hc0PYXsDzUVY30Kps8XqY/K76bKbmqpoT3B5cFOKj8FH0MR5egYL4qSy4ws9RbeO2hQphvrG1t3dbQ9nAs3TesABKAW8HSnFC3eqrFngNA63JwQwVY7EZtLPfmU9nWfW20i6LYejlF/EL04a501LYBGEZfSLMGdT/A6WiJ1cq41pxInPIMwF6NSPTgIo3jhgOZJbBGWbR4InKwEXn1v83UKXdHFoydqBmR2POzg4j4OBBm9zIE958EALx7Bxki7xkAoFdvuRkSGMZJAIV6zcl4w7JZEtBK0s5mg3b8Cwv6e9t2VgJzs7fGj5rfyzFSloMmBy0zfnnibB19ua+VVq3OmEbjvEFnXv3yx4Wu2QwWxssAuRrJvhvfJ3/03SqA3foEDd4heU8prCCmb6cxjWlM438X/wLwci/KBrDK2AAAAABJRU5ErkJggg==";

const TICKETS = {
  kitchen: {
    label: "Kitchen Ticket",
    icon: "🔥",
    desc: "Dine-in counter ticket for kitchen staff and servers. Large text, modifiers in inverted blocks, no prices.",
    color: "#ef4444",
    lines: [
      { text: "DINE-IN", size: 3, bold: true, align: "center" },
      { text: "TABLE 7", size: 4, bold: true, align: "center" },
      { text: "", size: 1 },
      { text: "Order #FFB590                    12:45 PM", size: 1 },
      { text: "Server: Noi                     Guests: 2", size: 1 },
      { text: "Customer: JJ", size: 1.5, align: "center" },
      { text: "════════════════════════════════════════════════", size: 1, style: "dim" },
      { text: "", size: 1 },
      { text: "1 Pad Thai (Chicken)", size: 2, align: "left" },
      { text: "   Extra spicy", size: 1.5, style: "invert" },
      { text: "   No peanuts", size: 1.5, style: "invert" },
      { text: "", size: 0.5 },
      { text: "2 Thai Iced Tea", size: 2, align: "left" },
      { text: "", size: 0.5 },
      { text: "1 Green Curry (Tofu)", size: 2, align: "left" },
      { text: "   Medium", size: 1.5, style: "invert" },
      { text: "", size: 0.5 },
      { text: "1 Mango Sticky Rice", size: 2, align: "left" },
      { text: "", size: 1 },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "Feb 26, 2026 12:45 PM", size: 1, align: "center" },
    ]
  },
  takeout: {
    label: "Takeout Ticket",
    icon: "🥡",
    desc: "Stapled to bag. Branded with logo, engaging layout, easy for customer to verify contents.",
    color: "#f59e0b",
    useLogo: "inverted",
    lines: [
      { text: "LOGO_INVERTED", size: 1, type: "logo" },
      { text: "", size: 0.5 },
      { text: "HANUMAN THAI CAFE", size: 1.8, bold: true, align: "center" },
      { text: "12516 Totem Lake Blvd NE", size: 1, align: "center" },
      { text: "Kirkland, WA 98034", size: 1, align: "center" },
      { text: "(425) 820-3357", size: 1, align: "center" },
      { text: "", size: 0.5 },
      { text: "TAKEOUT", size: 2.5, bold: true, align: "center" },
      { text: "", size: 0.3 },
      { text: "Order #FFB590                    12:45 PM", size: 1 },
      { text: "Feb 26, 2026", size: 1, align: "center" },
      { text: "JJ", size: 1.8, bold: true, align: "center" },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "", size: 0.3 },
      { text: "1x Pad Thai (Chicken)                   $16.95", size: 1.2 },
      { text: '    "Extra spicy"', size: 1, style: "mod" },
      { text: '    "No peanuts"', size: 1, style: "mod" },
      { text: "2x Thai Iced Tea                         $9.00", size: 1.2 },
      { text: "    @ $4.50 each", size: 1, style: "mod" },
      { text: "1x Green Curry (Tofu)                   $15.95", size: 1.2 },
      { text: '    "Medium"', size: 1, style: "mod" },
      { text: "1x Mango Sticky Rice                     $9.95", size: 1.2 },
      { text: "", size: 0.3 },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "Subtotal                                $51.85", size: 1 },
      { text: "Tax (10.4%)                              $5.39", size: 1 },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "TOTAL                          $57.24", size: 1.5, bold: true },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "", size: 0.3 },
      { text: "PAID  $57.24", size: 1.3, bold: true, align: "center" },
      { text: "Visa ending 8821", size: 1, align: "center" },
      { text: "", size: 0.5 },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "Thank you!", size: 1.3, align: "center" },
      { text: "We appreciate your business", size: 1, align: "center" },
      { text: "www.demoth.com", size: 1, align: "center" },
    ]
  },
  check: {
    label: "Check",
    icon: "💳",
    desc: "Presented to customer before payment. Shows items, totals, and suggested tip amounts for 18/20/22/25%.",
    color: "#3b82f6",
    useLogo: "normal",
    lines: [
      { text: "LOGO_NORMAL", size: 1, type: "logo" },
      { text: "", size: 0.3 },
      { text: "HANUMAN THAI CAFE", size: 1.3, bold: true, align: "center" },
      { text: "12516 Totem Lake Blvd NE", size: 1, align: "center" },
      { text: "Kirkland, WA 98034", size: 1, align: "center" },
      { text: "", size: 0.3 },
      { text: "Table 7                        Server: Noi", size: 1 },
      { text: "Feb 26, 2026                      12:45 PM", size: 1 },
      { text: "Guests: 2", size: 1 },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "1 Pad Thai (Chicken)                    $16.95", size: 1 },
      { text: "  Extra spicy", size: 1, style: "mod" },
      { text: "  No peanuts", size: 1, style: "mod" },
      { text: "2 Thai Iced Tea                          $9.00", size: 1 },
      { text: "  @ $4.50 each", size: 1, style: "mod" },
      { text: "1 Green Curry (Tofu)                    $15.95", size: 1 },
      { text: "  Medium", size: 1, style: "mod" },
      { text: "1 Mango Sticky Rice                      $9.95", size: 1 },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "Subtotal                                $51.85", size: 1 },
      { text: "Tax (10.4%)                              $5.39", size: 1 },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "TOTAL                          $57.24", size: 1.5, bold: true },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "", size: 0.5 },
      { text: "Suggested Gratuity", size: 1.2, align: "center" },
      { text: "", size: 0.3 },
      { text: "18%       $9.33        Total: $66.57", size: 1, align: "center" },
      { text: "20%      $10.37        Total: $67.61", size: 1, align: "center" },
      { text: "22%      $11.41        Total: $68.65", size: 1, align: "center" },
      { text: "25%      $12.96        Total: $70.20", size: 1, align: "center" },
      { text: "", size: 0.5 },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "", size: 0.5 },
      { text: "Tip:  ______________________", size: 1 },
      { text: "", size: 0.5 },
      { text: "Total:  ____________________", size: 1.2, bold: true },
      { text: "", size: 1 },
      { text: "Thank you for dining with us!", size: 1, align: "center" },
    ]
  },
  receipt: {
    label: "Customer Receipt",
    icon: "🧾",
    desc: "Post-payment receipt. Shows full details with payment confirmation. Signature captured digitally on tablet.",
    color: "#10b981",
    useLogo: "normal",
    lines: [
      { text: "LOGO_NORMAL", size: 1, type: "logo" },
      { text: "", size: 0.3 },
      { text: "HANUMAN THAI CAFE", size: 1.5, bold: true, align: "center" },
      { text: "12516 Totem Lake Blvd NE", size: 1, align: "center" },
      { text: "Kirkland, WA 98034", size: 1, align: "center" },
      { text: "(425) 820-3357", size: 1, align: "center" },
      { text: "", size: 0.3 },
      { text: "Order #FFB590                      Dine-in", size: 1 },
      { text: "Feb 26, 2026                      12:45 PM", size: 1 },
      { text: "Table: 7                      Server: Noi", size: 1 },
      { text: "Customer: JJ", size: 1 },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "1 Pad Thai (Chicken)                    $16.95", size: 1 },
      { text: "  Extra spicy", size: 1, style: "mod" },
      { text: "  No peanuts", size: 1, style: "mod" },
      { text: "2 Thai Iced Tea                          $9.00", size: 1 },
      { text: "  @ $4.50 each", size: 1, style: "mod" },
      { text: "1 Green Curry (Tofu)                    $15.95", size: 1 },
      { text: "  Medium", size: 1, style: "mod" },
      { text: "1 Mango Sticky Rice                      $9.95", size: 1 },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "Subtotal                                $51.85", size: 1 },
      { text: "Tax (10.4%)                              $5.39", size: 1 },
      { text: "Tip                                     $10.37", size: 1 },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "TOTAL                          $67.61", size: 1.3, bold: true },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "", size: 0.3 },
      { text: "PAID  $67.61", size: 1.3, bold: true, align: "center" },
      { text: "Visa ending 8821", size: 1, align: "center" },
      { text: "", size: 0.3 },
      { text: '"Signature captured on device"', size: 1, align: "center", style: "italic" },
      { text: "", size: 0.5 },
      { text: "────────────────────────────────────────────────", size: 1, style: "dim" },
      { text: "Thank you!", size: 1.2, align: "center" },
      { text: "www.demoth.com", size: 1, align: "center" },
    ]
  }
};

function ReceiptLine({ line }) {
  if (line.type === "logo") {
    const src = line.text.includes("INVERTED") ? LOGO_INV_B64 : LOGO_B64;
    const bg = line.text.includes("INVERTED") ? "#000" : "transparent";
    return (
      <div style={{ textAlign: "center", padding: "8px 0" }}>
        <div style={{
          display: "inline-block",
          background: bg,
          padding: bg === "#000" ? 8 : 0,
          borderRadius: bg === "#000" ? 4 : 0,
        }}>
          <img src={src} alt="Demo" style={{
            width: line.text.includes("INVERTED") ? 100 : 80,
            height: "auto",
            imageRendering: "pixelated",
            filter: line.text.includes("INVERTED") ? "invert(1)" : "none",
          }} />
        </div>
      </div>
    );
  }

  if (!line.text) {
    return <div style={{ height: `${(line.size || 1) * 10}px` }} />;
  }

  const baseFontSize = 12;
  const fontSize = baseFontSize * (line.size || 1);

  let color = "#1a1a1a";
  let background = "transparent";
  let padding = "0";
  let fontStyle = "normal";
  let display = "inline";

  if (line.style === "dim") color = "#999";
  if (line.style === "mod") color = "#555";
  if (line.style === "italic") fontStyle = "italic";
  if (line.style === "invert") {
    background = "#1a1a1a";
    color = "#fff";
    padding = "1px 6px";
    display = "inline-block";
  }

  return (
    <div style={{
      fontSize,
      fontWeight: line.bold ? 700 : 400,
      textAlign: line.align || "left",
      lineHeight: 1.4,
      fontStyle,
      whiteSpace: "pre",
      overflow: "hidden",
    }}>
      <span style={{ background, color, padding, display, borderRadius: line.style === "invert" ? 2 : 0 }}>
        {line.text}
      </span>
    </div>
  );
}

function ReceiptPaper({ ticket, accentColor }) {
  return (
    <div style={{
      background: "#faf9f5",
      width: 360,
      minWidth: 360,
      padding: "24px 20px 32px",
      fontFamily: "'Courier New', Courier, monospace",
      position: "relative",
      boxShadow: "4px 8px 32px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.05)",
    }}>
      {/* Torn top edge */}
      <div style={{
        position: "absolute",
        top: -6,
        left: 0,
        right: 0,
        height: 6,
        background: `repeating-linear-gradient(90deg, transparent 0px, transparent 4px, #faf9f5 4px, #faf9f5 8px)`,
      }} />
      {/* Subtle paper texture */}
      <div style={{
        position: "absolute",
        inset: 0,
        opacity: 0.03,
        background: "repeating-linear-gradient(0deg, #000 0px, transparent 1px, transparent 3px)",
        pointerEvents: "none",
      }} />
      {ticket.lines.map((line, i) => (
        <ReceiptLine key={i} line={line} />
      ))}
      {/* Torn bottom edge */}
      <div style={{
        position: "absolute",
        bottom: -6,
        left: 0,
        right: 0,
        height: 6,
        background: `repeating-linear-gradient(90deg, transparent 0px, transparent 4px, #faf9f5 4px, #faf9f5 8px)`,
      }} />
    </div>
  );
}

const MARKDOWN_SAMPLES = {
  kitchen: `^^^^"DINE-IN"
^^^^^"TABLE 7"

Order #FFB590 | 12:45 PM
Server: Noi | Guests: 2
^Customer: JJ
===
^^^1 Pad Thai (Chicken)
   ^^\`Extra spicy\`
   ^^\`No peanuts\`

^^^2 Thai Iced Tea

^^^1 Green Curry (Tofu)
   ^^\`Medium\`

^^^1 Mango Sticky Rice

---
Feb 26, 2026 12:45 PM
=`,
  takeout: `{i:<base64_logo_inverted>}

^^"HANUMAN THAI CAFE"
12516 Totem Lake Blvd NE
Kirkland, WA 98034
(425) 820-3357

^^^"TAKEOUT"

Order #FFB590 | 12:45 PM
Feb 26, 2026
^^"JJ"
---

^1x Pad Thai (Chicken) | $16.95
    "Extra spicy" |
    "No peanuts" |
^2x Thai Iced Tea | $9.00
    @ $4.50 each |
^1x Green Curry (Tofu) | $15.95
    "Medium" |
^1x Mango Sticky Rice | $9.95

---
Subtotal | $51.85
Tax (10.4%) | $5.39
---
^^"TOTAL" | ^^"$57.24"
---

^"PAID" $57.24
Visa ending 8821

---
^Thank you!
www.demoth.com
=`,
  check: `{i:<base64_logo>}

^"HANUMAN THAI CAFE"
12516 Totem Lake Blvd NE
Kirkland, WA 98034

Table 7 | Server: Noi
Feb 26, 2026 | 12:45 PM
Guests: 2
---
1 Pad Thai (Chicken) | $16.95
  Extra spicy |
  No peanuts |
2 Thai Iced Tea | $9.00
  @ $4.50 each |
1 Green Curry (Tofu) | $15.95
  Medium |
1 Mango Sticky Rice | $9.95
---
Subtotal | $51.85
Tax (10.4%) | $5.39
---
^^"TOTAL" | ^^"$57.24"
---

^Suggested Gratuity

18% | $9.33 | Total: $66.57
20% | $10.37 | Total: $67.61
22% | $11.41 | Total: $68.65
25% | $12.96 | Total: $70.20

---

Tip:  ______________________ |

^"Total:  ____________________" |


Thank you for dining with us!
=`,
  receipt: `{i:<base64_logo>}

^^"HANUMAN THAI CAFE"
12516 Totem Lake Blvd NE
Kirkland, WA 98034
(425) 820-3357

Order #FFB590 | Dine-in
Feb 26, 2026 | 12:45 PM
Table: 7 | Server: Noi
Customer: JJ
---
1 Pad Thai (Chicken) | $16.95
  Extra spicy |
  No peanuts |
2 Thai Iced Tea | $9.00
  @ $4.50 each |
1 Green Curry (Tofu) | $15.95
  Medium |
1 Mango Sticky Rice | $9.95
---
Subtotal | $51.85
Tax (10.4%) | $5.39
Tip | $10.37
---
^"TOTAL" | ^"$67.61"
---

^"PAID"  $67.61
Visa ending 8821

"Signature captured on device"

---
^Thank you!
www.demoth.com
=`,
};

export default function DemoReceipts() {
  const [activeType, setActiveType] = useState("kitchen");
  const [showMarkdown, setShowMarkdown] = useState(false);
  const ticket = TICKETS[activeType];

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(145deg, #0c0c0c 0%, #1a1510 50%, #0c0c0c 100%)",
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
      color: "#e0ddd5",
      padding: "16px",
    }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        {/* Header */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginBottom: 20,
          paddingBottom: 16,
          borderBottom: "1px solid rgba(212,175,55,0.2)",
        }}>
          <img src={LOGO_INV_B64} alt="" style={{
            width: 36,
            height: 36,
            imageRendering: "pixelated",
            filter: "invert(1) sepia(1) saturate(3) hue-rotate(15deg) brightness(1.1)",
          }} />
          <div>
            <h1 style={{
              fontSize: 18,
              fontWeight: 700,
              color: "#d4af37",
              margin: 0,
              letterSpacing: "0.08em",
            }}>
              HANUMAN THAI CAFE
            </h1>
            <p style={{ fontSize: 11, color: "#8a8070", margin: 0 }}>
              POS Receipt System — 4 Ticket Types via receiptline
            </p>
          </div>
        </div>

        {/* Ticket type selector */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 8,
          marginBottom: 20,
        }}>
          {Object.entries(TICKETS).map(([key, t]) => (
            <button
              key={key}
              onClick={() => setActiveType(key)}
              style={{
                padding: "12px 8px",
                background: activeType === key
                  ? `linear-gradient(135deg, ${t.color}22, ${t.color}11)`
                  : "rgba(255,255,255,0.03)",
                border: activeType === key
                  ? `2px solid ${t.color}`
                  : "2px solid rgba(255,255,255,0.06)",
                borderRadius: 8,
                cursor: "pointer",
                textAlign: "center",
                transition: "all 0.2s",
              }}
            >
              <div style={{ fontSize: 22, marginBottom: 4 }}>{t.icon}</div>
              <div style={{
                fontSize: 11,
                fontWeight: 600,
                color: activeType === key ? t.color : "#888",
                letterSpacing: "0.03em",
              }}>
                {t.label}
              </div>
            </button>
          ))}
        </div>

        {/* Description */}
        <div style={{
          background: `linear-gradient(135deg, ${ticket.color}12, transparent)`,
          border: `1px solid ${ticket.color}33`,
          borderRadius: 8,
          padding: "12px 16px",
          marginBottom: 20,
          fontSize: 13,
          color: "#bbb",
          lineHeight: 1.5,
        }}>
          <span style={{ color: ticket.color, fontWeight: 700 }}>{ticket.icon} {ticket.label}:</span>{" "}
          {ticket.desc}
        </div>

        {/* Toggle */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button
            onClick={() => setShowMarkdown(false)}
            style={{
              padding: "6px 16px",
              background: !showMarkdown ? "#d4af37" : "rgba(255,255,255,0.06)",
              color: !showMarkdown ? "#000" : "#888",
              border: "none",
              borderRadius: 5,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "inherit",
            }}
          >
            Receipt Preview
          </button>
          <button
            onClick={() => setShowMarkdown(true)}
            style={{
              padding: "6px 16px",
              background: showMarkdown ? "#d4af37" : "rgba(255,255,255,0.06)",
              color: showMarkdown ? "#000" : "#888",
              border: "none",
              borderRadius: 5,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "inherit",
            }}
          >
            ReceiptLine Markdown
          </button>
        </div>

        {/* Content */}
        {!showMarkdown ? (
          <div style={{
            display: "flex",
            justifyContent: "center",
            padding: "32px 16px",
            background: "radial-gradient(ellipse at center, #2a2520 0%, #151210 70%)",
            borderRadius: 12,
            border: "1px solid rgba(212,175,55,0.1)",
            overflow: "auto",
          }}>
            <ReceiptPaper ticket={ticket} accentColor={ticket.color} />
          </div>
        ) : (
          <div style={{
            background: "#0d1117",
            border: "1px solid #2a2a2a",
            borderRadius: 10,
            padding: 20,
            overflow: "auto",
            maxHeight: 600,
          }}>
            <pre style={{
              margin: 0,
              fontFamily: "'Courier New', Courier, monospace",
              fontSize: 12.5,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
            }}>
              {MARKDOWN_SAMPLES[activeType].split("\n").map((line, i) => {
                let color = "#c9d1d9";
                if (line.startsWith("^^^") || line.startsWith("^^") || line.startsWith("^")) color = "#ff7b72";
                else if (line === "---" || line === "=" || line === "===") color = "#d4af37";
                else if (line.includes("|")) color = "#79c0ff";
                else if (line.startsWith("{")) color = "#d2a8ff";
                else if (line.includes("`")) color = "#ffa657";
                return (
                  <div key={i} style={{ display: "flex" }}>
                    <span style={{
                      color: "#3d424a",
                      width: 32,
                      flexShrink: 0,
                      textAlign: "right",
                      marginRight: 16,
                      userSelect: "none",
                      fontSize: 11,
                    }}>
                      {i + 1}
                    </span>
                    <span style={{ color }}>{line || "\u00a0"}</span>
                  </div>
                );
              })}
            </pre>
          </div>
        )}

        {/* Syntax legend */}
        {showMarkdown && (
          <div style={{
            marginTop: 10,
            fontSize: 11,
            color: "#666",
            display: "flex",
            flexWrap: "wrap",
            gap: "4px 16px",
          }}>
            <span><span style={{ color: "#ff7b72" }}>■</span> Size / emphasis (^, ^^, ^^^)</span>
            <span><span style={{ color: "#d4af37" }}>■</span> Separators / cuts (---, =)</span>
            <span><span style={{ color: "#79c0ff" }}>■</span> Column layout (|)</span>
            <span><span style={{ color: "#ffa657" }}>■</span> Inverted text (`)</span>
            <span><span style={{ color: "#d2a8ff" }}>■</span> Properties ({"{"}...{"}"})</span>
          </div>
        )}

        {/* Quick reference */}
        <div style={{
          marginTop: 20,
          padding: "14px 16px",
          background: "rgba(212,175,55,0.05)",
          border: "1px solid rgba(212,175,55,0.15)",
          borderRadius: 8,
          fontSize: 12,
          color: "#8a8070",
          lineHeight: 1.7,
        }}>
          <span style={{ color: "#d4af37", fontWeight: 600 }}>TSP100III Config:</span>{" "}
          <code style={{ color: "#bba060" }}>command: 'stargraphic'</code> (LAN) or{" "}
          <code style={{ color: "#bba060" }}>command: 'starlinesbcs'</code> (USB/BT){" "}
          · <code style={{ color: "#bba060" }}>cpl: 48</code> for 80mm paper
          · Logo via <code style={{ color: "#bba060" }}>{"{"}i:&lt;base64png&gt;{"}"}</code>
          · Designer: <span style={{ color: "#79c0ff" }}>receiptline.github.io/designer</span>
        </div>
      </div>
    </div>
  );
}
