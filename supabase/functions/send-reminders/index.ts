// supabase/functions/send-reminders/index.ts
//
// ClinicBook Pro — Appointment Reminders (v1.3 — Zernio migration, template send)
// Triggered every 15 minutes by pg_cron (see migration_reminders.sql).
// Sends a reminder template message 24h and 1h before each confirmed
// appointment, using appointments.reminder_24h_sent / reminder_1h_sent to
// guarantee each reminder fires exactly once.
//
// TEMPLATE SEND (confirmed against Zernio's docs): reminders go out via
// Zernio's `template` field on the send-message endpoint —
//   { accountId, template: { elements: [{ name, language, components }] } }
// — which is required to reach a patient outside their 24h session window
// (true for essentially every 24h/1h-ahead reminder). This uses the SAME
// approved Meta template — `appointment_reminder` — that was already
// submitted and approved when the bot sent directly via Meta's Cloud API;
// switching transport to Zernio does not require re-approval, since it's
// the same underlying WABA.
//
// ONE THING STILL WORTH CONFIRMING: Zernio's template CRUD (createWhatsAppTemplate,
// listWhatsAppTemplates) is how templates are normally registered when
// created *through* Zernio. Since `appointment_reminder` was originally
// submitted directly via Meta, not through Zernio's dashboard/API, it's
// worth a quick check — via the Zernio dashboard or `zernio.whatsapp.listWhatsAppTemplates`
// — that Zernio can see and reference it by name. If it can't, either
// re-create the template entry in Zernio's system (same name/language, so
// Meta doesn't require a fresh approval) or Zernio support can confirm how
// pre-existing WABA templates get picked up.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ZERNIO_API_KEY = Deno.env.get("ZERNIO_API_KEY")!;

const TEMPLATE_NAME = "appointment_reminder"; // must exactly match your approved template
const TEMPLATE_LANGUAGE = "en";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function getTodayStr() {
  return new Date().toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Look up the Zernio conversationId + accountId for a given patient/org.
// This is a cron job, not a reply to an inbound webhook, so there's no
// conversation context handed to us — we have to look it up by org + phone,
// same as getConversationRef() in whatsapp-webhook. If the patient has never
// messaged in since the Zernio migration, there's nothing to send to.
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
// Send the reminder via Zernio's approved-template mechanism. Body params
// are positional (1: patient name, 2: doctor name, 3: date, 4: time),
// matching the order the appointment_reminder template was approved with.
// If Zernio can't resolve the template by name (see note at top of file
// re: templates registered directly via Meta vs through Zernio), this call
// will fail loudly with an error from Zernio rather than silently — that
// error will show up in the `results` array this function returns, and in
// the function logs.
// ---------------------------------------------------------------------------
async function sendReminderMessage(
  conversationId: string,
  accountId: string,
  patientName: string,
  doctorName: string,
  dateStr: string,
  timeStr: string
) {
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
                  { type: "text", text: patientName },
                  { type: "text", text: doctorName },
                  { type: "text", text: dateStr },
                  { type: "text", text: timeStr },
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
    throw new Error(`Zernio template send failed: ${res.status} ${errText}`);
  }
  return res.json().catch(() => ({}));
}

