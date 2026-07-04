// supabase/functions/whatsapp-webhook/index.ts
//
// ClinicBook Pro — WhatsApp AI Receptionist
// Receives patient messages via Meta Cloud API, uses Claude to handle
// booking/rescheduling/FAQs, and escalates anything medical to staff.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function getTodayStr() {
  return new Date().toISOString().split("T")[0];
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_VERIFY_TOKEN = Deno.env.get("META_VERIFY_TOKEN")!; // you choose this string, set it in Meta app settings too
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!; // permanent token from Meta
const META_PHONE_NUMBER_ID = Deno.env.get("META_PHONE_NUMBER_ID")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// SYSTEM PROMPT — this is where the dos/don'ts live
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
- Register new patients and collect their details (name, phone, reason for visit).
- Confirm bookings clearly back to the patient.
- Route the conversation to a human receptionist using escalate_to_staff when needed.

YOU MUST NEVER:
- Diagnose illnesses or suggest what condition someone might have.
- Prescribe or recommend medication.
- Recommend treatments.
- Interpret lab results, X-rays, or scans.
- Decide whether someone has a disease.
- Replace a doctor's medical judgment in any way.
- Give medical advice, even general advice, beyond telling the patient to seek
  immediate medical care or contact emergency services if the situation sounds urgent.

If the conversation turns medical in ANY way — symptoms, "is this serious",
medication questions, results, pain descriptions used to seek a diagnosis —
do NOT attempt to help with the medical content. Instead say something like:
"I'll forward your question to the doctor or receptionist so they can assist you."
and call escalate_to_staff with a brief neutral summary (do not include a diagnosis
or medical opinion of your own in the summary).

If a situation sounds like a medical emergency, tell the patient clearly to seek
immediate medical care or contact emergency services, then escalate_to_staff.

Keep replies short and warm, appropriate for WhatsApp. Always confirm key details
(date, time, doctor name) back to the patient before finalizing a booking action.`;

// ---------------------------------------------------------------------------
// TOOLS — the AI can only take actions you've explicitly defined here.
// There is no "diagnose" or "prescribe" tool, so it structurally cannot do those.
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
    description: "Book a confirmed appointment slot for a patient.",
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
    description: "Cancel an existing appointment.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
      },
      required: ["appointment_id"],
    },
  },
  {
    name: "escalate_to_staff",
    description:
      "Hand off the conversation to a human receptionist or doctor. Use for medical questions, complaints, or anything you cannot resolve.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Brief neutral summary, no medical opinions" },
        urgent: { type: "boolean" },
      },
      required: ["reason"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution — actual Supabase reads/writes
// ---------------------------------------------------------------------------
async function executeTool(name: string, input: any, orgId: string) {
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
      return data || [];
    }

    case "check_availability": {
      const { data: doctors } = await supabase
        .from("staff")
        .select("id, full_name")
        .eq("org_id", orgId)
        .eq("role", "doctor")
        .ilike("full_name", `%${input.doctor_name}%`);

      if (!doctors || doctors.length === 0) return { error: "Doctor not found" };
      const doctorId = doctors[0].id;

      let query = supabase
        .from("schedules")
        .select("id, slot_date, start_time, capacity, booked_count")
        .eq("staff_id", doctorId)
        .gte("slot_date", getTodayStr())
        .order("slot_date", { ascending: true })
        .order("start_time", { ascending: true })
        .limit(10);

      if (input.date) query = query.eq("slot_date", input.date);
      const { data } = await query;

      const open = (data || []).filter((s) => s.booked_count < s.capacity);
      return { doctor: doctors[0].full_name, slots: open };
    }

    case "book_appointment": {
      // Booked as 'confirmed' — the AI stands in for the receptionist here,
      // same as a human receptionist booking on a patient's behalf.
      const { data, error } = await supabase
        .from("appointments")
        .insert({
          org_id: orgId,
          schedule_id: input.schedule_id,
          patient_name: input.patient_name,
          patient_phone: input.patient_phone,
          reason: input.reason || null,
          status: "confirmed",
          source: "whatsapp_ai",
        })
        .select()
        .single();
      if (error) return { error: error.message };
      return { success: true, appointment: data };
    }

    case "reschedule_appointment": {
      const { data, error } = await supabase
        .from("appointments")
        .update({ schedule_id: input.new_schedule_id, status: "pending" })
        .eq("id", input.appointment_id)
        .select()
        .single();
      if (error) return { error: error.message };
      return { success: true, appointment: data };
    }

    case "cancel_appointment": {
      const { error } = await supabase
        .from("appointments")
        .update({ status: "cancelled" })
        .eq("id", input.appointment_id);
      if (error) return { error: error.message };
      return { success: true };
    }

    case "escalate_to_staff": {
      // General questions go to reception (who own patient contact).
      // Urgent/medical situations alert both reception and the doctor.
      await supabase.from("staff_notifications").insert({
        org_id: orgId,
        type: input.urgent ? "urgent" : "general",
        target_role: input.urgent ? "both" : "receptionist",
        message: input.reason,
        source: "whatsapp_ai",
      });
      return { success: true, message: "Forwarded to staff." };
    }

    default:
      return { error: "Unknown tool" };
  }
}

// ---------------------------------------------------------------------------
// Claude call with tool loop
// ---------------------------------------------------------------------------
async function runClaude(messages: any[], orgId: string) {
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
        system: SYSTEM_PROMPT,
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
      const result = await executeTool(tu.name, tu.input, orgId);
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
// Conversation persistence — keeps history per patient phone number.
// Also auto-assigns a receptionist, since reception owns patient contact
// (patients never reach doctors directly), and bumps unread_count so the
// receptionist dashboard surfaces new activity.
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
      messages: messages.slice(-20), // keep last 20 turns to bound context size
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

  // Meta webhook verification handshake (GET)
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // Incoming message (POST)
  if (req.method === "POST") {
    const body = await req.json();

    try {
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const message = change?.value?.messages?.[0];
      if (!message) return new Response("OK", { status: 200 }); // e.g. status updates, ignore

      const from = message.from; // patient's phone number
      const text = message.text?.body;
      const metaPhoneNumberId = change.value.metadata.phone_number_id;

      if (!text) {
        await sendWhatsAppMessage(from, "I can only read text messages right now — could you type your question?");
        return new Response("OK", { status: 200 });
      }

      // Map the receiving WhatsApp number to an organization (multi-tenant routing)
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
        // A receptionist has taken over — the AI stays silent, just log the
        // incoming message and bump unread_count so it's visible in the inbox.
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

      const reply = await runClaude(messages, org.id);

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
      return new Response("OK", { status: 200 }); // always 200 so Meta doesn't retry-storm you
    }
  }

  return new Response("Method not allowed", { status: 405 });
});