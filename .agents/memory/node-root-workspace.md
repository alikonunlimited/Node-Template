---
name: Node app at workspace root
description: Running the uploaded standalone Node app alongside the pnpm workspace
---

The standalone Node app lives at the workspace root while other packages remain in the pnpm workspace. The package installer may reject adding root dependencies because of the workspace-root guard; a normal workspace install is the reliable way to install dependencies already declared in the root package.

**Why:** The app was imported into a workspace that already contains multiple packages, so package-manager safety checks treat the root as a workspace boundary.

**How to apply:** When starting this app, use the root package's declared dependencies and run the workspace install if modules are missing; do not add unrelated packages to the app.