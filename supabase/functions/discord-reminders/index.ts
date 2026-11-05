// NYX 11744 — Discord shift reminder bot.
//
// Runs every 15 minutes (pg_cron → supabase/discord_reminders.sql) and posts to a Discord channel
// through a webhook, @mentioning members who saved their Discord user id in their profile:
//   • Morning schedule:  once a day at DIGEST_HOUR (Pacific) — today's shifts + who's on, tomorrow preview
//   • Heads-up:          REMINDER_LEAD_MINUTES before each shift starts, pinging that shift's roster
//   • New assignments:   when someone is added to an upcoming shift (by an admin, Claude, or themselves)
// Each message is sent once; keys are recorded in public.shift_notifications.
//
// Department-specific announcements:
//   Shifts can be announced directly or reminded into department channels:
//   - Mechanical → #mechanical-announcements
//   - Electrical → #electrical-announcements
//   - Software → #software-announcements
//   - Business / All Departments → #announcements
//
// Secrets (supabase secrets set …):
//   DISCORD_WEBHOOK_URL            Channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL
//   DISCORD_WEBHOOK_MECHANICAL     (optional, defaults to DISCORD_WEBHOOK_URL or app_settings)
//   DISCORD_WEBHOOK_ELECTRICAL     (optional, defaults to DISCORD_WEBHOOK_URL or app_settings)
//   DISCORD_WEBHOOK_SOFTWARE       (optional, defaults to DISCORD_WEBHOOK_URL or app_settings)
//   CRON_SECRET                    any long random string; the cron job sends it in the x-cron-secret header
// Optional: DIGEST_HOUR (default 7), REMINDER_LEAD_MINUTES (default 120), SITE_URL
// Optional auto-linking of Discord IDs by server nickname (needs a bot in the server):
//   DISCORD_BOT_TOKEN     Developer Portal → your app → Bot → Reset Token (enable "Server Members Intent")
//   DISCORD_GUILD_ID      the server id (right-click server icon → Copy Server ID)
//   Members whose profile has no Discord ID are matched by nickname: full name, then unique first
//   name, then first name + last initial when first names repeat. Manually entered IDs always win.
//
// Deploy: supabase functions deploy discord-reminders --no-verify-jwt
// Manual test: POST …/discord-reminders?mode=test   (posts a test message)
//              POST …/discord-reminders?dry=1       (returns what it would post, sends nothing)

import { createClient } from "npm:@supabase/supabase-js@2";

const TZ = "America/Los_Angeles";
const WEBHOOK = Deno.env.get("DISCORD_WEBHOOK_URL") || "";
const WEBHOOK_MECH = Deno.env.get("DISCORD_WEBHOOK_MECHANICAL") || "";
const WEBHOOK_ELEC = Deno.env.get("DISCORD_WEBHOOK_ELECTRICAL") || "";
const WEBHOOK_SOFT = Deno.env.get("DISCORD_WEBHOOK_SOFTWARE") || "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const DIGEST_HOUR = Number(Deno.env.get("DIGEST_HOUR") ?? 7);
const LEAD_MIN = Number(Deno.env.get("REMINDER_LEAD_MINUTES") ?? 120);
const SITE_URL = Deno.env.get("SITE_URL") || "https://dashboard.nyx11744.org/";
const BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN") || "";
const GUILD_ID = Deno.env.get("DISCORD_GUILD_ID") || "";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

type Shift = {
  id: string; title: string; department: string; shift_date: string; start_time: string; end_time: string;
  location: string; attendees: string[]; notes: string; lead_name?: string;
};
type Post = { content: string; users: string[]; department?: string };

/* ---------- department webhook resolver ---------- */

