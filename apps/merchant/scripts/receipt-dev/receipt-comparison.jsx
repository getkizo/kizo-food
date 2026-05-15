import { useState } from "react";

const LOGO_INV_B64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQAAAACFI5MzAAAEkElEQVR4nO2VT4gbZRjGn5nZNWkJZKsWA4qJ0INCDykotLC7M1t6t+DFU1FBFATpWcvO17WHHoTqrQVtciuebBEsQtudbfAP/stSBEFwM3XbJkpLps1ud7L5Mo+HzJ9vJjl6M+9lvvl+3/O+z/fONzPANKYxjWn8RzGv3ujKWBzVxESiWafVdTPKohf8M0cmVsnt7HTdyXXymJvsrGzvBP5EzRsAnpgk0bi6M6SYoBmNrAmkAACoTiBVhaeJhQpkahdRkK2dARML8RojlmYjx1G4Y5p8eJ0bI3OZFQmphNe4P1psLTsz7l9kiBYAbkcC9bE62xSXtx5TXM6S2W3b6vy1TfO8myH5zmL5zNrfy88/HW8ojKL5+wPJ8tUH0sta0pq9IVebPZEFpgQMOqMBgOQkWgbRQY7JltWdljqHs6kAkCQ3STKlscJmPQYAiNGkDiTvzWZ4nY9JI5y5GVq+kVh2AIMMaJIOYMiYlD2DDrDAzwCDbjE592U/R3rmgC1ZJN2yH9fxngCwvq7DkY8AVBICALR/01BvDkTqyOU8j5J9Lts1miwW3YQ8DMweA/taYLMp7XMKCexamzQvSLLdD8yEGDTbNbLW6JP9tqSjOKjvc4HqgV1g9vAwMQCNP5Nkm22SPKS8rLC/JoNij13PJt8OFE3tqk32+hdqTTJ40BdJneqMQ7F39m7dowjcXSSkBIdv7hOnzSt7LGNuSyEFIKhvAzi5WwE6AKKzU9Dhn9t4FkuXuoR79IqyH9czqs9owPmC8MPnpgMAsZTPm8cAlFfW/ZtQvAErwQe3BPjoU3wJRQNoDZHzASz6rYtKBwA2a3toaNdFK3e+P6CqqRzzXBuAkLlfZSob9gsEAWwHfB3pbOy3NF5ny6ixl8rmn0FbB3AXWPHUbGJ9Ib87A+A53F7Zm3ZQBYCjYQ+VML8i3KLHopcDf5GKJn8W8hNcxFvImyhuKb0+mIeexyF83Cta0DcUzY+AdskFkPsDwLpCdACe70Le9wVwQvUWAFcqL+Kf4VOxq5DQQlW+hINuAUNLdV3+sEl5eHHxVMFkb8NXyZEeh2xwjTU2QxL1ei8CvCJOwIIXqNmK3wRskCQbtP/0UoS26dsMyjLg556Szb9jWVb3LB79oJPpZ2rVK+hc0PYXsDzUVY30Kps8XqY/K76bKbmqpoT3B5cFOKj8FH0MR5egYL4qSy4ws9RbeO2hQphvrG1t3dbQ9nAs3TesABKAW8HSnFC3eqrFngNA63JwQwVY7EZtLPfmU9nWfW20i6LYejlF/EL04a501LYBGEZfSLMGdT/A6WiJ1cq41pxInPIMwF6NSPTgIo3jhgOZJbBGWbR4InKwEXn1v83UKXdHFoydqBmR2POzg4j4OBBm9zIE958EALx7Bxki7xkAoFdvuRkSGMZJAIV6zcl4w7JZEtBK0s5mg3b8Cwv6e9t2VgJzs7fGj5rfyzFSloMmBy0zfnnibB19ua+VVq3OmEbjvEFnXv3yx4Wu2QwWxssAuRrJvhvfJ3/03SqA3foEDd4heU8prCCmb6cxjWlM438X/wLwci/KBrDK2AAAAABJRU5ErkJggg==";

