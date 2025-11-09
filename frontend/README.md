# Spotify Frontend (Vue)

Minimal Vue + Vite frontend that talks to the SAM backend. It allows connecting Spotify (opens backend login), shows followed artists, and has Play/Stop controls.

Local dev:

1. Install dependencies
```bash
cd frontend
npm install
```
2. Run dev server
```bash
npm run dev
```

Set `VITE_API_BASE` in `.env` or edit the input field in the UI.

Deploy to Vercel:
- Create a new project from this repo in the Vercel dashboard.
- Set `VITE_API_BASE` in project Environment Variables to your API base URL.