async function getWebhookForDept(dept?: string): Promise<string> {
  const norm = (dept || "").toLowerCase().trim();
  // 1. Check environment variables
  if (norm === "mechanical" && WEBHOOK_MECH) return WEBHOOK_MECH;
  if (norm === "electrical" && WEBHOOK_ELEC) return WEBHOOK_ELEC;
  if (norm === "software" && WEBHOOK_SOFT) return WEBHOOK_SOFT;

  // 2. Check public.app_settings table in Supabase
  try {
    let settingKey = "discord_webhook_general";
    if (norm === "mechanical") settingKey = "discord_webhook_mechanical";
    else if (norm === "electrical") settingKey = "discord_webhook_electrical";
    else if (norm === "software") settingKey = "discord_webhook_software";

    const { data } = await db.from("app_settings").select("value").eq("key", settingKey).maybeSingle();
    if (data?.value && data.value.startsWith("http")) return data.value;

    if (settingKey !== "discord_webhook_general") {
      const { data: fallback } = await db.from("app_settings").select("value").eq("key", "discord_webhook_general").maybeSingle();
      if (fallback?.value && fallback.value.startsWith("http")) return fallback.value;
    }
  } catch (err) {
    console.warn("Could not query app_settings for webhook:", (err as Error).message);
  }

  // 3. Fallback to default WEBHOOK
  return WEBHOOK;
}

/* ---------- time helpers (all shift times are Pacific wall-clock) ---------- */

function pacificNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map(p => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), hour: Number(parts.hour) };
}
const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };
const addDays = (date: string, n: number) => {
  const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const fmtTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const fmtDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const cleanNotes = (n: string) => (n || "").replace("[🔁 Weekly Shift]", "").trim();

/* ---------- formatting ---------- */

function mentionFor(names: string[], ids: Map<string, string>) {
  const users: string[] = [];
  const text = names.map(n => {
    const id = ids.get(n.trim().toLowerCase());
    if (id) { users.push(id); return `<@${id}>`; }
    return `**${n}**`;
  }).join(", ");
  return { text, users };
}

function shiftLine(s: Shift, ids: Map<string, string>) {
  const who = s.attendees?.length ? mentionFor(s.attendees, ids) : { text: "⚠️ *nobody scheduled yet*", users: [] };
  const allUsers = [...who.users];
  let leadText = "";
  if (s.lead_name) {
    const leadMention = mentionFor([s.lead_name], ids);
    leadText = `\n👑 **Shift Lead:** ${leadMention.text}`;
    allUsers.push(...leadMention.users);
  }
  const isAllDay = (s.start_time === "00:00" && s.end_time === "23:59") || (s.start_time === s.end_time && s.start_time === "00:00");
  const timeDesc = isAllDay ? "📅 Full Day Event" : `🕒 ${fmtTime(s.start_time)}–${fmtTime(s.end_time)}`;
  return {
    text: `**${s.title}** · ${s.department}\n${timeDesc} · 📍 ${s.location || "Main Shop"}${leadText}\n👥 ${who.text}`,
    users: allUsers,
  };
}

/* ---------- discord ---------- */

function chunk(post: Post): Post[] {
  if (post.content.length <= 1900) return [post];
  const out: Post[] = [];
  let cur = "";
  for (const block of post.content.split("\n\n")) {
    if ((cur + "\n\n" + block).length > 1900 && cur) { out.push({ content: cur, users: post.users, department: post.department }); cur = block; }
    else cur = cur ? cur + "\n\n" + block : block;
  }
  if (cur) out.push({ content: cur, users: post.users, department: post.department });
  return out;
}

async function send(post: Post, targetWebhook?: string) {
  const hook = targetWebhook || await getWebhookForDept(post.department);
  if (!hook) {
    console.warn("No Discord webhook configured for shift notification.");
    return;
  }
  for (const part of chunk(post)) {
    const users = [...new Set(part.users)].filter(u => part.content.includes(`<@${u}>`)).slice(0, 100);
    const res = await fetch(hook + (hook.includes("?") ? "&" : "?") + "wait=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "NYX Shift Bot",
        content: part.content,
        allowed_mentions: { parse: [], users }, // only ping the people on the shift
      }),
    });
    if (res.status === 429) {
      const retry = Number((await res.json()).retry_after || 1);
      await new Promise(r => setTimeout(r, retry * 1000));
      await send(part, hook);
    } else if (!res.ok) {
      throw new Error(`Discord webhook failed (${res.status}): ${await res.text()}`);
    }
  }
}

/* ---------- auto-link Discord IDs from server nicknames ---------- */

