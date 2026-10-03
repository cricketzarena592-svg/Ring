import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, VAPID_PUBLIC_KEY } from "./supabase-config.js";

const $ = (selector) => document.querySelector(selector);
const state = {
  client: null,
  user: null,
  profile: null,
  rings: [],
  selectedRingId: null,
  channels: [],
  incoming: null,
  incomingResponses: [],
  outgoing: null,
  responses: [],
  pendingDeleteRingId: null,
  pendingRingEventId: new URLSearchParams(window.location.search).get("ringEvent"),
  serviceWorkerRegistration: null,
  notificationsEnabled: false,
  ringtoneTimer: null,
  ringtoneAudio: null,
  authMode: "signin",
  toastTimer: null,
  installPrompt: null,
};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) {
    button.dataset.originalLabel = button.innerHTML;
    button.textContent = label;
  } else if (button.dataset.originalLabel) {
    button.innerHTML = button.dataset.originalLabel;
    delete button.dataset.originalLabel;
  }
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog?.open) dialog.close();
}

function isPrivilegedKey(key) {
  if (/service_role|sb_secret_/i.test(key)) return true;
  const encodedPayload = key.split(".")[1];
  if (!encodedPayload) return false;
  try {
    const base64 = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

async function configureClient() {
  const normalizedUrl = SUPABASE_URL.trim().replace(/\/$/, "");
  const normalizedKey = SUPABASE_PUBLISHABLE_KEY.trim();
  if (!/^https:\/\/[\w.-]+\.supabase\.co$/.test(normalizedUrl)) {
    throw new Error("The configured Supabase project URL is invalid.");
  }
  if (!normalizedKey || isPrivilegedKey(normalizedKey)) {
    throw new Error("Configure a public anon or publishable key, not a secret or service-role key.");
  }
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  state.client = createClient(normalizedUrl, normalizedKey);
  state.client.auth.onAuthStateChange((_event, session) => {
    handleSession(session).catch((error) => notify(error.message));
  });
  return state.client;
}

async function start() {
  try {
    await configureClient();
    const { data, error } = await state.client.auth.getSession();
    if (error) throw error;
    await handleSession(data.session);
  } catch (error) {
    notify(`Unable to connect to Supabase: ${error.message}`);
  }
}

async function handleSession(session) {
  if (!session?.user) {
    state.user = null;
    state.profile = null;
    state.rings = [];
    state.notificationsEnabled = false;
    stopRingtone();
    stopRealtime();
    $("#auth-view").hidden = false;
    $("#app-view").hidden = true;
    return;
  }
  if (state.user?.id === session.user.id && state.profile) return;
  state.user = session.user;
  $("#auth-view").hidden = true;
  $("#app-view").hidden = false;
  await loadWorkspace();
}

function setAuthMode(mode) {
  state.authMode = mode;
  const isSignup = mode === "signup";
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    const active = tab.dataset.authMode === mode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  $("#signup-fields").hidden = !isSignup;
  $("#signup-fields [name=ring_id]").required = isSignup;
  $("#auth-heading").textContent = isSignup ? "Create your account" : "Sign in to your account";
  $("#auth-submit").innerHTML = isSignup ? 'Create account <span aria-hidden="true">↗</span>' : 'Sign in <span aria-hidden="true">↗</span>';
}

function cleanRingId(value) {
  const normalized = value.trim().toLowerCase().replace(/^@+/, "").replace(/[^a-z0-9_.-]/g, "_");
  return `@${normalized}`;
}

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.client) {
    notify("Supabase is not ready yet. Refresh the app and try again.");
    return;
  }
  const form = new FormData(event.currentTarget);
  const button = $("#auth-submit");
  setBusy(button, true, state.authMode === "signup" ? "Creating account…" : "Signing in…");
  try {
    let result;
    if (state.authMode === "signup") {
      const ringId = cleanRingId(form.get("ring_id"));
      if (ringId.length < 3) throw new Error("Add a Ring ID to continue.");
      const emailRedirectTo = new URL("./", window.location.href).toString();
      result = await state.client.auth.signUp({
        email: String(form.get("email")).trim(),
        password: String(form.get("password")),
        options: { data: { ring_id: ringId }, emailRedirectTo },
      });
      if (result.error) throw result.error;
      if (!result.data.session) notify("Account created. Check your email to confirm, then sign in.");
      else await handleSession(result.data.session);
    } else {
      result = await state.client.auth.signInWithPassword({
        email: String(form.get("email")).trim(),
        password: String(form.get("password")),
      });
      if (result.error) throw result.error;
      await handleSession(result.data.session);
    }
  } catch (error) {
    notify(error.message || "Unable to continue. Please try again.");
  } finally {
    setBusy(button, false);
  }
});

