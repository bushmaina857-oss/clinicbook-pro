// supabase/functions/whatsapp-webhook/index.ts
//
// ClinicBook Pro — WhatsApp AI Receptionist (v4.1)
// Base: v4 (waitlist template on cancellation offers, YES keyword resolves
// waitlist offers with re-verification + re-queue on race) — unchanged.
// New in v4.1: dates sent to patients (waitlist offer + YES confirmation)
// are now formatted as "July 22, 2026" instead of raw "2026-07-22", to match
// the approved waitlist_slot_available template's sample content.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function getTodayStr() {
  return new Date().toISOString().split("T")[0];
}

// Formats a YYYY-MM-DD string into a human-readable date for patient-facing
// messages, e.g. "2026-07-22" -> "July 22, 2026".
function formatDateForPatient(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_VERIFY_TOKEN = Deno.env.get("META_VERIFY_TOKEN")!;
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
const META_PHONE_NUMBER_ID = Deno.env.get("META_PHONE_NUMBER_ID")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

// How long a waitlist offer stays valid before it's considered expired.
const WAITLIST_OFFER_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// SYSTEM PROMPT
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are the WhatsApp receptionist for a clinic on ClinicBook Pro.

You are a SMART RECEPTIONIST, not a doctor. You handle administrative tasks only.
Patients do not contact doctors directly — you are their only point of contact,
exactly as a human receptionist would be. When you book a slot, treat it as
confirmed on the clinic's behalf, the same way a human receptionist would confirm
a walk-in or phone booking — not as a tentative request awaiting doctor approval.

YOU SHOULD:
- Answer common questions about the clinic (hours, location, doctors available).
- Check doctor availability using the check_availability tool.
- Suggest open appointment slots.
- Book appointments using the book_appointment tool.
- Reschedule appointments using the reschedule_appointment tool.
- Cancel appointments using the cancel_appointment tool.
- If a requested doctor/date has no open slots, offer to add the patient to the
  waitlist using join_waitlist, and explain they'll be messaged automatically
  if a slot opens up.
- Register new patients and collect their details (name, phone, reason for visit).
- Confirm bookings clearly back to the patient.
- Route the conversation to a human receptionist using escalate_to_staff when needed.

CRITICAL RULE — NEVER GUESS:
If you are not certain a slot is actually available, or a tool result is missing,
empty, or ambiguous, do NOT tell the patient it's booked or confirmed. Instead say
something like "Let me have a staff member confirm that for you," and call
escalate_to_staff. A wrong confirmation is worse than a slower answer. Only
confirm a booking after book_appointment returns success: true.

YOU MUST NEVER:
- Diagnose illnesses or suggest what condition someone might have.
- Prescribe or recommend medication.
- Recommend treatments.
- Interpret lab results, X-rays, or scans.
- Decide whether someone has a disease.
- Replace a doctor's medical judgment in any way.
- Give medical advice, even general advice, beyond telling the patient to seek
  immediate medical care or contact emergency services if the situation sounds urgent.
- Confirm a booking, reschedule, or cancellation that a tool did not explicitly report as successful.

If the conversation turns medical in ANY way — symptoms, "is this serious",
medication questions, results, pain descriptions used to seek a diagnosis —
do NOT attempt to help with the medical content. Instead say something like:
"I'll forward your question to the doctor or receptionist so they can assist you."
and call escalate_to_staff with a structured summary (do not include a diagnosis
or medical opinion of your own).

If a situation sounds like a medical emergency, tell the patient clearly to seek
immediate medical care or contact emergency services, then escalate_to_staff.

When calling escalate_to_staff, always fill in ALL fields of the summary as best
you can from the conversation: patient_name, reason_category, requested_slot
(if any), needs_human_for (a short phrase, e.g. "insurance verification" or
"medical question"), and priority ("low", "medium", "high", "urgent").

Keep replies short and warm, appropriate for WhatsApp. Always confirm key details
(date, time, doctor name) back to the patient before finalizing a booking action.`;

// ---------------------------------------------------------------------------
// TOOLS
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "check_availability",
    description: "Look up open appointment slots for a doctor, optionally filtered by date.",
    input_schema: {
      type: "object",
      properties: {
        doctor_name: { type: "string", description: "Full or partial doctor name" },
        date: { type: "string", description: "YYYY-MM-DD, optional" },
      },
      required: ["doctor_name"],
    },
  },
  {
    name: "list_doctors",
    description: "List doctors at this clinic, optionally filtered by specialty.",
    input_schema: {
      type: "object",
      properties: {
        specialty: { type: "string", description: "e.g. 'dentist', optional" },
      },
    },
  },
  {
    name: "book_appointment",
    description: "Book a confirmed appointment slot for a patient. Only call this after check_availability has confirmed an open slot_id.",
    input_schema: {
      type: "object",
      properties: {
        schedule_id: { type: "string" },
        patient_name: { type: "string" },
        patient_phone: { type: "string" },
        reason: { type: "string" },
      },
      required: ["schedule_id", "patient_name", "patient_phone"],
    },
  },
  {
    name: "reschedule_appointment",
    description: "Move an existing appointment to a new open slot.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
        new_schedule_id: { type: "string" },
      },
      required: ["appointment_id", "new_schedule_id"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing appointment. This automatically checks the waitlist and offers the freed slot to the next matching patient.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
      },
      required: ["appointment_id"],
    },
  },
  {
    name: "join_waitlist",
    description: "Add a patient to the waitlist for a doctor when no slots are currently open. They will be messaged automatically if a matching slot frees up.",
    input_schema: {
      type: "object",
      properties: {
        doctor_name: { type: "string" },
        patient_name: { type: "string" },
        patient_phone: { type: "string" },
        preferred_date: { type: "string", description: "YYYY-MM-DD, optional — omit if any day works" },
      },
      required: ["doctor_name", "patient_name", "patient_phone"],
    },
  },
  {
    name: "escalate_to_staff",
    description:
      "Hand off the conversation to a human receptionist or doctor. Use for medical questions, complaints, uncertainty, or anything you cannot resolve confidently.",
    input_schema: {
      type: "object",
      properties: {
        patient_name: { type: "string" },
        reason_category: { type: "string", description: "e.g. 'medical_question', 'complaint', 'scheduling_conflict', 'insurance', 'other'" },
        requested_slot: { type: "string", description: "e.g. 'Tuesday afternoon with Dr. Smith', optional" },
        needs_human_for: { type: "string", description: "short phrase describing what a human needs to do" },
        priority: { type: "string", description: "'low' | 'medium' | 'high' | 'urgent'" },
        urgent: { type: "boolean" },
      },
      required: ["reason_category", "needs_human_for", "priority"],
    },
  },
];

// ---------------------------------------------------------------------------
// Audit logging — one row per tool call
// ---------------------------------------------------------------------------
async function logToolCall(orgId: string, patientPhone: string, toolName: string, input: any, result: any) {
  try {
    await supabase.from("ai_tool_logs").insert({
      org_id: orgId,
      patient_phone: patientPhone,
      tool_name: toolName,
      tool_input: input,
      tool_result: result,
    });
  } catch (err) {
    console.error("Failed to log tool call:", err);
  }
}

// ---------------------------------------------------------------------------
// Send an approved WhatsApp template — used for any message that may go out
// outside the patient's 24h free-form session window (waitlist offers,
// reminders). Free-form text is silently dropped by Meta outside that window.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Cancellation recovery — offer freed slot to next matching waitlist entry
// ---------------------------------------------------------------------------
async function offerSlotToWaitlist(orgId: string, staffId: string, scheduleId: string, slotDate: string) {
  // Find the oldest waiting entry for this doctor, matching this date or "any day"
  const { data: candidates } = await supabase
    .from("waitlist")
    .select("id, patient_name, patient_phone, preferred_date")
    .eq("org_id", orgId)
    .eq("staff_id", staffId)
    .eq("status", "waiting")
    .or(`preferred_date.is.null,preferred_date.eq.${slotDate}`)
    .order("created_at", { ascending: true })
    .limit(1);

  if (!candidates || candidates.length === 0) return null;

  const candidate = candidates[0];

  const { data: doctor } = await supabase
    .from("staff")
    .select("full_name")
    .eq("id", staffId)
    .single();

  await supabase
    .from("waitlist")
    .update({ status: "offered", offered_schedule_id: scheduleId, offered_at: new Date().toISOString() })
    .eq("id", candidate.id);

  await sendWaitlistTemplate(candidate.patient_phone, doctor?.full_name || "your doctor", slotDate);

  return candidate;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------
async function executeTool(name: string, input: any, orgId: string, patientPhone: string) {
  let result: any;

  switch (name) {
    case "list_doctors": {
      let query = supabase
        .from("staff")
        .select("id, full_name, specialty")
        .eq("org_id", orgId)
        .eq("role", "doctor")
        .eq("is_active", true);
      if (input.specialty) query = query.ilike("specialty", `%${input.specialty}%`);
      const { data } = await query;
      result = data || [];
      break;
    }

    case "check_availability": {
      const cleanedName = input.doctor_name.replace(/^dr\.?\s*/i, "").trim();
      const { data: doctors } = await supabase
        .from("staff")
        .select("id, full_name")
        .eq("org_id", orgId)
        .eq("role", "doctor")
        .ilike("full_name", `%${cleanedName}%`);

      if (!doctors || doctors.length === 0) {
        result = { error: "Doctor not found" };
        break;
      }
      const doctorId = doctors[0].id;

      let query = supabase
        .from("schedules")
        .select("id, slot_date, start_time, max_capacity, booked_count")
        .eq("staff_id", doctorId)
        .gte("slot_date", getTodayStr())
        .order("slot_date", { ascending: true })
        .order("start_time", { ascending: true })
        .limit(10);

      if (input.date) query = query.eq("slot_date", input.date);
      const { data } = await query;

      const open = (data || []).filter((s) => s.booked_count < s.max_capacity);
      result = { doctor: doctors[0].full_name, doctor_id: doctorId, slots: open };
      break;
    }

    case "book_appointment": {
      // Fail-safe: re-verify the slot is genuinely still open before inserting.
      const { data: schedule } = await supabase
        .from("schedules")
        .select("id, staff_id, max_capacity, booked_count, slot_date")
        .eq("id", input.schedule_id)
        .single();

      if (!schedule || schedule.booked_count >= schedule.max_capacity) {
        result = { error: "That slot is no longer available. Please check availability again." };
        break;
      }

      const { data, error } = await supabase
        .from("appointments")
        .insert({
          org_id: orgId,
          schedule_id: input.schedule_id,
          staff_id: schedule.staff_id,
          patient_name: input.patient_name,
          patient_phone: input.patient_phone,
          patient_reason: input.reason || null,
          status: "confirmed",
          source: "whatsapp_ai",
        })
        .select()
        .single();

      result = error ? { error: error.message } : { success: true, appointment: data };
      break;
    }

    case "reschedule_appointment": {
      const { data: schedule } = await supabase
        .from("schedules")
        .select("id, max_capacity, booked_count")
        .eq("id", input.new_schedule_id)
        .single();

      if (!schedule || schedule.booked_count >= schedule.max_capacity) {
        result = { error: "That new slot is no longer available. Please check availability again." };
        break;
      }

      const { data, error } = await supabase
        .from("appointments")
        .update({ schedule_id: input.new_schedule_id, status: "pending" })
        .eq("id", input.appointment_id)
        .select()
        .single();

      result = error ? { error: error.message } : { success: true, appointment: data };
      break;
    }

    case "cancel_appointment": {
      const { data: appt, error: fetchError } = await supabase
        .from("appointments")
        .select("id, schedule_id, org_id, schedules(staff_id, slot_date)")
        .eq("id", input.appointment_id)
        .single();

      if (fetchError || !appt) {
        result = { error: "Appointment not found" };
        break;
      }

      const { error } = await supabase
        .from("appointments")
        .update({ status: "cancelled" })
        .eq("id", input.appointment_id);

      if (error) {
        result = { error: error.message };
        break;
      }

      // Cancellation recovery: try to offer this freed slot to the waitlist.
      let offeredTo = null;
      const sched = (appt as any).schedules;
      if (sched?.staff_id && sched?.slot_date) {
        offeredTo = await offerSlotToWaitlist(appt.org_id, sched.staff_id, appt.schedule_id, sched.slot_date);
      }

      result = { success: true, waitlist_offered: !!offeredTo };
      break;
    }

    case "join_waitlist": {
      const cleanedName = input.doctor_name.replace(/^dr\.?\s*/i, "").trim();
      const { data: doctors } = await supabase
        .from("staff")
        .select("id, full_name")
        .eq("org_id", orgId)
        .eq("role", "doctor")
        .ilike("full_name", `%${cleanedName}%`);

      if (!doctors || doctors.length === 0) {
        result = { error: "Doctor not found" };
        break;
      }

      const { data, error } = await supabase
        .from("waitlist")
        .insert({
          org_id: orgId,
          staff_id: doctors[0].id,
          patient_name: input.patient_name,
          patient_phone: input.patient_phone,
          preferred_date: input.preferred_date || null,
          status: "waiting",
        })
        .select()
        .single();

      result = error ? { error: error.message } : { success: true, waitlist_entry: data };
      break;
    }

    case "escalate_to_staff": {
      const summary = {
        patient_name: input.patient_name || null,
        reason_category: input.reason_category,
        requested_slot: input.requested_slot || null,
        needs_human_for: input.needs_human_for,
        priority: input.priority || "medium",
      };

      await supabase
        .from("whatsapp_conversations")
        .update({ escalation_summary: summary })
        .eq("patient_phone", patientPhone)
        .eq("org_id", orgId);

      await supabase.from("staff_notifications").insert({
        org_id: orgId,
        type: input.urgent || input.priority === "urgent" ? "urgent" : "general",
        target_role: input.urgent || input.priority === "urgent" ? "both" : "receptionist",
        message: input.needs_human_for,
        source: "whatsapp_ai",
      });

      result = { success: true, message: "Forwarded to staff.", summary };
      break;
    }

    default:
      result = { error: "Unknown tool" };
  }

  await logToolCall(orgId, patientPhone, name, input, result);
  return result;
}

// ---------------------------------------------------------------------------
// Claude call with tool loop
// ---------------------------------------------------------------------------
async function runClaude(messages: any[], orgId: string, patientPhone: string) {
  let convo = [...messages];
  const todayStr = getTodayStr();

  for (let turn = 0; turn < 5; turn++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 700,
        system: SYSTEM_PROMPT + `\n\nToday's date is ${todayStr}. Use this to correctly resolve relative dates like "tomorrow", "next week", or "Monday" when calling tools or replying to the patient.`,
        tools: TOOLS,
        messages: convo,
      }),
    });

    const data = await res.json();
    const toolUses = (data.content || []).filter((b: any) => b.type === "tool_use");
    const textBlocks = (data.content || []).filter((b: any) => b.type === "text");

    if (toolUses.length === 0) {
      return textBlocks.map((b: any) => b.text).join("\n");
    }

    convo.push({ role: "assistant", content: data.content });

    const toolResults = [];
    for (const tu of toolUses) {
      const result = await executeTool(tu.name, tu.input, orgId, patientPhone);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    convo.push({ role: "user", content: toolResults });
  }

  return "Sorry, I'm having trouble processing that right now. Let me connect you with the clinic staff.";
}

