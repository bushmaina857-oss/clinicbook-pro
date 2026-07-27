// supabase/functions/notify-waitlist-on-new-slot/index.ts
//
// Called by doctor-dashboard.html right after a doctor adds a new time slot.
// Checks the waitlist for a matching patient and, if found, offers them the
// slot via an approved WhatsApp template — needed because this send almost
// always happens outside the patient's 24h session window (that's the
// whole point: they weren't actively messaging when the slot opened up).
//
// v2.1 — Zernio migration, template send confirmed. Sends now go through
// Zernio's `template` field on the send-message endpoint —
//   { accountId, template: { elements: [{ name, language, components }] } }
// — using the same approved Meta template (`waitlist_slot_available`) that
// was already submitted and approved for direct-Meta sending. Switching
// transport to Zernio does not require re-approval, since it's the same
// underlying WABA.
//
// WORTH CONFIRMING ONCE: `waitlist_slot_available` was originally
// registered directly through Meta, not via Zernio's template CRUD
// (createWhatsAppTemplate). Check the Zernio dashboard or
// `zernio.whatsapp.listWhatsAppTemplates` to confirm Zernio can see and
// reference it by name — if not, re-create the same name/language entry
// through Zernio (Meta won't require a fresh approval for an identical
// template) or check with Zernio support on how pre-existing WABA
// templates get picked up.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ZERNIO_API_KEY = Deno.env.get("ZERNIO_API_KEY")!;

const TEMPLATE_NAME = "waitlist_slot_available"; // must exactly match your approved template
const TEMPLATE_LANGUAGE = "en_US";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Formats a YYYY-MM-DD string into a human-readable date for patient-facing
// messages, e.g. "2026-07-22" -> "July 22, 2026".
function formatDateForPatient(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Look up the Zernio conversationId + accountId for a given patient/org.
// Same pattern as getConversationRef() in whatsapp-webhook and send-reminders.
// ---------------------------------------------------------------------------
async function getConversationRef(orgId: string, phone: string): Promise<{ conversationId: string; accountId: string } | null> {
  const { data: org } = await supabase
    .from("organizations")
    .select("zernio_account_id")
    .eq("id", orgId)
    .single();

  const { data: convo } = await supabase
    .from("whatsapp_conversations")
    .select("zernio_conversation_id")
    .eq("patient_phone", phone)
    .eq("org_id", orgId)
    .single();

  if (!org?.zernio_account_id || !convo?.zernio_conversation_id) return null;

  return { conversationId: convo.zernio_conversation_id, accountId: org.zernio_account_id };
}

// ---------------------------------------------------------------------------
// Send the waitlist offer via Zernio's approved-template mechanism. Body
// params are positional (1: doctor name, 2: formatted date), matching the
// order waitlist_slot_available was approved with. The template's approved
// copy should already prompt the patient to reply YES to claim the slot —
// that's what the CANCEL/YES short-circuit in whatsapp-webhook listens for.
// ---------------------------------------------------------------------------
async function sendWaitlistOffer(conversationId: string, accountId: string, doctorName: string, slotDate: string) {
  const res = await fetch(`https://zernio.com/api/v1/inbox/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ZERNIO_API_KEY}`,
    },
    body: JSON.stringify({
      accountId,
      template: {
        elements: [
          {
            name: TEMPLATE_NAME,
            language: TEMPLATE_LANGUAGE,
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: doctorName },
                  { type: "text", text: formatDateForPatient(slotDate) },
                ],
              },
            ],
          },
        ],
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Zernio template send failed:", res.status, errText);
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  try {
    const { schedule_id } = await req.json();
    if (!schedule_id) {
      return new Response(JSON.stringify({ error: "schedule_id required" }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    const { data: schedule, error: schedError } = await supabase
      .from("schedules")
      .select("id, staff_id, slot_date, staff:staff_id(org_id, full_name)")
      .eq("id", schedule_id)
      .single();

    if (schedError || !schedule) {
      return new Response(JSON.stringify({ error: "Schedule not found" }), {
        status: 404,
        headers: CORS_HEADERS,
      });
    }

    const staffInfo = (schedule as any).staff;
    const orgId = staffInfo?.org_id;
    const doctorName = staffInfo?.full_name || "your doctor";

    if (!orgId) {
      return new Response(JSON.stringify({ error: "Could not resolve org for this schedule" }), {
        status: 500,
        headers: CORS_HEADERS,
      });
    }

    const { data: candidates } = await supabase
      .from("waitlist")
      .select("id, patient_name, patient_phone, preferred_date")
      .eq("org_id", orgId)
      .eq("staff_id", schedule.staff_id)
      .eq("status", "waiting")
      .or(`preferred_date.is.null,preferred_date.eq.${schedule.slot_date}`)
      .order("created_at", { ascending: true })
      .limit(1);

    if (!candidates || candidates.length === 0) {
      return new Response(JSON.stringify({ offered: false }), { status: 200, headers: CORS_HEADERS });
    }

    const candidate = candidates[0];

    const ref = await getConversationRef(orgId, candidate.patient_phone);
    if (!ref) {
      // No known Zernio conversation for this patient — most likely they
      // haven't messaged in since the Zernio migration, so there's no
      // conversationId to send to. We still mark them as offered=false
      // (not "offered" in the DB) so the next matching patient can be
      // tried instead, rather than silently losing this offer.
      console.error(`No Zernio conversation found for waitlist candidate: ${candidate.patient_phone} (org ${orgId})`);
      return new Response(
        JSON.stringify({ offered: false, error: "no_zernio_conversation", candidate: candidate.patient_name }),
        { status: 200, headers: CORS_HEADERS }
      );
    }

    const sent = await sendWaitlistOffer(ref.conversationId, ref.accountId, doctorName, schedule.slot_date);
    if (!sent) {
      return new Response(
        JSON.stringify({ offered: false, error: "zernio_send_failed", candidate: candidate.patient_name }),
        { status: 200, headers: CORS_HEADERS }
      );
    }

    await supabase
      .from("waitlist")
      .update({
        status: "offered",
        offered_schedule_id: schedule.id,
        offered_at: new Date().toISOString(),
      })
      .eq("id", candidate.id);

    return new Response(
      JSON.stringify({ offered: true, candidate: candidate.patient_name }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