async function loadWorkspace() {
  const [{ data: profile, error: profileError }, { data: memberships, error: membershipsError }] = await Promise.all([
    state.client.from("profiles").select("id, ring_id, ring_no").eq("id", state.user.id).single(),
    state.client.from("ring_members").select("ring_id, rings(id, name, default_topic, created_by, created_at)").eq("user_id", state.user.id),
  ]);
  if (profileError) throw profileError;
  if (membershipsError) throw membershipsError;
  state.profile = profile;
  state.rings = (memberships || []).map((membership) => membership.rings).filter(Boolean);
  state.rings.sort((first, second) => first.name.localeCompare(second.name));
  const query = $("#ring-search-input").value.trim().toLowerCase();
  const visibleRings = state.rings.filter((ring) => ring.name.toLowerCase().includes(query));
  if (!visibleRings.some((ring) => ring.id === state.selectedRingId)) {
    state.selectedRingId = visibleRings[0]?.id || null;
  }
  renderProfile();
  await Promise.all([loadMembers(), findActiveEvents()]);
  renderRings();
  subscribeRealtime();
}

function renderProfile() {
  const ringId = state.profile?.ring_id || "Your profile";
  const initial = ringId.replace(/^@/, "").charAt(0).toUpperCase() || "R";
  $("#sidebar-ring-id").textContent = ringId;
  $("#avatar-initial").textContent = initial;
  $("#open-profile-top").textContent = initial;
  $("#profile-ring-id").textContent = ringId;
  $("#profile-ring-no").textContent = state.profile?.ring_no || "—";
}

async function loadMembers() {
  if (!state.rings.length) {
    state.rings.forEach((ring) => { ring.members = []; });
    return;
  }
  const { data, error } = await state.client
    .from("ring_members")
    .select("ring_id, user_id, profiles(id, ring_id, ring_no)")
    .in("ring_id", state.rings.map((ring) => ring.id));
  if (error) throw error;
  const byRing = new Map(state.rings.map((ring) => [ring.id, []]));
  for (const member of data || []) byRing.get(member.ring_id)?.push(member);
  state.rings.forEach((ring) => { ring.members = byRing.get(ring.id) || []; });
}

async function findActiveEvents() {
  if (!state.rings.length) {
    state.incoming = null;
    state.outgoing = null;
    if (state.pendingRingEventId) {
      notify("That Ring has ended or is no longer available.");
      state.pendingRingEventId = null;
      history.replaceState({}, "", new URL("./", window.location.href));
    }
    return;
  }
  const { data, error } = await state.client
    .from("ring_events")
    .select("id, ring_id, sender_id, topic, status, created_at")
    .in("ring_id", state.rings.map((ring) => ring.id))
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const own = data?.find((item) => item.sender_id === state.user.id) || null;
  const linkedEvent = data?.find((item) => item.id === state.pendingRingEventId) || null;
  const incoming = linkedEvent?.sender_id !== state.user.id && linkedEvent
    ? linkedEvent
    : data?.find((item) => item.sender_id !== state.user.id) || null;
  if (state.pendingRingEventId && !linkedEvent) notify("That Ring has ended or is no longer available.");
  if (state.pendingRingEventId) {
    state.pendingRingEventId = null;
    history.replaceState({}, "", new URL("./", window.location.href));
  }
  state.outgoing = own;
  state.incoming = incoming;
  if (own) await refreshResponses(own.id, "outgoing");
  if (incoming) {
    await refreshResponses(incoming.id, "incoming");
    renderIncoming();
    openIncoming();
    playRingtone();
  } else {
    stopRingtone();
    closeDialog("incoming-dialog");
  }
}

function stopRealtime() {
  if (state.client && state.channels.length) state.client.removeChannel(state.channels[0]);
  state.channels = [];
}

