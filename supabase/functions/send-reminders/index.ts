// supabase/functions/send-reminders/index.ts
//
// ClinicBook Pro — Appointment Reminders (v1.5)
// Base: v1.4 — unchanged except for the WhatsApp template call.
// New in v1.5: switched the template message from POSITIONAL body
// parameters (type: "text", matched by order) to NAMED parameters
// (type: "text", parameter_name: "..."), matching how the approved
// appointment_reminder template was actually built in Meta's template
// editor. Positional parameters silently mismatch (and Meta rejects the
// send) when a template was created with named variables — this is what
// caused the earlier silent-rejection issue.
//
// Confirmed approved template variable names, in order:
//   {{patient_name}}, {{doctor_name}}, {{appointment_date}}, {{appointment_time}}
//
// Triggered every 15 minutes by pg_cron (see migration_reminders.sql).
// Sends a WhatsApp template message 24h and 1h before each confirmed
// appointment, using appointments.reminder_24h_sent / reminder_1h_sent
// to guarantee each reminder fires exactly once.
//
// NOTE: This requires an approved Meta message template (utility category).
// Business-initiated messages outside the 24h session window are rejected
// by Meta without one. Update TEMPLATE_NAME below to match the exact
// approved template name.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
const META_PHONE_NUMBER_ID = Deno.env.get("META_PHONE_NUMBER_ID")!;

const TEMPLATE_NAME = "appointment_reminder"; // must exactly match your approved template
const TEMPLATE_LANGUAGE = "en";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function getTodayStr() {
  // en-CA locale formats as YYYY-MM-DD; timeZone pins it to Kenya time
  // regardless of the server's own timezone (Supabase runs on UTC).
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
}

// ---------------------------------------------------------------------------
// Send the approved WhatsApp template
// ---------------------------------------------------------------------------
async function sendReminderTemplate(
  to: string,
  patientName: string,
  doctorName: string,
  dateStr: string,
  timeStr: string
) {
  const res = await fetch(
    `https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`,
    {
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
          name: TEMPLATE_NAME,
          language: { code: TEMPLATE_LANGUAGE },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", parameter_name: "patient_name", text: patientName },
                { type: "text", parameter_name: "doctor_name", text: doctorName },
                { type: "text", parameter_name: "appointment_date", text: dateStr },
                { type: "text", parameter_name: "appointment_time", text: timeStr },
              ],
            },
          ],
        },
      }),
    }
  );

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

// ---------------------------------------------------------------------------
// Fetch confirmed appointments needing a reminder in a given window
// ---------------------------------------------------------------------------
// Same two-step lookup pattern used in the webhook (appointments -> schedules
// -> staff) rather than a nested PostgREST join, to avoid the FK-ambiguity
// issue already hit and fixed elsewhere in this project.
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
    patient_name: string;
    patient_phone: string;
    doctor_name: string;
    slot_date: string;
    start_time: string;
  }[] = [];

  for (const a of appts) {
    const sched = scheduleMap.get(a.schedule_id);
    if (!sched) continue; // schedule missing or in the past

    // slot_date is a DATE (YYYY-MM-DD), start_time is a TIME (HH:MM:SS),
    // both stored as clinic-local (Kenya, UTC+3) wall-clock values. The
    // "+03:00" offset here is what makes JS parse this as Nairobi time
    // instead of UTC — without it, Date() assumes the server's own
    // timezone (UTC on Supabase), shifting every reminder by 3 hours.
    // Kenya has no daylight saving, so this fixed offset is always correct.
    const appointmentDateTime = new Date(`${sched.slot_date}T${sched.start_time}+03:00`);
    const minutesUntil = (appointmentDateTime.getTime() - now.getTime()) / 60000;

    if (minutesUntil >= windowStartMinutes && minutesUntil < windowEndMinutes) {
      due.push({
        appointment_id: a.id,
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
        await sendReminderTemplate(
          appt.patient_phone,
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
        console.error(`Failed to send ${w.field} reminder for ${appt.appointment_id}:`, err instanceof Error ? err.message : String(err));
        results.push({
          appointment_id: appt.appointment_id,
          window: w.field,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return new Response(JSON.stringify(results), {
    headers: { "Content-Type": "application/json" },
  });
});