const nameWords = (s: string) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);

async function fetchGuildMembers() {
  const members: { id: string; names: string[][] }[] = [];
  let after = "0";
  for (let page = 0; page < 10; page++) {
    const res = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1000&after=${after}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Discord member list failed (${res.status}) — is "Server Members Intent" enabled for the bot? ${await res.text()}`);
    const batch = await res.json();
    for (const m of batch) {
      if (m.user?.bot) continue;
      const names = [m.nick, m.user?.global_name, m.user?.username].filter(Boolean).map(nameWords).filter(w => w.length);
      members.push({ id: m.user.id, names });
    }
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }
  return members;
}

type Profile = { id: string; full_name: string; discord_id: string | null };

async function autoLinkDiscordIds(profiles: Profile[]): Promise<string[]> {
  if (!BOT_TOKEN || !GUILD_ID) return [];
  const missing = profiles.filter(p => !p.discord_id);
  if (!missing.length) return [];

  const members = await fetchGuildMembers();
  const linked: string[] = [];

  for (const prof of missing) {
    const pWords = nameWords(prof.full_name);
    if (!pWords.length) continue;

    // 1. Exact match on full name
    const exact = members.filter(m => m.names.some(n => n.join(" ") === pWords.join(" ")));
    if (exact.length === 1) {
      await db.from("profiles").update({ discord_id: exact[0].id }).eq("id", prof.id);
      prof.discord_id = exact[0].id;
      linked.push(`${prof.full_name} → ${exact[0].id} (full name)`);
      continue;
    }

    // 2. Unique first name in the server
    const first = pWords[0];
    const matchingFirst = members.filter(m => m.names.some(n => n[0] === first));
    if (matchingFirst.length === 1) {
      await db.from("profiles").update({ discord_id: matchingFirst[0].id }).eq("id", prof.id);
      prof.discord_id = matchingFirst[0].id;
      linked.push(`${prof.full_name} → ${matchingFirst[0].id} (unique first name)`);
      continue;
    }

    // 3. First name + last initial (e.g. "Raymond L")
    if (pWords.length >= 2) {
      const lastInit = pWords[pWords.length - 1][0];
      const withInitial = members.filter(m => m.names.some(n => n[0] === first && n.length >= 2 && n[n.length - 1][0] === lastInit));
      if (withInitial.length === 1) {
        await db.from("profiles").update({ discord_id: withInitial[0].id }).eq("id", prof.id);
        prof.discord_id = withInitial[0].id;
        linked.push(`${prof.full_name} → ${withInitial[0].id} (first + last initial)`);
      }
    }
  }
  return linked;
}

/* ---------- announcement generator ---------- */

function createShiftAnnouncement(s: Shift, ids: Map<string, string>, reason = "New Shift Scheduled"): Post {
  const l = shiftLine(s, ids);
  const notes = cleanNotes(s.notes);
  const isAllDay = (s.start_time === "00:00" && s.end_time === "23:59") || (s.start_time === s.end_time && s.start_time === "00:00");
  const timeDesc = isAllDay ? "📅 Full Day Event" : `🕒 ${fmtTime(s.start_time)} – ${fmtTime(s.end_time)}`;
  
  let headerEmoji = "📢";
  if (s.department === "Mechanical") headerEmoji = "⚙️";
  else if (s.department === "Electrical") headerEmoji = "⚡";
  else if (s.department === "Software") headerEmoji = "💻";

  const lines = [
    `${headerEmoji} **${reason.toUpperCase()}: ${s.title}**`,
    `📂 **Department:** ${s.department}`,
    `🗓️ **Date:** ${fmtDate(s.shift_date)}`,
    `⏰ **Time:** ${timeDesc}`,
    `📍 **Location:** ${s.location || "Main Shop"}`
  ];

  if (s.lead_name) {
    const leadMention = mentionFor([s.lead_name], ids);
    lines.push(`👑 **Shift Lead:** ${leadMention.text}`);
  }

  const attendeesMention = s.attendees?.length ? mentionFor(s.attendees, ids) : { text: "None signed up yet — join in the dashboard!", users: [] };
  lines.push(`👥 **Roster (${s.attendees?.length || 0}):** ${attendeesMention.text}`);

  if (notes) {
    lines.push(`📝 **Goals / Notes:** ${notes}`);
  }

  lines.push(`\n👉 Join, swap, or view details: <${SITE_URL}>`);

  const allUsers = [...new Set([...l.users, ...attendeesMention.users])];
  return {
    content: lines.join("\n"),
    users: allUsers,
    department: s.department
  };
}

/* ---------- runner ---------- */

/* Keys sent in the last 45 days (older ones are pruned; the window covers every key we can still need) */
async function loadSentKeys() {
  const since = new Date(Date.now() - 45 * 86400_000).toISOString();
  await db.from("shift_notifications").delete().lt("sent_at", since);
  const sent = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("shift_notifications").select("key").range(from, from + 999);
    if (error) throw error;
    (data || []).forEach(r => sent.add(r.key));
    if (!data || data.length < 1000) return sent;
  }
}
async function markSent(keys: string[]) {
  if (keys.length) await db.from("shift_notifications").upsert(keys.map(key => ({ key })), { ignoreDuplicates: true });
}

async function run(dry: boolean) {
  const now = pacificNow();
  const tomorrow = addDays(now.date, 1);

  const [{ data: shifts, error: sErr }, { data: profiles, error: pErr }] = await Promise.all([
    db.from("team_shifts").select("id, title, department, shift_date, start_time, end_time, location, attendees, notes, lead_name")
      .gte("shift_date", now.date).lte("shift_date", addDays(now.date, 21)).order("shift_date").order("start_time"),
    db.from("profiles").select("id, full_name, discord_id").eq("is_approved", true),
  ]);
  if (sErr) throw sErr;
  if (pErr) throw pErr;

  let linked: string[] = [];
  try {
    linked = dry ? [] : await autoLinkDiscordIds(profiles || []);
  } catch (err) {
    console.error("Discord auto-link skipped:", (err as Error).message);
  }

  const ids = new Map<string, string>();
  for (const p of profiles || []) if (p.discord_id) ids.set(p.full_name.trim().toLowerCase(), p.discord_id);

  const all = (shifts || []) as Shift[];
  const sent = await loadSentKeys();
  const posts: { key: string[]; post: Post }[] = [];

  // 1. Morning schedule
  const digestKey = `digest:${now.date}`;
  if (now.hour >= DIGEST_HOUR && !sent.has(digestKey)) {
    const today = all.filter(s => s.shift_date === now.date);
    const tmrw = all.filter(s => s.shift_date === tomorrow);
    if (today.length || tmrw.length) {
      const users: string[] = [];
      const blocks = [`☀️ **NYX Shift Schedule — ${fmtDate(now.date)}**`];
      if (today.length) {
        for (const s of today) { const l = shiftLine(s, ids); users.push(...l.users); blocks.push(l.text); }
      } else {
        blocks.push("No shifts today.");
      }
      if (tmrw.length) {
        blocks.push(`**Tomorrow (${fmtDate(tomorrow)}):** ` + tmrw.map(s => `${s.title} ${fmtTime(s.start_time)} (${s.attendees?.length || 0} on)`).join(" · "));
      }
      blocks.push(`Sign up or swap: <${SITE_URL}>`);
      posts.push({ key: [digestKey], post: { content: blocks.join("\n\n"), users, department: "All Departments" } });
    } else {
      posts.push({ key: [digestKey], post: { content: "", users: [], department: "All Departments" } }); // nothing to say; still mark the day done
    }
  }

  // 2. Heads-up before each shift (key includes date+time so a rescheduled shift reminds again)
  const soon = all.filter(s => {
    if (s.shift_date !== now.date) return false;
    const until = toMin(s.start_time) - now.minutes;
    return until > 0 && until <= LEAD_MIN;
  });
  const soonKeys = soon.map(s => `reminder:${s.id}:${s.shift_date}:${s.start_time}`);
  soon.forEach((s, i) => {
    if (sent.has(soonKeys[i]) || !s.attendees?.length) return;
    const mins = toMin(s.start_time) - now.minutes;
    const when = mins >= 90 ? `in about ${Math.round(mins / 60)} hours` : `in ${mins} minutes`;
    const l = shiftLine(s, ids);
    const notes = cleanNotes(s.notes);
    posts.push({ key: [soonKeys[i]], post: { content: `⏰ **Shift starting ${when}!**\n${l.text}${notes ? `\n📝 ${notes}` : ""}`, users: l.users, department: s.department } });
  });

  // 3. Newly scheduled people on upcoming shifts
  const assignKeys: string[] = [];
  const byShift = new Map<string, { s: Shift; names: string[] }>();
  for (const s of all) for (const n of s.attendees || []) {
    const k = `assigned:${s.id}:${n.trim().toLowerCase()}`;
    assignKeys.push(k);
    byShift.set(k, { s, names: [n] });
  }
  const anyAssigned = [...sent].some(k => k.startsWith("assigned:"));
  const fresh = assignKeys.filter(k => !sent.has(k));

  if (!anyAssigned) {
    // First run: record the existing roster quietly instead of pinging everyone at once
    if (fresh.length) posts.push({ key: fresh, post: { content: "", users: [], department: "All Departments" } });
  } else if (fresh.length) {
    const grouped = new Map<string, { s: Shift; names: string[]; keys: string[] }>();
    for (const k of fresh) {
      const { s, names } = byShift.get(k)!;
      const g = grouped.get(s.id) || { s, names: [], keys: [] };
      g.names.push(...names); g.keys.push(k);
      grouped.set(s.id, g);
    }
    const users: string[] = [];
    const blocks = ["📌 **You're on the schedule**"];
    for (const { s, names } of grouped.values()) {
      const m = mentionFor(names, ids);
      users.push(...m.users);
      blocks.push(`${m.text} → **${s.title}** · ${fmtDate(s.shift_date)}, ${fmtTime(s.start_time)}–${fmtTime(s.end_time)} · 📍 ${s.location || "Main Shop"}`);
    }
    blocks.push(`Can't make it? Leave the shift in the app so someone can cover: <${SITE_URL}>`);
    posts.push({ key: fresh, post: { content: blocks.join("\n"), users, department: "All Departments" } });
  }

  const report = posts.filter(p => p.post.content).map(p => p.post.content);
  if (!dry) {
    for (const p of posts) {
      if (p.post.content) await send(p.post);
      await markSent(p.key);
    }
  }
  return { now, sent: report.length, linked, messages: dry ? report : undefined };
}