function subscribeRealtime() {
  stopRealtime();
  if (!state.rings.length) return;
  const channel = state.client.channel(`ring-live-${state.user.id}`);
  for (const ring of state.rings) {
    channel.on("postgres_changes", { event: "INSERT", schema: "public", table: "ring_events", filter: `ring_id=eq.${ring.id}` }, (payload) => {
      if (payload.new.sender_id !== state.user.id) receiveRing(payload.new);
    });
    channel.on("postgres_changes", { event: "UPDATE", schema: "public", table: "ring_events", filter: `ring_id=eq.${ring.id}` }, (payload) => {
      if (payload.new.status === "ended") eventEnded(payload.new);
    });
  }
  channel.on("postgres_changes", { event: "INSERT", schema: "public", table: "ring_members", filter: `user_id=eq.${state.user.id}` }, () => {
    loadWorkspace().catch((error) => notify(error.message));
  });
  channel.on("postgres_changes", { event: "*", schema: "public", table: "ring_responses" }, (payload) => {
    const eventId = payload.new?.event_id || payload.old?.event_id;
    if (eventId && [state.outgoing?.id, state.incoming?.id].includes(eventId)) {
      if (state.outgoing?.id === eventId) refreshResponses(eventId, "outgoing");
      if (state.incoming?.id === eventId) refreshResponses(eventId, "incoming");
    }
  });
  channel.subscribe((status) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      $("#live-status").innerHTML = '<i class="status-dot"></i> Reconnecting…';
    } else if (status === "SUBSCRIBED") {
      $("#live-status").innerHTML = '<i class="status-dot"></i> Live updates on';
    }
  });
  state.channels = [channel];
}

async function refreshResponses(eventId, target) {
  const { data, error } = await state.client
    .from("ring_responses")
    .select("event_id, user_id, response, profiles(ring_id)")
    .eq("event_id", eventId);
  if (error) return;
  if (target === "outgoing" && state.outgoing?.id === eventId) state.responses = data || [];
  if (target === "incoming" && state.incoming?.id === eventId) state.incomingResponses = data || [];
  renderRings();
}

function receiveRing(event) {
  state.incoming = event;
  state.incomingResponses = [];
  const senderRing = state.rings.find((ring) => ring.id === event.ring_id);
  state.selectedRingId = senderRing?.id || state.selectedRingId;
  refreshResponses(event.id, "incoming");
  renderRings();
  renderIncoming();
  openIncoming();
  playRingtone();
}

function eventEnded(event) {
  if (state.incoming?.id === event.id) {
    state.incoming = null;
    state.incomingResponses = [];
    stopRingtone();
    closeDialog("incoming-dialog");
  }
  if (state.outgoing?.id === event.id) {
    state.outgoing = null;
    state.responses = [];
  }
  renderRings();
}

function primeRingtoneAudio() {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) return;
  try {
    state.ringtoneAudio ||= new AudioContextConstructor();
    state.ringtoneAudio.resume().catch((error) => {
      console.warn("Ring tone audio could not start.", error);
    });
  } catch (error) {
    console.warn("Ring tone audio is unavailable on this device.", error);
  }
}

function playRingtone() {
  if (state.ringtoneTimer) return;
  primeRingtoneAudio();
  const playPhrase = () => {
    if (!state.ringtoneAudio || state.ringtoneAudio.state !== "running") return;
    const notes = [659.25, 783.99, 987.77, 783.99];
    const startAt = state.ringtoneAudio.currentTime + .03;
    notes.forEach((frequency, index) => {
      const start = startAt + index * .19;
      const oscillator = state.ringtoneAudio.createOscillator();
      const gain = state.ringtoneAudio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(.001, start);
      gain.gain.linearRampToValueAtTime(.11, start + .025);
      gain.gain.setValueAtTime(.11, start + .11);
      gain.gain.exponentialRampToValueAtTime(.001, start + .16);
      oscillator.connect(gain).connect(state.ringtoneAudio.destination);
      oscillator.start(start);
      oscillator.stop(start + .17);
    });
  };
  state.ringtoneAudio?.resume().then(playPhrase).catch((error) => {
    console.warn("Ring tone audio could not start; device vibration remains available.", error);
  });
  navigator.vibrate?.([180, 80, 180]);
  state.ringtoneTimer = window.setInterval(() => {
    playPhrase();
    navigator.vibrate?.([180, 80, 180]);
  }, 1900);
}

