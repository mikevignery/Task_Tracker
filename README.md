# Task Tracker

A single-user project/task tracker that runs as a static site on **GitHub Pages** and stores data in **Supabase**. Plain HTML/CSS/JS, no build step.

```
Project  (only created by you)
 └─ Task  (project is optional)
     ├─ Task Note
     └─ Work Log  (manual minutes, or start/stop timer)
         └─ Work Log Note
```

Every **+ New …** button pre-selects its parent (a new task from a project page has that project selected, a new note from a task page has that task selected, and so on). You can still change the dropdown. A work log note has two chained dropdowns: **Task**, then that task's **Work log**.

## 1. Create the Supabase project

1. Go to <https://supabase.com/dashboard> and create a project (free tier is fine).
2. Open **SQL Editor > New query**, paste all of `schema.sql`, and click **Run**. This creates the tables and turns on Row Level Security (RLS).
3. Open **Authentication > Users > Add user** and create your own login (email + password), ticking "Auto confirm user".
4. Then turn off public sign-ups: **Authentication > Sign In / Providers** and switch off "Allow new users to sign up". This stops anyone else from registering against your database.
5. Open **Project Settings > API** and copy the **Project URL** and the **anon / publishable** key.

## 2. Configure the site

Edit `config.js`:

```js
window.TASK_TRACKER_CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-key"
};
```

The anon key is meant to be public. RLS is what protects your data. **Never put the `service_role` / secret key in this repo.**

## 3. Put it on GitHub Pages

1. Create a GitHub repo and push these files (`index.html`, `app.js`, `style.css`, `config.js`, `schema.sql`, `README.md`).
2. **Settings > Pages > Build and deployment**: Source = "Deploy from a branch", Branch = `main`, folder `/ (root)`.
3. Your site will appear at `https://<you>.github.io/<repo>/`.

A public repo means your anon key and schema are public. That is fine as long as RLS is on and sign-ups are off. Use a private repo if you prefer (Pages on private repos needs a paid GitHub plan).

## 4. Meeting transcripts to tasks

Open **Import transcript**:

1. Click **Copy prompt**, paste it into Claude, and replace the last line with your transcript.
2. Claude replies with a JSON object of action items (title, description, priority, due date, owner, supporting quote).
3. Paste the JSON into the app and click **Preview drafts**.
4. Edit, untick, and choose a project for each draft, then **Save selected tasks**. Nothing is saved before this step, and no project is ever created automatically.

Saved tasks are marked "From transcript" and get a note with the meeting title, owner and quote.

**Later upgrade (optional):** a Supabase Edge Function that calls the Claude API so you can paste a transcript directly in the app. It needs an API key stored as a Supabase secret (never in this repo) and has per-use cost. The draft-review screen would stay the same.

## Security checklist

- RLS is enabled on all five tables and every policy requires `user_id = auth.uid()`.
- Child rows can only point at parents you own.
- No access is granted to the logged-out (`anon`) role.
- `service_role` key is not used anywhere.
- All user text is rendered as text, not HTML.

## Notes and limits

- Deleting a project keeps its tasks (they become "No project"). Deleting a task deletes its notes and work logs.
- Only one timer can run at a time.
- Times are stored as minutes. A timer rounds up to at least 1 minute.
