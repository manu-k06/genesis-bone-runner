# 🏃‍♂️ Bone Runner | Genesis

A high-intensity, dark fantasy 2D endless runner web game engineered with Vanilla JavaScript, HTML5 Canvas 2D, Vite, and a Supabase backend. Dodge relentless supernatural foes through the Dead Forest, climb the global leaderboards, and experience smooth 60 FPS gameplay across desktop and mobile devices.

---

## 🌟 Highlights & Features

- **Custom Canvas 2D Engine**:
  - High-performance, zero-framework Canvas rendering pipeline.
  - Multi-state character animation system (Running, Jumping, Falling, Dying).
  - Responsive sprite scaling and off-screen canvas caching for backgrounds.
  - Particle burst effects on collision and death.
  - Jump buffering mechanism for responsive, tight controls.

- **Dynamic Adversaries**:
  - Procedurally spawned villains with animated sequences and customized hitboxes:
    - 🐂 **Minotaur**
    - 💀 **Reaper Man**
    - 🔮 **Necromancer of the Shadow**
    - ⚔️ **Skeleton Warrior**
    - 🧟 **Zombie Villager**

- **Competitive Backend & Global Leaderboards**:
  - **Supabase Authentication**: User registration and login integrated with PostgreSQL triggers.
  - **Live Global Leaderboards**: Server-side RPC query (`get_live_leaderboard`) fetching real-time rankings with pagination and privacy isolation.
  - **Player Rank Card**: Dynamic personal rank and high-score lookup (`get_live_player_rank`).

- **Multi-Tiered Anti-Cheat & Security Hardening**:
  - **Server-Side Session Validation**: Games require an active session (`start_live_game_session`), periodic telemetry heartbeats every 5 seconds (`send_heartbeat`), and server-validated end conditions (`end_live_game_session`).
  - **Runtime Anti-Debugging**: Active DevTools size detection, execution pause / breakpoint trap (`dt > 0.5s` session termination), and physics anomaly detection (`velocity_y` checks).
  - **UI Lockdown**: Right-click context menus, `F12`, `Ctrl+Shift+I/J/C`, and `Ctrl+U` inspection shortcuts disabled.
  - **Production Code Obfuscation**: Vite build obfuscation via `vite-plugin-javascript-obfuscator` with control-flow flattening, dead code injection, string array encryption, and debugger protection.
  - **Telegram Moderation Bot**: Real-time high-score alerts sent to Telegram and admin commands (`/delete <player_id>`) for instant score and player record invalidation.
  - **Cloudflare Turnstile Support**: Optional bot verification for player registration.

- **LiveOps Remote Configuration**:
  - Live physics and difficulty adjustments via the `live_game_config` table (gravity, jump velocity, run speed, spawn interval range) without needing frontend redeployment.

- **Mobile First & PWA Ready**:
  - Full-screen responsive touch controls (tap anywhere to jump).
  - Orientation awareness with landscape guidance and automatic pause/resume.
  - Safe-area inset handling (`env(safe-area-inset-*)`) for notched devices.
  - Web App Manifest (`manifest.json`) and iOS "Add to Home Screen" guidance.

- **Audio & Persisted Settings**:
  - Ambient background music and jump sound effects.
  - Volume management, sound toggles, and user preferences persisted in `localStorage`.

---

## 🕹️ Controls & How to Play

| Action | Desktop Controls | Mobile / Touch Controls |
| :--- | :--- | :--- |
| **Jump** | `Spacebar`, `Arrow Up`, or Left Click | Tap anywhere on the screen |
| **Pause / Resume** | `Escape` or Pause Button | In-game Pause Button |
| **Navigate UI** | Mouse Click | Tap Buttons |

### Rules:
1. Leap over oncoming monsters and obstacles.
2. The game speed increases continuously the longer you survive.
3. Colliding with any monster ends the run and submits your score to the global leaderboard.

---

## 🛠️ Tech Stack

