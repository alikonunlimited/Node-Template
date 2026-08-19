---
name: Trader web companion
description: Product boundary for the React XAU/USD dashboard
---

The React web artifact is a self-contained dashboard companion with local simulated state and interaction feedback; it is not the trading engine or Google Sheets integration.

**Why:** The legacy Node site was intentionally removed while the new web artifact was created as a separate, previewable frontend.

**How to apply:** Keep frontend-only improvements inside the web artifact. Add a backend contract only when the user explicitly asks to reconnect live trader state or persistence.