function stopRingtone() {
  if (state.ringtoneTimer) window.clearInterval(state.ringtoneTimer);
  state.ringtoneTimer = null;
  navigator.vibrate?.(0);
}

function openIncoming() {
  if (!state.incoming) return;
  const dialog = $("#incoming-dialog");
  if (!dialog.open) dialog.showModal();
}

function renderIncoming() {
  if (!state.incoming) return;
  const ring = state.rings.find((item) => item.id === state.incoming.ring_id);
  const caller = ring?.members?.find((member) => member.user_id === state.incoming.sender_id)?.profiles;
  $("#incoming-group").textContent = ring?.name || "Your Ring";
  $("#incoming-topic").textContent = state.incoming.topic;
  $("#incoming-sender").textContent = `Ring from ${caller?.ring_id || "a member"}`;
}

function renderRings() {
  $("#ring-count").textContent = String(state.rings.length);
  $("#empty-rings").hidden = state.rings.length > 0;
  $("#ring-search").hidden = state.rings.length === 0;
  const query = $("#ring-search-input").value.trim().toLowerCase();
  const visibleRings = state.rings.filter((ring) => ring.name.toLowerCase().includes(query));
  $("#no-ring-results").hidden = visibleRings.length > 0 || state.rings.length === 0;
  $("#ring-list").innerHTML = visibleRings.map((ring) => `
    <button class="ring-card ${ring.id === state.selectedRingId ? "is-selected" : ""}" type="button" data-select-ring="${escapeHtml(ring.id)}" aria-pressed="${ring.id === state.selectedRingId}">
      <span class="ring-symbol">${escapeHtml(ring.name.charAt(0).toUpperCase())}</span>
      <span class="ring-card-copy"><strong>${escapeHtml(ring.name)}</strong><small>${ring.members?.length || 0} ${(ring.members?.length || 0) === 1 ? "member" : "members"}</small></span>
      ${state.incoming?.ring_id === ring.id ? '<span class="ring-card-arrow" aria-label="Incoming Ring">●</span>' : '<span class="ring-card-arrow" aria-hidden="true">›</span>'}
    </button>`).join("");
  const ring = state.rings.find((item) => item.id === state.selectedRingId);
  if (!ring) {
    const hasQuery = query.length > 0;
    $("#ring-detail").innerHTML = `<div class="detail-empty"><span class="ring-symbol">r</span><h2>${hasQuery ? "No matching Ring" : state.rings.length ? "Choose a Ring" : "Your space is ready"}</h2><p>${hasQuery ? "Try another search to find a Ring." : state.rings.length ? "Select a Ring to see the group and start a check-in." : "Create your first Ring to get your people together."}</p></div>`;
    return;
  }
  const event = state.outgoing?.ring_id === ring.id ? state.outgoing : null;
  const responses = event ? state.responses : [];
  const yes = responses.filter((response) => response.response === "yes").length;
  const no = responses.filter((response) => response.response === "no").length;
  const waiting = Math.max(0, (ring.members?.length || 0) - 1 - responses.length);
  const responseRows = event ? (ring.members || []).filter((member) => member.user_id !== state.user.id).map((member) => {
    const response = responses.find((item) => item.user_id === member.user_id);
    const name = member.profiles?.ring_id || "Member";
    const answer = response?.response || "waiting";
    return `<div class="response-row"><span>${escapeHtml(name)}</span><span class="response-tag ${answer}">${answer === "yes" ? "YES" : answer === "no" ? "NO" : "WAITING"}</span></div>`;
  }).join("") : "";
  const members = (ring.members || []).map((member) => {
    const ringId = member.profiles?.ring_id || "Member";
    const isYou = member.user_id === state.user.id;
    return `<span class="member-chip"><span class="member-mini">${escapeHtml(ringId.replace(/^@/, "").charAt(0).toUpperCase())}</span>${escapeHtml(ringId)}${isYou ? " <small>you</small>" : ""}</span>`;
  }).join("");
  const canDelete = ring.created_by === state.user.id;
  $("#ring-detail").innerHTML = `
    <div class="detail-banner">
      <div class="ring-hero-avatar" aria-hidden="true">${escapeHtml(ring.name.charAt(0).toUpperCase())}</div>
      <span class="eyebrow">YOUR RING</span><h2>${escapeHtml(ring.name)}</h2><p>${escapeHtml(ring.default_topic)}</p>
      <div class="detail-actions">
        ${event ? `<button class="quiet-button stop-ring-button" type="button" data-end-event="${escapeHtml(event.id)}">■ Stop Ring</button>` : `<button class="primary-button ring-now-button" type="button" data-ring-now="${escapeHtml(ring.id)}">◉ Ring now</button>`}
        <button class="quiet-button detail-invite" type="button" data-invite-ring="${escapeHtml(ring.id)}">＋ Invite</button>
        ${canDelete ? `<details class="ring-options"><summary class="ring-options-button" aria-label="Ring options" title="Ring options">•••</summary><div class="ring-options-menu"><button class="delete-ring-option" type="button" data-delete-ring="${escapeHtml(ring.id)}">Delete Ring</button></div></details>` : ""}
      </div>
    </div>
    <div class="detail-section"><div class="detail-section-head"><h3>Members</h3><span>${ring.members?.length || 0} ${(ring.members?.length || 0) === 1 ? "person" : "people"}</span></div><div class="member-list">${members || "<span class=member-chip>No members yet</span>"}</div></div>
    ${event ? `<div class="response-summary"><div class="detail-section-head"><h3>Live responses</h3></div><div class="response-counts"><span class="response-count yes">${yes} yes</span><span class="response-count no">${no} no</span><span class="response-count waiting">${waiting} waiting</span></div><div class="response-list">${responseRows || '<span class="form-note">No one else in this Ring yet.</span>'}</div></div>` : ""}`;
}