- **Frontend**: Vanilla JavaScript (ES Modules), HTML5 Canvas API, Vanilla CSS3
- **Fonts**: [MedievalSharp](https://fonts.google.com/specimen/MedievalSharp), [Inter](https://fonts.google.com/specimen/Inter)
- **Bundler & Dev Server**: [Vite](https://vitejs.dev/)
- **Security & Obfuscation**: [javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator), [vite-plugin-javascript-obfuscator](https://github.com/mjean-dev/vite-plugin-javascript-obfuscator)
- **Backend-as-a-Service**: [Supabase](https://supabase.com/) (PostgreSQL, Row Level Security, Auth, RPC functions)
- **Serverless Edge Functions**: Deno / Supabase Edge Functions
- **Integrations**: Telegram Bot API, Cloudflare Turnstile

---

## 📁 Repository Structure

```plaintext
genesis-bone-runner/
├── index.html              # HTML shell, UI overlays, fonts, canvas mounts
├── package.json            # Scripts & dependencies
├── vite.config.js          # Vite config with build-time JS obfuscator
├── .env.example            # Sample environment variables
├── public/                 # Static game assets
│   ├── Characters/         # Sprite animations for hero and villains
│   ├── PNG/                # Background dead forest imagery
│   ├── sounds/             # Jump audio and background music
│   ├── manifest.json       # PWA manifest
│   ├── icon-192.png        # PWA app icons
│   └── icon-512.png
├── src/
│   ├── main.js             # Core game engine, state machine, rendering & physics
│   ├── style.css           # UI overlays, responsive typography & modals
│   ├── supabase.js         # Supabase client initialization & anonymous auth
│   └── services/
│       ├── configService.js        # Remote config fetcher (LiveOps)
│       ├── leaderboardService.js   # Leaderboard & rank RPC calls
│       └── playerService.js        # Player registration, login, and profile lookup
└── supabase/
    ├── config.toml         # Supabase local development configuration
    ├── migrations/         # PostgreSQL schema & security migrations
    │   ├── 001_security_hardening.sql
    │   ├── 002_security_phase2.sql
    │   ├── 003_privacy_and_auth.sql
    │   ├── 004_max_duration_cap.sql
    │   ├── 005_telemetry.sql
    │   ├── 006_live_players.sql
    │   ├── 007_remote_config.sql
    │   └── 008_auth_trigger.sql
    └── functions/          # Deno Edge Functions
        ├── notify-telegram/        # Telegram alert on new high scores
        ├── register-player/        # Registration with Turnstile validation
        └── telegram-webhook/       # Telegram bot webhook for remote moderation
```

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (version 18.0.0 or higher recommended)
- `npm` or `pnpm` / `yarn`
- A [Supabase](https://supabase.com/) project (cloud or local instance)

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/manu-k06/genesis-bone-runner.git
cd genesis-bone-runner
npm install
```

### 2. Environment Configuration

Create a `.env` file in the project root based on `.env.example`:

```bash
cp .env.example .env
```

Open `.env` and fill in your Supabase credentials:

```env
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

### 3. Run Development Server

```bash
npm run dev
```

Open your browser and navigate to the local URL (typically `http://localhost:5173`).

### 4. Build for Production

```bash
npm run build
```

This compiles the static assets to `dist/` and runs the production JavaScript obfuscator.

To preview the production bundle locally:

```bash
npm run preview
```

---

## 🗄️ Database & Backend Setup

To set up the Supabase database schema and RPCs, execute the migrations located in `supabase/migrations/` in ascending order:

1. **`001` - `005`**: Base game tables, session tracking, security hardening, telemetry.
2. **`006_live_players.sql`**: Production live tables (`live_players`, `live_game_sessions`), Row Level Security policies, and game session RPCs (`start_live_game_session`, `end_live_game_session`, `get_live_leaderboard`, `get_live_player_rank`).
3. **`007_remote_config.sql`**: `live_game_config` table for dynamic physics tuning.
4. **`008_auth_trigger.sql`**: PostgreSQL trigger to create user profiles in `live_players` upon Supabase Auth sign-up.
5. **`009_fix_permissions.sql`**: Grants table privileges to `anon` and `authenticated` roles, handles profile backfilling, and adds robust conflict handling.


### Deploying Edge Functions (Optional)

If using the Telegram notification bot and server-side Turnstile verification, deploy the edge functions using the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
# Login to Supabase CLI
supabase login

# Link your remote project
supabase link --project-ref <your-project-ref>

# Set edge function secrets
supabase secrets set TELEGRAM_BOT_TOKEN="<your-bot-token>" TELEGRAM_CHAT_ID="<your-chat-id>" WEBHOOK_SECRET="<secret>"

# Deploy functions
supabase functions deploy notify-telegram
supabase functions deploy telegram-webhook
supabase functions deploy register-player
```

---

## ⚙️ Game State Architecture

The game is structured as a discrete finite state machine in `src/main.js`:

```
   ┌─────────────┐
   │   LOADING   │
   └──────┬──────┘
          │ (Assets loaded)
          ▼
   ┌─────────────┐       (First time / Not logged in)
   │  REGISTER   ├──────────────────────────────────┐
   └──────┬──────┘                                  │
          │ (Logged in)                             │
          ▼                                         │
   ┌─────────────┐                                  │
   │    HOME     │◄─────────────────────────────────┘
   └──────┬──────┘
          │ (Play Pressed)
          ▼
   ┌─────────────┐     (Pause / DevTools / Orientation)     ┌─────────────┐
   │   PLAYING   │ ◄──────────────────────────────────────► │   PAUSED    │
   └──────┬──────┘                                          └─────────────┘
          │ (Collision / Cheat Detected)
          ▼
   ┌─────────────┐
   │  GAME_OVER  │
   └──────┬──────┘
          │
          ├──► LEADERBOARD (View Global Rankings)
          ├──► SETTINGS (Toggle Audio / SFX)
          └──► PLAYING (Retry)
```

---

## 🛡️ Fair Play & Security

Bone Runner includes proactive client and server-side cheat deterrence:
- **Zero Raw Score Posting**: Clients cannot directly write arbitrary scores to the database; scores are verified against elapsed session time, jumps, and dodges recorded during active sessions.
- **Heartbeat Verification**: A 5-second interval heartbeat validates ongoing active gameplay.
- **Code Obfuscation**: Production output transforms function names, encrypts strings with Base64 arrays, and introduces control flow indirection to hinder reverse-engineering.
- **Immediate Admin Action**: Moderators can review high-score notifications directly on Telegram and delete suspicious entries using `/delete <playerId>`.

---

## 📄 License

This project is maintained for Genesis. All character sprites, audio assets, and original logos belong to their respective creators.
