# Kuess

Everyone knows your number. Except you.

A party game for phones around one table. Each player gets a secret number. You can see everyone's number but your own, and you take turns trying to kuess it.

★ Krit's vibe code ★

## Files

```
index.html            the page
css/style.css         the look: felt table, ivory cards, brass
js/config.js          your Supabase URL + key  (the only file you edit)
js/api.js             every call to Supabase
js/views.js           every screen, as HTML
js/app.js             what each button does, live sync
js/i18n.js            EN / TH / JP text
supabase/schema.sql   database, rules, and the referee
```

No build step. GitHub Pages serves the files as they are.

## Set up (about 10 minutes)

### 1. Supabase

1. Create a project at supabase.com (or reuse one; everything lives in its own `kuess` schema, so it will not touch your other tables).
2. Open **SQL Editor**, paste all of `supabase/schema.sql`, press **Run**. Running it again later is safe.
3. In **Authentication** settings (Sign In / Providers), turn on **Allow anonymous sign-ins**. Each device becomes an anonymous player; nobody needs an account.
4. In **Project Settings > API Keys**, copy the **Project URL** and the **publishable** (or legacy **anon**) key into `js/config.js`.

The key is designed to be public, so committing it to GitHub is fine. The database only lets a browser call the `kuess_*` functions, and those decide what each player may see.

### 2. GitHub Pages

1. Create a new repository and upload everything in this folder (keep the folder structure).
2. **Settings > Pages > Build and deployment**: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
3. After a minute the game is live at `https://<your-username>.github.io/<repo-name>/`.

### 3. Try it

Open the link on two or more devices (or one normal window plus one private window; a device = a player). Create a room on one, join with the 5-digit number on the others.

To run it locally: `python3 -m http.server` in this folder, then open `http://localhost:8000`. Opening `index.html` straight from disk will not work, because browsers block modules on `file://`.

## How it works

The whole game hangs on one rule: you must never see your own number. So the numbers never reach your device at all.

- Tables live in a private `kuess` schema that browsers cannot read.
- Browsers can only call the `kuess_*` functions. `kuess_state` returns the room as the caller should see it: everyone's number except their own. Not visible in DevTools either, because it is never sent.
- Every move (kuess, pass, start, leave) is checked by the database: is it your turn, are you the host, do you have kuesses left. The database is the referee, so two phones can never disagree.
- Every change bumps `rooms.version`. Each phone listens to that one row over Supabase Realtime and re-reads its view. Phones that fall asleep catch up when they wake.

```
tap  ->  kuess_* function  ->  room.version + 1  ->  every phone re-reads  ->  screen updates
```

## Rules as built

- **Turns**: one action per turn. A kuess, right or wrong, ends your turn; "Still not sure" ends it too.
- **Out**: with a kuess limit, using the last chance on a wrong answer turns you ❌ and you skip future turns.
- **Random numbers** are all different while the range allows it (e.g. 5 players in 1–10).
- **Custom numbers**: the host types a number for every other player. The host's own number is drawn at random from the chosen range, since nobody can pick their own secret.
- **Memo**: a private notepad on your device, cleared when a new game starts. The host can switch it off for everyone.
- **Game over** when nobody is still guessing, or when the host ends it. The summary reveals every number, ranks who kuessed first, then who ran out first.
- **Leaving**: a player leaving skips their seat. The host leaving closes the room for everyone.
- **Play again** keeps the same people in the room.
- **Refresh-proof**: reloading the page puts you back in your seat.
- **Language** is per device (settings ⋮ on every screen).
- Rooms untouched for a day are cleaned up automatically.

## If something is off

- **"Turn on anonymous sign-ins"** message: step 1.3 above.
- **"Add your Supabase URL and key"** message: step 1.4 above.
- **Joining works but screens do not update live**: re-run `schema.sql` (it registers the room table for Realtime).
- **Nothing connects after a quiet week**: free Supabase projects can pause when idle. Restore the project from the dashboard.