$("#ring-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-select-ring]");
  if (!button) return;
  state.selectedRingId = button.dataset.selectRing;
  renderRings();
});
$("#ring-search-input").addEventListener("input", (event) => {
  const query = event.currentTarget.value.trim().toLowerCase();
  const match = state.rings.find((ring) => ring.name.toLowerCase().includes(query));
  state.selectedRingId = match?.id || null;
  renderRings();
});
$("#ring-detail").addEventListener("click", async (event) => {
  const ringButton = event.target.closest("[data-ring-now]");
  const inviteButton = event.target.closest("[data-invite-ring]");
  const endButton = event.target.closest("[data-end-event]");
  const deleteButton = event.target.closest("[data-delete-ring]");
  if (ringButton) await startRing(ringButton.dataset.ringNow);
  if (inviteButton) {
    $("#invite-form").dataset.ringId = inviteButton.dataset.inviteRing;
    openDialog("invite-dialog");
  }
  if (endButton) await endRing(endButton.dataset.endEvent);
  if (deleteButton) {
    deleteButton.closest(".ring-options")?.removeAttribute("open");
    const ring = state.rings.find((item) => item.id === deleteButton.dataset.deleteRing);
    if (!ring || ring.created_by !== state.user.id) {
      notify("Only the Ring creator can delete it.");
      return;
    }
    state.pendingDeleteRingId = ring.id;
    $("#delete-ring-name").textContent = ring.name;
    openDialog("delete-dialog");
  }
});

$("#delete-dialog").addEventListener("close", () => {
  state.pendingDeleteRingId = null;
});
$("#delete-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const ringId = state.pendingDeleteRingId;
  const ring = state.rings.find((item) => item.id === ringId);
  if (!ring || ring.created_by !== state.user.id) {
    notify("Only the Ring creator can delete it.");
    closeDialog("delete-dialog");
    return;
  }
  const formElement = event.currentTarget;
  const button = formElement.querySelector("button[type=submit]");
  setBusy(button, true, "Deleting…");
  try {
    const { data: deletedRings, error } = await state.client
      .from("rings")
      .delete()
      .eq("id", ring.id)
      .eq("created_by", state.user.id)
      .select("id");
    if (error) throw error;
    if (!deletedRings?.length) {
      throw new Error("This Ring may already be deleted, or you may not have permission to delete it.");
    }
    if (state.incoming?.ring_id === ring.id) {
      state.incoming = null;
      state.incomingResponses = [];
      closeDialog("incoming-dialog");
    }
    if (state.outgoing?.ring_id === ring.id) {
      state.outgoing = null;
      state.responses = [];
    }
    state.selectedRingId = null;
    closeDialog("delete-dialog");
    await loadWorkspace();
    notify("Ring deleted.");
  } catch (error) {
    notify(error.message || "Unable to delete this Ring.");
  } finally {
    setBusy(button, false);
  }
});

