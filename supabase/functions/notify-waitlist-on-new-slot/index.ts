// supabase/functions/notify-waitlist-on-new-slot/index.ts
//
// Called by doctor-dashboard.html right after a doctor adds a new time slot.
// Checks the waitlist for a matching patient and, if found, offers them the
// slot via an approved WhatsApp template (not free-form text, since this
// message often goes out well outside the patient's 24h session window).
//
// v1.1: dates sent to patients are now formatted as "July 22, 2026" instead
// of raw "2026-07-22", to match the approved template's sample content.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
const META_PHONE_NUMBER_ID = Deno.env.get("META_PHONE_NUMBER_ID")!;

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

async function sendWaitlistTemplate(to: string, doctorName: string, slotDate: string) {
  await fetch(`https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: "waitlist_slot_available", // must match your approved template name exactly
        language: { code: "en_US" },
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
    }),
  });
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

    await supabase
      .from("waitlist")
      .update({
        status: "offered",
        offered_schedule_id: schedule.id,
        offered_at: new Date().toISOString(),
      })
      .eq("id", candidate.id);

    await sendWaitlistTemplate(candidate.patient_phone, doctorName, schedule.slot_date);

    return new Response(
      JSON.stringify({ offered: true, candidate: candidate.patient_name }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