const LOGO_B64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQAAAACFI5MzAAAEzUlEQVR4nO2XTWgcZRjHf+/OdHfTDJlpLbqVYLZSsIrgtF60pt1tKq2ezE0PFrZWpCeJ4EGkJJMq5iCIgmLQQ6NnhR4EQUp8tym0hyKxvQitOqlKF5E6KYudJpN5PMx+zE62Nw8edi7z8Xvf//N/nvfdZ2aVcI8jdy8wIAMyIAPSn1y4J1nsmSSdI64QzXRvze6Y+NfSqYv91W4x3z9O1CTw+5KGh2r0JQtVWOvrjWrJoGuuO2cDEHQftSYAy31IQBkI+5AFwExZUJ2urCiHf0XIpjkbrXN1E4mABuBvyido3dub8mmTjrkOaatEm4huneNNrhVQDKFjuz1H8njlHSZezcuqFVR1cutWVZ3Mxlkfnl04OTqsvmjUMiScn/jxm8oDp6+8eTaTaeCfvK+A/9z2QjvV9q6y7eX1dWpB1F2G1ghti8RURAIjUx29qnIx1JXTTjW1d8Qs1auQVQNgPP0kl67ZYwB4Se1yABdaxTrWGnGhQw4kD9Riq2YTHVVdEREw0CAikSEigoiIb0fMiJznhIhQCQpdUgjB1iauEcCYX+h4cyJgys3hWiOAX+xmGoM69PgGtUe3eJ0kRERCWzAoqFmvhkaCsU6ccERpC+UtKQ/X8KZSxPBqJdCvGVDKK90lEf54ALXxPNjjBpUUmbI1uCULVJBPSC4xaKxWodGwQJxLye8hB6C8vIcKmpRsjbqsvA6R2lWojK7ddHdNwHy+S5ikqqp3Nj6rOeLl2JJa7UZYzZ25NT1Tf+GO3gisFGk+jKoNQ/Vs3ocSAMl+CyMneuPhP5Cnt+0qPvtdaodwwhnShRzVwJgvHqFnv4VrS+c8uLq4x2kteYssTmO5oKwneL7dTRO18tLctrvnJw59FK4smT1qztdTf5vjHLT54HCxR83/yi57AObqPnrUnMJ7ZWECPzruWz1qe+56jgAeUnbSah7TDMfANZw4p9Jx3HpoRsDv2HHY62BZkbwXvGa7v4iIiH8ZGQvHCO1QvCeNlINSiDkV1shzt+4xmlL7GOKnqGNyWxNsT5H9GnbuAYZ2Q7wvRdZASuUyplnyki7c8ZaDo/on7jd+7vbYxNucxo7s2aASYKwY6e4iUzSNKzc+1XWGqmZarXodQ31+4Fu1wO6JnhrwDzHvz36JxulZheCI4hQAB/FeSfpYixzF820PFRQUN+xUdYpjWi84b/FQcU0Z7zrpOLq2wrY5ubaD0ypOOzAt/2VD13cOrev9ZrGcchA9iMy5GsNaEe+lSirTXHPptNFwMa3JycPBI6k5MhJjjYpIyWVmqqePhtNJyFfh+yCdqbzjYs2ISLwXsy6pTOU3t9Bqn751sUdtpCFJfquedamnolaz/W70S25PHJlrt3Zdkx41ounWRf04veuz0V79XDVDONM6z5Ah7ZGYuQwxtJcYirNqY07romhmSOy3TfoZsqOokxFOMUPM3cnYyAyyroM/AZgvZV2b+5ONUdtXzpDcsehD4PbysU5mrfrJrL45I/FNY1YyFUXOvqjhk2EvG4fqD7+g4nOvd1+j7clBwXKxXN/epFZce9uWYO+Cs2mOsCTMLKXuO1f+YY1xvtCHhDUgP9aHiAtY0o9cB57p3qrUf2fV/dgh/f2WPf5nX+sDMiADMiD/GfkXT3JFmdTwaqsAAAAASUVORK5CYII=";

