import app from "./app";

// Vercel Node-runtime web handler: named `fetch` export (Request → Response).
// A default export returning a Response is ignored by Vercel, hence the name.
// Bundled by `npm run build` → dist/vercel/index.js (see package.json).
export const fetch = (req: Request) => app.fetch(req);

export default fetch;
