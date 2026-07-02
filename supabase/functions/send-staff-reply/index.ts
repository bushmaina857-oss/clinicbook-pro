// supabase/functions/send-staff-reply/index.ts
//
// ClinicBook Pro — Manual staff reply sender
// Called from inbox.html when a receptionist has taken over a conversation
// and wants to send a message directly to the patient over WhatsApp.
// Keeps the Meta access token server-side (never exposed to the browser).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
const META_PHONE_NUMBER_ID = Deno.env.get("META_PHONE_NUMBER_ID")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function sendWhatsAppMessage(to: string, text: string) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`, {
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
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    // Verify the caller is an authenticated staff member (not just anyone with the URL)
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), { status: 401 });
    }

    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401 });
    }

    const { conversation_id, text } = await req.json();
    if (!conversation_id || !text || !text.trim()) {
      return new Response(JSON.stringify({ error: "Missing conversation_id or text" }), { status: 400 });
    }

    // Confirm this staff member belongs to the same org as the conversation,
    // and is either the assigned staff or an admin — not just any logged-in staff.
    const { data: convo, error: convoError } = await supabase
      .from("whatsapp_conversations")
      .select("id, org_id, patient_phone, assigned_staff_id, messages")
      .eq("id", conversation_id)
      .single();

    if (convoError || !convo) {
      return new Response(JSON.stringify({ error: "Conversation not found" }), { status: 404 });
    }

    const { data: staff, error: staffError } = await supabase
      .from("staff")
      .select("id, org_id, role")
      .eq("user_id", user.id)
      .single();

    if (staffError || !staff || staff.org_id !== convo.org_id) {
      return new Response(JSON.stringify({ error: "Not authorized for this conversation" }), { status: 403 });
    }

    const isAssigned = convo.assigned_staff_id === staff.id;
    const isAdmin = staff.role === "admin";
    if (!isAssigned && !isAdmin) {
      return new Response(
        JSON.stringify({ error: "Only the assigned receptionist or an admin can reply here" }),
        { status: 403 }
      );
    }

    // Send via Meta
    const metaResult = await sendWhatsAppMessage(convo.patient_phone, text.trim());
    if (metaResult.error) {
      console.error("Meta send error:", metaResult.error);
      return new Response(JSON.stringify({ error: "Failed to send WhatsApp message" }), { status: 502 });
    }

    // Append to conversation history so the AI has context if takeover ends later
    const updatedMessages = [...(convo.messages || []), { role: "assistant", content: text.trim(), sent_by: "staff", staff_id: staff.id }];

    await supabase
      .from("whatsapp_conversations")
      .update({
        messages: updatedMessages.slice(-20),
        last_message_at: new Date().toISOString(),
      })
      .eq("id", conversation_id);

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Unexpected error" }), { status: 500 });
  }
});