/* ─── Beautiful Check Receipt (HTML-rendered style) ─── */
function ProfessionalCheck({ compact }) {
  const s = compact ? 0.72 : 1;
  return (
    <div style={{
      width: 340 * s,
      background: "#fff",
      padding: `${28*s}px ${22*s}px ${32*s}px`,
      fontFamily: "'DM Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
      color: "#1a1a1a",
      boxShadow: "4px 8px 32px rgba(0,0,0,0.3)",
      position: "relative",
    }}>
      {/* Logo */}
      <div style={{ textAlign: "center", marginBottom: 10*s }}>
        <img src={LOGO_B64} alt="" style={{
          width: 56*s, height: 56*s,
          imageRendering: "crisp-edges",
        }} />
      </div>

      {/* Restaurant name */}
      <div style={{
        textAlign: "center",
        fontSize: 16*s,
        fontWeight: 700,
        letterSpacing: "0.12em",
        marginBottom: 2*s,
      }}>HANUMAN THAI CAFE</div>
      <div style={{ textAlign: "center", fontSize: 10.5*s, color: "#555", lineHeight: 1.5 }}>
        115 Central Way, Kirkland WA 98033
      </div>
      <div style={{ textAlign: "center", fontSize: 10.5*s, color: "#555", marginBottom: 16*s }}>
        425-322-2629
      </div>

      {/* Order info */}
      <div style={{
        borderTop: `1.5px solid #1a1a1a`,
        borderBottom: `1px solid #ddd`,
        padding: `${8*s}px 0`,
        marginBottom: 12*s,
        display: "flex",
        justifyContent: "space-between",
        fontSize: 10.5*s,
      }}>
        <div>
          <div style={{ fontWeight: 600 }}>Order #7D9D41</div>
          <div style={{ color: "#666", marginTop: 1 }}>Table 2</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontWeight: 600 }}>Dine In</div>
          <div style={{ color: "#666", marginTop: 1 }}>11:14 AM</div>
        </div>
      </div>

      {/* Line items */}
      <div style={{ marginBottom: 12*s }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5*s, marginBottom: 3*s }}>
          <span><span style={{ fontWeight: 600 }}>1</span>&nbsp;&nbsp;Combo 1</span>
          <span style={{ fontWeight: 500 }}>$16.00</span>
        </div>
        <div style={{ fontSize: 9.5*s, color: "#777", paddingLeft: 20*s, lineHeight: 1.6 }}>
          <div>Side: Spring rolls</div>
          <div>Chicken</div>
          <div style={{ fontWeight: 500, color: "#c0392b" }}>🌶 Extra hot</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10*s, color: "#555", paddingLeft: 20*s, marginTop: 2*s }}>
          <span>+ Coke</span>
          <span>+$2.00</span>
        </div>
      </div>

      {/* Totals */}
      <div style={{ borderTop: "1px solid #ddd", padding: `${8*s}px 0`, fontSize: 10.5*s }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3*s }}>
          <span style={{ color: "#666" }}>Subtotal</span>
          <span>$16.00</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "#666" }}>Tax (10.4%)</span>
          <span>$1.66</span>
        </div>
      </div>

      <div style={{
        borderTop: `2px solid #1a1a1a`,
        padding: `${8*s}px 0`,
        display: "flex",
        justifyContent: "space-between",
        fontSize: 15*s,
        fontWeight: 700,
        marginBottom: 16*s,
      }}>
        <span>TOTAL</span>
        <span>$17.66</span>
      </div>

      {/* Suggested Gratuity */}
      <div style={{
        background: "#f8f7f4",
        borderRadius: 6*s,
        padding: `${12*s}px ${14*s}px`,
        marginBottom: 16*s,
      }}>
        <div style={{
          fontSize: 11*s,
          fontWeight: 700,
          letterSpacing: "0.06em",
          marginBottom: 8*s,
          textAlign: "center",
        }}>
          SUGGESTED GRATUITY
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: `${4*s}px`, fontSize: 10*s }}>
          {[
            { pct: "18%", tip: "$2.88", total: "$20.54" },
            { pct: "20%", tip: "$3.20", total: "$20.86" },
            { pct: "22%", tip: "$3.52", total: "$21.18" },
            { pct: "25%", tip: "$4.00", total: "$21.66" },
          ].map((r, i) => (
            <div key={i} style={{
              textAlign: "center",
              padding: `${5*s}px 0`,
              borderRadius: 4*s,
              border: i === 1 ? "1.5px solid #1a1a1a" : "1px solid #ddd",
              background: i === 1 ? "#1a1a1a" : "#fff",
              color: i === 1 ? "#fff" : "#1a1a1a",
            }}>
              <div style={{ fontWeight: 700, fontSize: 12*s }}>{r.pct}</div>
              <div style={{ fontSize: 9*s, opacity: 0.7 }}>{r.tip}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tip / Total write-in */}
      <div style={{ fontSize: 10.5*s, marginBottom: 6*s }}>
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 10*s }}>
          <span style={{ width: 50*s, fontWeight: 500 }}>Tip:</span>
          <span style={{ flex: 1, borderBottom: "1px solid #ccc" }}>&nbsp;</span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <span style={{ width: 50*s, fontWeight: 700, fontSize: 12*s }}>Total:</span>
          <span style={{ flex: 1, borderBottom: "1.5px solid #1a1a1a" }}>&nbsp;</span>
        </div>
      </div>

      {/* Footer */}
      <div style={{ textAlign: "center", marginTop: 18*s, fontSize: 9*s, color: "#999", lineHeight: 1.6 }}>
        <div>www.demo-restaurant.example.com</div>
        <div style={{ marginTop: 4*s, fontSize: 10*s, color: "#666" }}>Thank you for dining with us!</div>
      </div>
    </div>
  );
}