async function startRing(ringId) {
  if (state.outgoing) {
    notify("You already have a Ring in progress.");
    return;
  }
  const ring = state.rings.find((item) => item.id === ringId);
  if (!ring) return;
  const { data, error } = await state.client.from("ring_events").insert({
    ring_id: ring.id, sender_id: state.user.id, topic: ring.default_topic, status: "active",
  }).select("id, ring_id, sender_id, topic, status, created_at").single();
  if (error) {
    notify(error.message);
    return;
  }
  state.outgoing = data;
  state.responses = [];
  renderRings();
  const { data: notificationResult, error: notificationError } = await state.client.functions.invoke("send-ring-notification", {
    body: { eventId: data.id },
  });
  if (notificationError) {
    notify(`Ring started, but notifications failed: ${await getPushErrorMessage(notificationError)}`);
  } else if (notificationResult?.sent > 0) {
    notify(`Ring started. Notification sent to ${notificationResult.sent} device${notificationResult.sent === 1 ? "" : "s"}.`);
  } else if (notificationResult?.members === 0) {
    notify("Ring started, but no one else is in this Ring yet.");
  } else {
    notify("Ring started, but no members have enabled notifications on their devices yet.");
  }
}

async function getPushErrorMessage(error) {
  if (error.context instanceof Response) {
    try {
      const result = await error.context.clone().json();
      if (typeof result.error === "string") return result.error;
    } catch {
      return `${error.message} (HTTP ${error.context.status})`;
    }
  }
  return error.message || "Check the deployed Supabase notification function and VAPID secrets.";
}

async function endRing(eventId) {
  const { data, error } = await state.client.from("ring_events").update({ status: "ended" })
    .eq("id", eventId).eq("sender_id", state.user.id).select("id");
  if (error) {
    notify(error.message);
    return;
  }
  if (!data?.length) {
    notify("Only the person who started this Ring can stop it.");
    return;
  }
  eventEnded({ id: eventId });
  notify("Ring stopped.");
}

$("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const button = formElement.querySelector("button[type=submit]");
  setBusy(button, true, "Creating…");
  try {
    const { data: ring, error: ringError } = await state.client.from("rings").insert({
      name: String(form.get("name")).trim(), default_topic: String(form.get("topic")).trim(), created_by: state.user.id,
    }).select("id, name, default_topic, created_by, created_at").single();
    if (ringError) throw ringError;
    const { error: memberError } = await state.client.from("ring_members").insert({ ring_id: ring.id, user_id: state.user.id });
    if (memberError) throw memberError;
    closeDialog("create-dialog");
    formElement.reset();
    $("#ring-search-input").value = "";
    state.selectedRingId = ring.id;
    await loadWorkspace();
    notify("Your Ring is ready.");
  } catch (error) {
    notify(error.message);
  } finally {
    setBusy(button, false);
  }
});

$("#invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const button = formElement.querySelector("button[type=submit]");
  setBusy(button, true, "Adding…");
  try {
    const { error } = await state.client.rpc("add_ring_member", {
      p_ring_id: formElement.dataset.ringId,
      p_identifier: String(form.get("identifier")).trim(),
    });
    if (error) throw error;
    closeDialog("invite-dialog");
    formElement.reset();
    await loadWorkspace();
    notify("Member added to your Ring.");
  } catch (error) {
    notify(error.message || "We couldn't find that Ring ID or Ring No.");
  } finally {
    setBusy(button, false);
  }
});

async function respondToIncoming(response) {
  if (!state.incoming) return;
  const eventId = state.incoming.id;
  const { error } = await state.client.from("ring_responses").upsert({
    event_id: eventId, user_id: state.user.id, response,
  }, { onConflict: "event_id,user_id" });
  if (error) {
    notify(error.message);
    return;
  }
  closeDialog("incoming-dialog");
  state.incoming = null;
  state.incomingResponses = [];
  stopRingtone();
  notify(`You answered ${response === "yes" ? "Yes" : "No"}.`);
}