// ---------------------------------------------------------------------------
// Fetch confirmed appointments needing a reminder in a given window
// (unchanged from v1 — two-step lookup pattern to avoid the FK-ambiguity
// issue already hit and fixed elsewhere in this project)
// ---------------------------------------------------------------------------
async function getAppointmentsDueForReminder(
  reminderField: "reminder_24h_sent" | "reminder_1h_sent",
  windowStartMinutes: number,
  windowEndMinutes: number
) {
  const { data: appts, error: apptError } = await supabase
    .from("appointments")
    .select("id, org_id, schedule_id, patient_name, patient_phone")
    .eq("status", "confirmed")
    .eq(reminderField, false);

  if (apptError) {
    console.error(`Error fetching appointments for ${reminderField}:`, apptError.message);
    return [];
  }
  if (!appts || appts.length === 0) return [];

  const scheduleIds = [...new Set(appts.map((a) => a.schedule_id))];
  const { data: schedules, error: schedError } = await supabase
    .from("schedules")
    .select("id, staff_id, slot_date, start_time")
    .in("id", scheduleIds)
    .gte("slot_date", getTodayStr());

  if (schedError) {
    console.error("Error fetching schedules:", schedError.message);
    return [];
  }

  const scheduleMap = new Map((schedules || []).map((s) => [s.id, s]));
  const staffIds = [...new Set((schedules || []).map((s) => s.staff_id))];

  const { data: staffRows } = staffIds.length
    ? await supabase.from("staff").select("id, full_name").in("id", staffIds)
    : { data: [] as any[] };
  const staffMap = new Map((staffRows || []).map((s) => [s.id, s.full_name]));

  const now = new Date();
  const due: {
    appointment_id: string;
    org_id: string;
    patient_name: string;
    patient_phone: string;
    doctor_name: string;
    slot_date: string;
    start_time: string;
  }[] = [];

  for (const a of appts) {
    const sched = scheduleMap.get(a.schedule_id);
    if (!sched) continue; // schedule missing or in the past

    // slot_date is a DATE (YYYY-MM-DD), start_time is a TIME (HH:MM:SS).
    // Combined here as clinic-local wall-clock time. If reminders arrive
    // shifted by a fixed number of hours, this is where to add a timezone
    // offset — there's no timezone column in schedules today.
    const appointmentDateTime = new Date(`${sched.slot_date}T${sched.start_time}`);
    const minutesUntil = (appointmentDateTime.getTime() - now.getTime()) / 60000;

    if (minutesUntil >= windowStartMinutes && minutesUntil < windowEndMinutes) {
      due.push({
        appointment_id: a.id,
        org_id: a.org_id,
        patient_name: a.patient_name,
        patient_phone: a.patient_phone,
        doctor_name: staffMap.get(sched.staff_id) || "your doctor",
        slot_date: sched.slot_date,
        start_time: sched.start_time,
      });
    }
  }

  return due;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async () => {
  const results: any[] = [];

  const windows: {
    field: "reminder_24h_sent" | "reminder_1h_sent";
    from: number;
    to: number;
  }[] = [
    { field: "reminder_24h_sent", from: 24 * 60, to: 24 * 60 + 15 }, // 24h00m–24h15m out
    { field: "reminder_1h_sent", from: 60, to: 75 }, // 1h00m–1h15m out
  ];

  for (const w of windows) {
    const due = await getAppointmentsDueForReminder(w.field, w.from, w.to);

    for (const appt of due) {
      const dateStr = new Date(appt.slot_date).toLocaleDateString("en-GB");
      const timeStr = appt.start_time.slice(0, 5); // HH:MM

      try {
        const ref = await getConversationRef(appt.org_id, appt.patient_phone);
        if (!ref) {
          // No known Zernio conversation for this patient — most likely
          // they haven't messaged in since the Zernio migration, so we
          // have no conversationId to send to. Not marking reminder_sent
          // here so this doesn't look like a silent success.
          console.error(
            `No Zernio conversation found for reminder, skipping: ${appt.appointment_id} (${appt.patient_phone})`
          );
          results.push({
            appointment_id: appt.appointment_id,
            window: w.field,
            status: "failed",
            error: "no_zernio_conversation",
          });
          continue;
        }

        await sendReminderMessage(
          ref.conversationId,
          ref.accountId,
          appt.patient_name,
          appt.doctor_name,
          dateStr,
          timeStr
        );

        await supabase
          .from("appointments")
          .update({ [w.field]: true })
          .eq("id", appt.appointment_id);

        results.push({ appointment_id: appt.appointment_id, window: w.field, status: "sent" });
      } catch (err) {
        console.error(`Failed to send ${w.field} reminder for ${appt.appointment_id}:`, err);
        results.push({
          appointment_id: appt.appointment_id,
          window: w.field,
          status: "failed",
          error: String(err),
        });
      }
    }
  }

  return new Response(JSON.stringify(results), {
    headers: { "Content-Type": "application/json" },
  });
});