/* ─── Receiptline-style (monospace typewriter look) ─── */
function TypewriterCheck({ compact }) {
  const s = compact ? 0.72 : 1;
  const mono = "'Courier New', Courier, monospace";
  return (
    <div style={{
      width: 340 * s,
      background: "#faf9f5",
      padding: `${28*s}px ${18*s}px ${32*s}px`,
      fontFamily: mono,
      color: "#1a1a1a",
      boxShadow: "4px 8px 32px rgba(0,0,0,0.3)",
      fontSize: 11.5*s,
      lineHeight: 1.45,
      position: "relative",
    }}>
      <div style={{ textAlign: "center", marginBottom: 12*s }}>
        <img src={LOGO_B64} alt="" style={{ width: 56*s, height: 56*s, imageRendering: "pixelated" }} />
      </div>
      <div style={{ textAlign: "center", fontWeight: 700, fontSize: 13*s }}>HANUMAN THAI CAFE</div>
      <div style={{ textAlign: "center", fontSize: 10.5*s }}>115 Central Way, Kirkland WA 98033</div>
      <div style={{ textAlign: "center", fontSize: 10.5*s, marginBottom: 14*s }}>425-322-2629</div>

      <div style={{ borderTop: "1.5px solid #000", padding: `${6*s}px 0`, display: "flex", justifyContent: "space-between" }}>
        <span>Order #7D9D41</span><span>Dine In</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1.5px solid #000", paddingBottom: 6*s, marginBottom: 10*s }}>
        <span>Table 2</span><span>11:14 AM</span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>1  Combo 1</span><span>$16.00</span>
      </div>
      <div style={{ paddingLeft: 32*s, fontSize: 10.5*s }}>Side: Spring rolls</div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>Coke</span><span>+$2.00</span>
      </div>
      <div style={{ paddingLeft: 32*s, fontSize: 10.5*s }}>Chicken</div>
      <div style={{ paddingLeft: 32*s, fontSize: 10.5*s, marginBottom: 10*s }}>5. Extra hot</div>

      <div style={{ borderTop: "1.5px solid #000", paddingTop: 6*s }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Subtotal</span><span>$16.00</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6*s }}>
          <span>Tax (10.4%)</span><span>$1.66</span>
        </div>
      </div>

      <div style={{ borderTop: "2px solid #000", padding: `${6*s}px 0`, display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 13*s, marginBottom: 14*s }}>
        <span>TOTAL</span><span>$17.66</span>
      </div>

      <div style={{ textAlign: "center", fontWeight: 700, fontSize: 12.5*s, marginBottom: 8*s }}>Suggested Gratuity</div>
      {[
        { pct: "18%", tip: "$2.88", total: "$20.54" },
        { pct: "20%", tip: "$3.20", total: "$20.86" },
        { pct: "22%", tip: "$3.52", total: "$21.18" },
        { pct: "25%", tip: "$4.00", total: "$21.66" },
      ].map((r, i) => (
        <div key={i} style={{ textAlign: "center", fontSize: 10.5*s }}>
          {r.pct}&nbsp;&nbsp;·&nbsp;&nbsp;{r.tip}&nbsp;&nbsp;→&nbsp;&nbsp;{r.total}
        </div>
      ))}

      <div style={{ borderTop: "1.5px solid #000", marginTop: 12*s, paddingTop: 12*s }}>
        <div style={{ textAlign: "center", marginBottom: 12*s }}>Tip:</div>
        <div style={{ textAlign: "center", marginBottom: 12*s }}>Total:</div>
      </div>

      <div style={{ textAlign: "center", fontSize: 10*s, marginTop: 10*s }}>www.demo-restaurant.example.com</div>
      <div style={{ textAlign: "center", fontSize: 10.5*s, marginTop: 4*s }}>Thank you for dining with us!</div>
    </div>
  );
}