function decodeApplicationServerKey(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function refreshNotificationSettings() {
  const status = $("#notification-status");
  const button = $("#toggle-notifications");
  if (!("Notification" in window) || !("PushManager" in window) || !state.serviceWorkerRegistration) {
    status.textContent = "This browser doesn't support Ring notifications. Install Ring and try a supported browser.";
    button.disabled = true;
    return;
  }
  if (!VAPID_PUBLIC_KEY) {
    state.notificationsEnabled = false;
    status.textContent = "Push notifications aren't configured for this app yet. The app owner must add the VAPID public key and deploy the Supabase sender.";
    button.disabled = true;
    button.textContent = "Not set up";
    return;
  }
  const subscription = await state.serviceWorkerRegistration.pushManager.getSubscription();
  if (subscription && Notification.permission === "granted") {
    const { data, error } = await state.client.from("ring_push_subscriptions").select("endpoint")
      .eq("endpoint", subscription.endpoint).maybeSingle();
    if (error) throw error;
    state.notificationsEnabled = Boolean(data);
  } else {
    state.notificationsEnabled = false;
  }
  button.disabled = false;
  button.textContent = state.notificationsEnabled ? "Turn off" : "Enable";
  status.textContent = state.notificationsEnabled
    ? "Notifications are on for incoming Rings on this device."
    : Notification.permission === "denied"
      ? "Notifications are blocked. Allow them in your browser or device settings first."
      : "Get alerted when someone Rings you, even when Ring is closed.";
}

async function toggleNotifications() {
  const button = $("#toggle-notifications");
  button.disabled = true;
  button.textContent = state.notificationsEnabled ? "Turning off…" : "Enabling…";
  try {
    const registration = state.serviceWorkerRegistration;
    if (!registration) throw new Error("Ring's background service is not ready yet. Refresh and try again.");
    let subscription = await registration.pushManager.getSubscription();
    if (state.notificationsEnabled && subscription) {
      const { error } = await state.client.from("ring_push_subscriptions").delete()
        .eq("endpoint", subscription.endpoint);
      if (error) throw error;
      const unsubscribed = await subscription.unsubscribe();
      state.notificationsEnabled = false;
      notify(unsubscribed
        ? "Ring notifications turned off for this device."
        : "Ring notifications were removed from your account, but the browser couldn't clear this device's subscription.");
    } else {
      if (!VAPID_PUBLIC_KEY) {
        throw new Error("Background notifications aren't configured yet. Add the VAPID public key to supabase-config.js.");
      }
      if (/iPhone|iPad|iPod/i.test(navigator.userAgent) && !isAppInstalled()) {
        throw new Error("On iPhone or iPad, install Ring to your Home Screen before enabling notifications.");
      }
      let permission = Notification.permission;
      if (permission === "default") permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Allow notifications in your browser settings to receive incoming Rings.");
      subscription ||= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationServerKey(VAPID_PUBLIC_KEY),
      });
      const { error } = await state.client.from("ring_push_subscriptions").upsert({
        user_id: state.user.id,
        endpoint: subscription.endpoint,
        subscription: subscription.toJSON(),
      }, { onConflict: "endpoint" });
      if (error) throw error;
      state.notificationsEnabled = true;
      notify("Ring notifications enabled on this device.");
    }
    await refreshNotificationSettings();
  } catch (error) {
    notify(error.message || "Unable to update Ring notifications.");
  } finally {
    button.disabled = !("Notification" in window) || !("PushManager" in window) || !state.serviceWorkerRegistration;
    button.textContent = state.notificationsEnabled ? "Turn off" : "Enable";
  }
}

$("#incoming-dialog").addEventListener("click", (event) => {
  const response = event.target.closest("[data-response]")?.dataset.response;
  if (response) respondToIncoming(response);
});
$("#dismiss-incoming").addEventListener("click", () => closeDialog("incoming-dialog"));
$("#incoming-dialog").addEventListener("close", stopRingtone);