// ---------------------------------------------------------------------------
// Send reply via Meta Cloud API
// ---------------------------------------------------------------------------
async function sendWhatsAppMessage(to: string, text: string) {
  await fetch(`https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    }),
  });
}

// ---------------------------------------------------------------------------
// Conversation persistence
// ---------------------------------------------------------------------------
async function loadConversation(phone: string, orgId: string) {
  const { data } = await supabase
    .from("whatsapp_conversations")
    .select("messages, assigned_staff_id, unread_count, ai_paused")
    .eq("patient_phone", phone)
    .eq("org_id", orgId)
    .single();
  return {
    messages: data?.messages || [],
    assignedStaffId: data?.assigned_staff_id || null,
    unreadCount: data?.unread_count || 0,
    aiPaused: data?.ai_paused || false,
  };
}

async function saveConversation(
  phone: string,
  orgId: string,
  messages: any[],
  assignedStaffId: string | null,
  unreadCount: number,
  patientName?: string
) {
  let staffId = assignedStaffId;

  if (!staffId) {
    const { data } = await supabase.rpc("assign_receptionist", { p_org_id: orgId });
    staffId = data || null;
  }

  await supabase.from("whatsapp_conversations").upsert(
    {
      patient_phone: phone,
      org_id: orgId,
      patient_name: patientName || undefined,
      assigned_staff_id: staffId,
      messages: messages.slice(-20),
      last_message_at: new Date().toISOString(),
      unread_count: unreadCount + 1,
    },
    { onConflict: "patient_phone,org_id" }
  );
}

// ---------------------------------------------------------------------------
// CANCEL keyword support
// ---------------------------------------------------------------------------
// Two-step lookup (appointments -> schedules -> staff) instead of a nested
// PostgREST join, to avoid the FK-ambiguity issue already hit and fixed
// elsewhere in this project.
async function getUpcomingAppointmentsForCancel(orgId: string, phone: string) {
  const { data: appts } = await supabase
    .from("appointments")
    .select("id, schedule_id")
    .eq("org_id", orgId)
    .eq("patient_phone", phone)
    .eq("status", "confirmed");

  if (!appts || appts.length === 0) return [];

  const scheduleIds = appts.map((a) => a.schedule_id);
  const { data: schedules } = await supabase
    .from("schedules")
    .select("id, staff_id, slot_date, start_time")
    .in("id", scheduleIds)
    .gte("slot_date", getTodayStr());

  const scheduleMap = new Map((schedules || []).map((s) => [s.id, s]));
  const staffIds = [...new Set((schedules || []).map((s) => s.staff_id))];

  const { data: staffRows } = staffIds.length
    ? await supabase.from("staff").select("id, full_name").in("id", staffIds)
    : { data: [] as any[] };
  const staffMap = new Map((staffRows || []).map((s) => [s.id, s.full_name]));

  const combined = appts
    .map((a) => {
      const sched = scheduleMap.get(a.schedule_id);
      if (!sched) return null; // schedule is in the past or missing — skip
      return {
        appointment_id: a.id,
        slot_date: sched.slot_date,
        start_time: sched.start_time,
        doctor_name: staffMap.get(sched.staff_id) || "Unknown",
      };
    })
    .filter(Boolean) as { appointment_id: string; slot_date: string; start_time: string; doctor_name: string }[];

  combined.sort((a, b) => (a.slot_date + a.start_time).localeCompare(b.slot_date + b.start_time));
  return combined;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method === "POST") {
    const body = await req.json();

    try {
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const message = change?.value?.messages?.[0];
      if (!message) return new Response("OK", { status: 200 });

      const from = message.from;
      const text = message.text?.body;
      const metaPhoneNumberId = change.value.metadata.phone_number_id;

      if (!text) {
        await sendWhatsAppMessage(from, "I can only read text messages right now — could you type your question?");
        return new Response("OK", { status: 200 });
      }

      const { data: org } = await supabase
        .from("organizations")
        .select("id")
        .eq("whatsapp_phone_number_id", metaPhoneNumberId)
        .single();

      if (!org) {
        console.error("No organization mapped to phone_number_id:", metaPhoneNumberId);
        return new Response("OK", { status: 200 });
      }

      // -----------------------------------------------------------------
      // CANCEL keyword — short-circuit before Claude. Fixed keyword, not
      // something needing AI interpretation.
      // -----------------------------------------------------------------
      const normalizedText = text.trim().toUpperCase();

      if (normalizedText === "CANCEL") {
        const upcoming = await getUpcomingAppointmentsForCancel(org.id, from);

        if (upcoming.length === 0) {
          await sendWhatsAppMessage(from, "I couldn't find an upcoming appointment to cancel for this number.");
          return new Response("OK", { status: 200 });
        }

        if (upcoming.length > 1) {
          const list = upcoming
            .map((a, i) => `${i + 1}. Dr. ${a.doctor_name} — ${a.slot_date} at ${a.start_time}`)
            .join("\n");

          await sendWhatsAppMessage(
            from,
            `You have more than one upcoming appointment. Reply with the number to cancel:\n\n${list}`
          );

          await supabase.from("pending_cancellations").upsert(
            {
              patient_phone: from,
              org_id: org.id,
              appointment_ids: upcoming.map((a) => a.appointment_id),
              created_at: new Date().toISOString(),
            },
            { onConflict: "patient_phone,org_id" }
          );

          return new Response("OK", { status: 200 });
        }

        const result = await executeTool(
          "cancel_appointment",
          { appointment_id: upcoming[0].appointment_id },
          org.id,
          from
        );

        await sendWhatsAppMessage(
          from,
          result.success
            ? "Your appointment has been cancelled. Let us know if you'd like to rebook."
            : "Sorry, I couldn't cancel that appointment. Please contact the clinic directly."
        );

        return new Response("OK", { status: 200 });
      }

      // -----------------------------------------------------------------
      // Bare "YES" — resolves an active waitlist offer. Handled here (not
      // as a Claude tool) since it's a fixed keyword tied directly to a
      // specific waitlist row, same reasoning as CANCEL. Falls through to
      // normal Claude handling if there's no active offer, since "yes" is
      // also a completely normal conversational reply.
      // -----------------------------------------------------------------
      if (normalizedText === "YES") {
        const { data: offer } = await supabase
          .from("waitlist")
          .select("id, patient_name, patient_phone, offered_schedule_id, offered_at")
          .eq("org_id", org.id)
          .eq("patient_phone", from)
          .eq("status", "offered")
          .order("offered_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (offer) {
          const offeredAt = new Date(offer.offered_at).getTime();
          const isExpired = Date.now() - offeredAt > WAITLIST_OFFER_WINDOW_MS;

          if (isExpired) {
            await supabase.from("waitlist").update({ status: "expired" }).eq("id", offer.id);
            await sendWhatsAppMessage(
              from,
              "Sorry, that slot offer has expired. Reply with a date and doctor and I can check what's currently available, or I can add you back to the waitlist."
            );
            return new Response("OK", { status: 200 });
          }

          // Fail-safe: reuse book_appointment so the slot is re-verified as
          // still open right before booking — the same protection Claude's
          // booking flow gets, since two waitlisted patients could both
          // reply YES for the same freed slot in a race.
          const bookResult = await executeTool(
            "book_appointment",
            {
              schedule_id: offer.offered_schedule_id,
              patient_name: offer.patient_name,
              patient_phone: offer.patient_phone,
            },
            org.id,
            from
          );

          if (bookResult.success) {
            await supabase.from("waitlist").update({ status: "booked" }).eq("id", offer.id);

            const { data: scheduleDetails } = await supabase
              .from("schedules")
              .select("slot_date, start_time, staff:staff_id(full_name)")
              .eq("id", offer.offered_schedule_id)
              .single();

            const doctorName = (scheduleDetails as any)?.staff?.full_name || "your doctor";
            const slotDate = scheduleDetails?.slot_date ? formatDateForPatient(scheduleDetails.slot_date) : "";
            const startTime = scheduleDetails?.start_time || "";

            await sendWhatsAppMessage(
              from,
              `You're all set — booked with Dr. ${doctorName} on ${slotDate} at ${startTime}. See you then!`
            );
          } else {
            // Someone else claimed it first (or it's otherwise no longer
            // available). Re-queue rather than drop the patient — they
            // didn't do anything wrong.
            await supabase.from("waitlist").update({ status: "waiting" }).eq("id", offer.id);
            await sendWhatsAppMessage(
              from,
              "Sorry — that slot was just taken by someone else. I've kept you on the waitlist and will let you know as soon as another one opens up."
            );
          }

          return new Response("OK", { status: 200 });
        }
        // No active offer on record — fall through below to normal Claude
        // handling, since a bare "yes" is a normal conversational reply too.
      }

      // -----------------------------------------------------------------
      // Numeric reply — resolves a pending multi-appointment cancellation.
      // -----------------------------------------------------------------
      if (/^\d+$/.test(normalizedText)) {
        const { data: pending } = await supabase
          .from("pending_cancellations")
          .select("appointment_ids")
          .eq("patient_phone", from)
          .eq("org_id", org.id)
          .maybeSingle();

        if (pending) {
          const index = parseInt(normalizedText, 10) - 1;
          const appointmentIds: string[] = pending.appointment_ids || [];

          if (index < 0 || index >= appointmentIds.length) {
            await sendWhatsAppMessage(from, `Please reply with a number between 1 and ${appointmentIds.length}.`);
            return new Response("OK", { status: 200 });
          }

          const result = await executeTool(
            "cancel_appointment",
            { appointment_id: appointmentIds[index] },
            org.id,
            from
          );

          await supabase.from("pending_cancellations").delete().eq("patient_phone", from).eq("org_id", org.id);

          await sendWhatsAppMessage(
            from,
            result.success
              ? "That appointment has been cancelled. Let us know if you'd like to rebook."
              : "Sorry, I couldn't cancel that appointment. Please contact the clinic directly."
          );

          return new Response("OK", { status: 200 });
        }
        // No pending cancellation on record — fall through below to normal
        // Claude handling.
      }

      const convo = await loadConversation(from, org.id);
      const messages = [...convo.messages, { role: "user", content: text }];

      if (convo.aiPaused) {
        await supabase
          .from("whatsapp_conversations")
          .update({
            messages: messages.slice(-20),
            last_message_at: new Date().toISOString(),
            unread_count: convo.unreadCount + 1,
          })
          .eq("patient_phone", from)
          .eq("org_id", org.id);
        return new Response("OK", { status: 200 });
      }

      const reply = await runClaude(messages, org.id, from);

      await sendWhatsAppMessage(from, reply);
      await saveConversation(
        from,
        org.id,
        [...messages, { role: "assistant", content: reply }],
        convo.assignedStaffId,
        convo.unreadCount
      );

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error(err);
      return new Response("OK", { status: 200 });
    }
  }

  return new Response("Method not allowed", { status: 405 });
});