/* ─── Professional Takeout Ticket ─── */
function ProfessionalTakeout({ compact }) {
  const s = compact ? 0.72 : 1;
  return (
    <div style={{
      width: 340 * s,
      background: "#fff",
      fontFamily: "'DM Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
      color: "#1a1a1a",
      boxShadow: "4px 8px 32px rgba(0,0,0,0.3)",
      overflow: "hidden",
    }}>
      {/* Dark branded header */}
      <div style={{
        background: "#1a1a1a",
        padding: `${20*s}px ${22*s}px ${18*s}px`,
        textAlign: "center",
        color: "#fff",
      }}>
        <img src={LOGO_INV_B64} alt="" style={{
          width: 48*s, height: 48*s,
          imageRendering: "crisp-edges",
          filter: "invert(1)",
          marginBottom: 6*s,
        }} />
        <div style={{ fontSize: 14*s, fontWeight: 700, letterSpacing: "0.14em" }}>
          HANUMAN THAI CAFE
        </div>
        <div style={{ fontSize: 9*s, color: "#999", marginTop: 2*s }}>
          115 Central Way, Kirkland WA 98033 · 425-322-2629
        </div>
      </div>

      {/* Takeout banner */}
      <div style={{
        background: "#f0ede6",
        padding: `${10*s}px`,
        textAlign: "center",
        borderBottom: "1px solid #ddd",
      }}>
        <div style={{ fontSize: 18*s, fontWeight: 800, letterSpacing: "0.15em" }}>TAKEOUT</div>
        <div style={{ display: "flex", justifyContent: "center", gap: 16*s, fontSize: 10*s, color: "#666", marginTop: 2*s }}>
          <span>Order #7D9D41</span>
          <span>11:14 AM</span>
        </div>
        <div style={{ fontSize: 16*s, fontWeight: 700, marginTop: 4*s }}>JJ</div>
      </div>

      <div style={{ padding: `${14*s}px ${22*s}px ${24*s}px` }}>
        {/* Items */}
        <div style={{ marginBottom: 12*s }}>
          {[
            { qty: 1, name: "Combo 1", price: "$16.00", mods: ["Side: Spring rolls", "Chicken", "🌶 Extra hot"], add: { name: "Coke", price: "+$2.00" } },
          ].map((item, i) => (
            <div key={i} style={{ marginBottom: 8*s }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12*s, fontWeight: 600 }}>
                <span>{item.qty}× {item.name}</span>
                <span>{item.price}</span>
              </div>
              {item.mods.map((m, j) => (
                <div key={j} style={{ fontSize: 9.5*s, color: m.includes("🌶") ? "#c0392b" : "#888", paddingLeft: 18*s, lineHeight: 1.5 }}>{m}</div>
              ))}
              {item.add && (
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10*s, paddingLeft: 18*s, color: "#555", marginTop: 1*s }}>
                  <span>+ {item.add.name}</span><span>{item.add.price}</span>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Totals */}
        <div style={{ borderTop: "1px solid #eee", padding: `${8*s}px 0`, fontSize: 10.5*s }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#666" }}>
            <span>Subtotal</span><span>$16.00</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#666" }}>
            <span>Tax (10.4%)</span><span>$1.66</span>
          </div>
        </div>
        <div style={{
          borderTop: "2px solid #1a1a1a",
          padding: `${8*s}px 0`,
          display: "flex",
          justifyContent: "space-between",
          fontSize: 15*s,
          fontWeight: 700,
        }}>
          <span>TOTAL</span><span>$17.66</span>
        </div>

        {/* Paid */}
        <div style={{
          textAlign: "center",
          margin: `${12*s}px 0`,
          padding: `${8*s}px`,
          background: "#f0f9f0",
          borderRadius: 4*s,
          fontSize: 11*s,
          fontWeight: 600,
          color: "#2d7a3a",
        }}>
          ✓ PAID $17.66 · Visa ····8821
        </div>

        {/* Footer */}
        <div style={{ textAlign: "center", fontSize: 9*s, color: "#bbb", marginTop: 10*s }}>
          www.demo-restaurant.example.com
        </div>
        <div style={{ textAlign: "center", fontSize: 10*s, color: "#888", marginTop: 2*s }}>
          Thank you!
        </div>
      </div>
    </div>
  );
}

const TICKET_TYPES = [
  { id: "check", label: "Check", icon: "💳" },
  { id: "takeout", label: "Takeout", icon: "🥡" },
];

export default function ReceiptComparison() {
  const [activeType, setActiveType] = useState("check");

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(160deg, #0f0f0f 0%, #1a1510 50%, #0f0f0f 100%)",
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      color: "#e0ddd5",
      padding: "16px",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />

      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        {/* Header */}
        <div style={{
          marginBottom: 20,
          paddingBottom: 14,
          borderBottom: "1px solid rgba(212,175,55,0.2)",
        }}>
          <h1 style={{ fontSize: 17, fontWeight: 700, color: "#d4af37", margin: 0, letterSpacing: "0.06em" }}>
            RECEIPT RENDERING: Receiptline vs HTML Image
          </h1>
          <p style={{ fontSize: 11, color: "#8a8070", margin: "4px 0 0" }}>
            TSP100III in Star Graphic Mode accepts raster images — no reason to be limited to monospace bitmap characters
          </p>
        </div>

        {/* Ticket type selector */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          {TICKET_TYPES.map(t => (
            <button key={t.id} onClick={() => setActiveType(t.id)} style={{
              padding: "8px 18px",
              background: activeType === t.id ? "#d4af37" : "rgba(255,255,255,0.05)",
              color: activeType === t.id ? "#000" : "#888",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "inherit",
            }}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {/* Side by side comparison */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 24,
        }}>
          {/* Before: receiptline */}
          <div>
            <div style={{
              fontSize: 11,
              color: "#ef4444",
              fontWeight: 600,
              letterSpacing: "0.08em",
              marginBottom: 10,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#ef4444", display: "inline-block" }} />
              RECEIPTLINE (CURRENT)
            </div>
            <div style={{
              display: "flex",
              justifyContent: "center",
              padding: "24px 8px",
              background: "radial-gradient(ellipse, #222 0%, #111 70%)",
              borderRadius: 10,
              border: "1px solid #2a2222",
            }}>
              {activeType === "check"
                ? <TypewriterCheck compact />
                : <TypewriterCheck compact />
              }
            </div>
            <div style={{ fontSize: 10, color: "#666", marginTop: 8, textAlign: "center", lineHeight: 1.5 }}>
              Monospace bitmap font · Fixed-width grid layout<br />
              <code style={{ color: "#ef4444" }}>receiptline.transform(md, config)</code>
            </div>
          </div>

          {/* After: HTML rendered */}
          <div>
            <div style={{
              fontSize: 11,
              color: "#4ade80",
              fontWeight: 600,
              letterSpacing: "0.08em",
              marginBottom: 10,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ade80", display: "inline-block" }} />
              HTML → IMAGE (PROPOSED)
            </div>
            <div style={{
              display: "flex",
              justifyContent: "center",
              padding: "24px 8px",
              background: "radial-gradient(ellipse, #1a261a 0%, #111 70%)",
              borderRadius: 10,
              border: "1px solid #1a3a1a",
            }}>
              {activeType === "check"
                ? <ProfessionalCheck compact />
                : <ProfessionalTakeout compact />
              }
            </div>
            <div style={{ fontSize: 10, color: "#666", marginTop: 8, textAlign: "center", lineHeight: 1.5 }}>
              DM Sans proportional font · CSS flexbox layout<br />
              <code style={{ color: "#4ade80" }}>puppeteer.screenshot() → printer raster</code>
            </div>
          </div>
        </div>

        {/* How it works */}
        <div style={{
          marginTop: 24,
          background: "rgba(74,222,128,0.05)",
          border: "1px solid rgba(74,222,128,0.15)",
          borderRadius: 8,
          padding: "14px 18px",
          fontSize: 12,
          color: "#94a893",
          lineHeight: 1.7,
        }}>
          <span style={{ color: "#4ade80", fontWeight: 700 }}>How it works:</span>{" "}
          Render receipt as HTML/CSS with proper fonts → Puppeteer screenshots at 576px width (80mm at 203dpi) → Convert to 1-bit monochrome PNG → Send raster image to TSP100III via Star Graphic Mode protocol.
          Same printer, same paper — completely different output quality. Uber and Grubhub use this exact approach.
        </div>

        {/* Architecture note */}
        <div style={{
          marginTop: 12,
          background: "rgba(212,175,55,0.05)",
          border: "1px solid rgba(212,175,55,0.12)",
          borderRadius: 8,
          padding: "14px 18px",
          fontSize: 11,
          color: "#8a8070",
          lineHeight: 1.7,
        }}>
          <span style={{ color: "#d4af37", fontWeight: 700 }}>For Claude Code:</span>{" "}
          <code style={{ color: "#bba060" }}>npm install puppeteer</code> · Build receipt as HTML string with inline CSS · Launch headless Chromium, set viewport to 576px wide · <code style={{ color: "#bba060" }}>page.screenshot({"{"} type: 'png' {"}"})</code> · Convert to 1-bit mono with Sharp or Canvas · Send raw raster bytes via Star Graphic Mode TCP protocol on port 9100. The HTML template approach means you can use any Google Font, any layout, rounded corners, icons — anything CSS can render.
        </div>
      </div>
    </div>
  );
}
