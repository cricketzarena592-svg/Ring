import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const authorization = request.headers.get("Authorization");
  if (!authorization) return jsonResponse({ error: "Authentication is required." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Supabase function credentials are not configured." }, 500);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return jsonResponse({ error: "Authentication failed." }, 401);

  let payload: { eventId?: unknown; test?: unknown; endpoint?: unknown };
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "A valid JSON request body is required." }, 400);
  }
  const isTest = payload?.test === true;
  const requestedEventId = typeof payload?.eventId === "string" ? payload.eventId : null;
  const requestedEndpoint = typeof payload?.endpoint === "string" ? payload.endpoint : null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || (isTest ? !requestedEndpoint : !requestedEventId)) {
    return jsonResponse({ error: "A Ring event ID or a test notification request is required." }, 400);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let eventId: string | undefined;
  let ringName: string;
  let memberCount: number;
  let subscriptions;
  if (isTest) {
    const { data, error } = await adminClient
      .from("ring_push_subscriptions")
      .select("endpoint, subscription")
      .eq("user_id", user.id)
      .eq("endpoint", requestedEndpoint);
    if (error) return jsonResponse({ error: "Unable to load this device's notification subscription." }, 500);
    subscriptions = data || [];
    ringName = "notification test";
    memberCount = 1;
  } else {
    const { data: event, error: eventError } = await userClient
      .from("ring_events")
      .select("id, ring_id, sender_id, topic, status")
      .eq("id", requestedEventId)
      .eq("sender_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (eventError) return jsonResponse({ error: "Unable to verify this Ring event." }, 500);
    if (!event) return jsonResponse({ error: "This active Ring event was not found." }, 404);
    eventId = event.id;

    const { data: members, error: membersError } = await adminClient
      .from("ring_members")
      .select("user_id")
      .eq("ring_id", event.ring_id)
      .neq("user_id", user.id);
    if (membersError) return jsonResponse({ error: "Unable to find Ring members." }, 500);
    const memberIds = (members || []).map((member) => member.user_id);
    if (!memberIds.length) return jsonResponse({ sent: 0, members: 0, devices: 0 });

    const { data: ring, error: ringError } = await adminClient
      .from("rings")
      .select("name")
      .eq("id", event.ring_id)
      .single();
    if (ringError) return jsonResponse({ error: "Unable to find the Ring." }, 500);
    ringName = ring.name;
    memberCount = memberIds.length;

    const { data, error: subscriptionsError } = await adminClient
      .from("ring_push_subscriptions")
      .select("endpoint, subscription")
      .in("user_id", memberIds);
    if (subscriptionsError) return jsonResponse({ error: "Unable to load Ring notification subscriptions." }, 500);
    subscriptions = data || [];
    if (!subscriptions.length) return jsonResponse({ sent: 0, members: memberIds.length, devices: 0 });
  }

  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT");
  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    return jsonResponse({ error: "Web Push VAPID credentials are not configured." }, 500);
  }

  try {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  } catch {
    return jsonResponse({ error: "Web Push VAPID credentials are invalid." }, 500);
  }
  const message = JSON.stringify({
    ...(isTest ? { type: "test" } : { eventId }),
    ringName,
    topic: "Someone is checking in with your Ring.",
  });
  const results = await Promise.allSettled(subscriptions.map(async (subscription) => {
    const endpoint = new URL(subscription.endpoint);
    const validPushService = endpoint.protocol === "https:" && (
      endpoint.hostname === "fcm.googleapis.com"
      || endpoint.hostname === "updates.push.services.mozilla.com"
      || endpoint.hostname === "push.services.mozilla.com"
      || endpoint.hostname === "web.push.apple.com"
      || endpoint.hostname.endsWith(".notify.windows.com")
    );
    if (!validPushService || subscription.subscription?.endpoint !== subscription.endpoint) {
      throw new Error("The stored push subscription endpoint is invalid.");
    }
    try {
      await webpush.sendNotification(subscription.subscription, message);
      return null;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) return subscription.endpoint;
      throw error;
    }
  }));
  const staleEndpoints = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  if (staleEndpoints.length) {
    const { error } = await adminClient.from("ring_push_subscriptions").delete().in("endpoint", staleEndpoints);
    if (error) return jsonResponse({ error: "Unable to remove expired notification subscriptions." }, 500);
  }

  const sent = results.filter((result) => result.status === "fulfilled" && !result.value).length;
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) {
    const statuses = failures.map(({ reason }) => Number.isInteger(reason?.statusCode) ? reason.statusCode : "unknown");
    console.error("Ring push delivery failures", { statuses, sent });
    return jsonResponse({
      error: `Push delivery failed for ${failures.length} device${failures.length === 1 ? "" : "s"} (provider status: ${statuses.join(", ")}).`,
      sent,
      members: memberCount,
      devices: subscriptions.length,
    }, 502);
  }
  return jsonResponse({ sent, members: memberCount, devices: subscriptions.length });
});
