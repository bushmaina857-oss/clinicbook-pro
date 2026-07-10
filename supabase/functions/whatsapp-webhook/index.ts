// supabase/functions/whatsapp-webhook/index.ts
//
// ClinicBook Pro — WhatsApp AI Receptionist (v2)
// Adds: fail-safe scheduling (never guess), structured handoff summaries,
// cancellation → waitlist recovery, and a per-conversation audit trail.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function getTodayStr() {
  return new Date().toISOString().split("T")[0];
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_VERIFY_TOKEN = Deno.env.get("META_VERIFY_TOKEN")!;
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
const META_PHONE_NUMBER_ID = Deno.env.get("META_PHONE_NUMBER_ID")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

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

  await supabase
    .from("waitlist")
    .update({ status: "offered", offered_schedule_id: scheduleId, offered_at: new Date().toISOString() })
    .eq("id", candidate.id);

  await sendWhatsAppMessage(
    candidate.patient_phone,
    `Good news — a slot just opened up on ${slotDate}. Reply YES within the next hour to claim it, and I'll book it for you.`
  );

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
        .select("id, max_capacity, booked_count, slot_date")
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