document.querySelectorAll("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));
$("#open-create-ring").addEventListener("click", () => openDialog("create-dialog"));
$("#empty-create-ring").addEventListener("click", () => openDialog("create-dialog"));
$("#open-profile-top").addEventListener("click", () => {
  openDialog("profile-dialog");
  refreshNotificationSettings().catch((error) => notify(error.message));
});
$("#open-profile").addEventListener("click", () => {
  openDialog("profile-dialog");
  refreshNotificationSettings().catch((error) => notify(error.message));
});
$("#toggle-notifications").addEventListener("click", toggleNotifications);
document.querySelectorAll("[data-mobile-nav]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-mobile-nav]").forEach((item) => {
    const active = item === button && button.dataset.mobileNav === "rings";
    item.classList.toggle("is-current", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  if (button.dataset.mobileNav === "create") {
    openDialog("create-dialog");
  } else if (button.dataset.mobileNav === "profile") {
    openDialog("profile-dialog");
    refreshNotificationSettings().catch((error) => notify(error.message));
  } else {
    $(".workspace-content").scrollIntoView({ behavior: "smooth", block: "start" });
    $("#ring-search-input").focus({ preventScroll: true });
  }
}));
$("#sign-out").addEventListener("click", async () => {
  try {
    const subscription = await state.serviceWorkerRegistration?.pushManager.getSubscription();
    if (subscription) {
      const { error } = await state.client.from("ring_push_subscriptions").delete()
        .eq("endpoint", subscription.endpoint);
      if (error) {
        notify(`This device may still receive Ring notifications: ${error.message}`);
      } else if (!(await subscription.unsubscribe())) {
        notify("Ring notifications were removed from your account, but the browser couldn't clear this device's subscription.");
      }
    }
  } catch (error) {
    notify(`Unable to remove this device's Ring notifications: ${error.message}`);
  }
  const { error } = await state.client.auth.signOut();
  if (error) notify(error.message);
  else closeDialog("profile-dialog");
});
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeDialog(button.dataset.close)));
document.querySelectorAll("[data-install-app]").forEach((button) => button.addEventListener("click", async () => {
  if (!state.installPrompt) {
    showInstallInstructions();
    return;
  }
  const prompt = state.installPrompt;
  state.installPrompt = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome === "accepted") setInstallButtonsVisible(false);
  else showInstallInstructions();
}));

function setInstallButtonsVisible(visible) {
  document.querySelectorAll(".install-button").forEach((button) => { button.hidden = !visible; });
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPrompt = event;
  setInstallButtonsVisible(true);
});
window.addEventListener("appinstalled", () => setInstallButtonsVisible(false));

function isAppInstalled() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function showInstallInstructions() {
  const instructions = $("#install-instructions");
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    instructions.textContent = "In Safari, tap the Share button, scroll down, then choose “Add to Home Screen.” Open Ring from your Home Screen to use it like an app.";
  } else if (/Android/i.test(navigator.userAgent)) {
    instructions.textContent = "In Chrome, tap the ⋮ menu, then choose “Install app” or “Add to Home screen.” If you don't see it, open this page in Chrome over HTTPS.";
  } else {
    instructions.textContent = "Use your browser's install icon in the address bar or open its menu and choose “Install Ring.” Install is available on localhost or a secure HTTPS site.";
  }
  openDialog("install-dialog");
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    setInstallButtonsVisible(!isAppInstalled());
    return;
  }
  navigator.serviceWorker.register("./sw.js")
    .then(async (registration) => {
      state.serviceWorkerRegistration = await navigator.serviceWorker.ready;
      setInstallButtonsVisible(!isAppInstalled());
      if ($("#profile-dialog").open) refreshNotificationSettings().catch((error) => notify(error.message));
      return registration;
    })
    .catch((error) => {
      notify(`Unable to start Ring's background service: ${error.message}`);
      setInstallButtonsVisible(!isAppInstalled());
    });
}
if (document.readyState === "complete") registerServiceWorker();
else window.addEventListener("load", registerServiceWorker, { once: true });

document.addEventListener("pointerdown", primeRingtoneAudio, { once: true });
document.addEventListener("keydown", primeRingtoneAudio, { once: true });

start().catch((error) => {
  notify(`Unable to connect to Supabase: ${error.message}`);
  $("#auth-view").hidden = false;
  $("#app-view").hidden = true;
});