Deno.serve(async req => {
  const url = new URL(req.url);

  // Allow instant shift announcement or direct test
  if (req.method === "POST" && url.searchParams.get("mode") === "announce") {
    try {
      const body = await req.json();
      const shift = body.shift as Shift;
      if (!shift || !shift.title) {
        return Response.json({ ok: false, error: "Missing shift payload" }, { status: 400 });
      }
      const { data: profiles } = await db.from("profiles").select("id, full_name, discord_id").eq("is_approved", true);
      const ids = new Map<string, string>();
      for (const p of profiles || []) if (p.discord_id) ids.set(p.full_name.trim().toLowerCase(), p.discord_id);

      const post = createShiftAnnouncement(shift, ids, body.reason || "Shift Scheduled");
      const targetHook = await getWebhookForDept(shift.department);
      if (!targetHook) {
        return Response.json({ ok: false, error: `No webhook configured for department "${shift.department}"` }, { status: 400 });
      }
      await send(post, targetHook);
      return Response.json({ ok: true, department: shift.department, announced: true });
    } catch (err) {
      console.error("Announce error:", err);
      return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
    }
  }

  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    if (url.searchParams.get("mode") === "test") {
      const dept = url.searchParams.get("dept") || undefined;
      const hook = await getWebhookForDept(dept);
      if (!hook) return new Response("No webhook configured for " + (dept || "general"), { status: 500 });
      await send({ content: `✅ **NYX Shift Bot is connected** to **${dept || "General"}**. Shift reminders will post in this channel.`, users: [], department: dept }, hook);
      return Response.json({ ok: true, test: true, department: dept || "default" });
    }
    const result = await run(url.searchParams.get("dry") === "1");
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
});
