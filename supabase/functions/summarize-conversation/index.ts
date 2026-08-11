// supabase/functions/summarize-conversation/index.ts
//
// Called from daily-activity.html's "Get AI summary" button, for patients
// who chatted with the WhatsApp AI but didn't trigger a booking/cancel/
// waitlist/escalate tool call. Returns a one-sentence summary of what the
// patient was asking about.
//
// Expects POST body: { org_id: string, patient_phone: string }
// Returns: { summary: string }
//
// ASSUMPTIONS — please confirm/adjust before deploying:
//   1. Secrets already set in this project (same ones your webhook and
//      reminders functions use): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      ANTHROPIC_API_KEY. If your webhook function uses a different secret
//      name for the Claude key, rename ANTHROPIC_API_KEY below to match.
//   2. Model name — I used 'claude-3-5-haiku-20241022' since this is a
//      cheap, low-latency summarization task, not the same model your
//      WhatsApp receptionist necessarily runs on. Swap it if you'd rather
//      keep everything on one model for billing/consistency.
//   3. whatsapp_conversations has columns patient_name, messages (jsonb
//      array of {role, content}) — matches what front-desk.html already
//      reads.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: { org_id?: string; patient_phone?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { org_id, patient_phone } = body;
  if (!org_id || !patient_phone) {
    return jsonResponse({ error: "org_id and patient_phone are required" }, 400);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  }
  const jwt = authHeader.replace("Bearer ", "");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");

  if (!supabaseUrl || !serviceRoleKey || !anthropicKey) {
    return jsonResponse({ error: "Server misconfigured: missing required secrets" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // ---------------------------------------------------------------------
  // 1. Verify the caller's identity from their JWT.
  // ---------------------------------------------------------------------
  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return jsonResponse({ error: "Invalid or expired session" }, 401);
  }

  // ---------------------------------------------------------------------
  // 2. Confirm they're an active admin/receptionist for this exact org.
  //    (Doctors are intentionally excluded — matches daily-activity.html's
  //    own access gate.)
  // ---------------------------------------------------------------------
  const { data: staffRows, error: staffErr } = await supabase
    .from("staff")
    .select("id, role, org_id, is_active")
    .eq("user_id", userData.user.id)
    .limit(1);

  if (staffErr) {
    return jsonResponse({ error: "Could not verify staff record: " + staffErr.message }, 500);
  }
  const staff = staffRows?.[0];
  if (!staff || !staff.is_active) {
    return jsonResponse({ error: "No active staff record found" }, 403);
  }
  if (staff.org_id !== org_id) {
    return jsonResponse({ error: "Not authorized for this organization" }, 403);
  }
  if (staff.role !== "admin" && staff.role !== "receptionist") {
    return jsonResponse({ error: "This role cannot request AI summaries" }, 403);
  }

  // ---------------------------------------------------------------------
  // 3. Fetch the conversation.
  // ---------------------------------------------------------------------
  const { data: convoRows, error: convoErr } = await supabase
    .from("whatsapp_conversations")
    .select("patient_name, messages")
    .eq("org_id", org_id)
    .eq("patient_phone", patient_phone)
    .limit(1);

  if (convoErr) {
    return jsonResponse({ error: "Could not fetch conversation: " + convoErr.message }, 500);
  }
  const convo = convoRows?.[0];
  if (!convo) {
    return jsonResponse({ error: "Conversation not found" }, 404);
  }

  const messages: { role: string; content: string }[] = convo.messages || [];
  if (!messages.length) {
    return jsonResponse({ summary: "No messages in this conversation." });
  }

  // ---------------------------------------------------------------------
  // 4. Ask Claude for a one-sentence summary.
  // ---------------------------------------------------------------------
  const transcript = messages
    .map((m) => `${m.role === "user" ? "Patient" : "AI"}: ${m.content}`)
    .join("\n");

  let summaryText: string;
  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 120,
        system:
          "You summarize WhatsApp conversations between a clinic's AI receptionist and a patient, for clinic staff reviewing that day's activity. Write exactly ONE short sentence (under 30 words) describing what the patient was asking about or trying to do. Be factual and neutral, no filler. If the AI failed to resolve the patient's request, say so plainly.",
        messages: [
          {
            role: "user",
            content:
              `Patient name: ${convo.patient_name || "Unknown"}\n\nTranscript:\n${transcript}\n\nSummarize in one short sentence.`,
          },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      return jsonResponse({ error: "AI summary request failed", detail: errBody }, 502);
    }

    const claudeData = await claudeRes.json();
    const textBlock = (claudeData.content || []).find(
      (b: { type: string }) => b.type === "text",
    );
    summaryText = textBlock?.text?.trim() || "Could not generate a summary.";
  } catch (e) {
    return jsonResponse({ error: "AI summary request failed: " + (e as Error).message }, 502);
  }

  return jsonResponse({ summary: summaryText });
});