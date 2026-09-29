// supabase/functions/send-invite-email/index.ts
//
// Called by admin-dashboard.html right after an invite row is inserted.
// Verifies the caller is actually an admin/director of that invite's
// organization, then sends the accept-invite link via Resend.
//
// Requires these secrets set on the project:
//   supabase secrets set RESEND_API_KEY=re_xxxxxxxx
//   supabase secrets set APP_BASE_URL=https://clinicbookpro.com
// SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are
// already injected automatically — no need to set those yourself.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

function buildEmailHtml(orgName, role, acceptUrl) {
  var roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  return (
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1F2937">' +
    '<div style="font-size:18px;font-weight:700;margin-bottom:20px">ClinicBook Pro</div>' +
    '<p style="font-size:15px;line-height:1.6;margin:0 0 8px">' +
    '<strong>' + orgName + '</strong> has invited you to join ClinicBook Pro as <strong>' + roleLabel + '</strong>.' +
    '</p>' +
    '<a href="' + acceptUrl + '" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#059669;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">Accept invite</a>' +
    '<p style="font-size:13px;color:#78716C;margin-top:28px;line-height:1.5">This link expires in 7 days. If you weren\'t expecting this invite, you can ignore this email — no account will be created.</p>' +
    '</div>'
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const email = body.email;
  const token = body.token;
  const role = body.role;

  if (!email || !token || !role) {
    return jsonResponse({ error: 'Missing email, token, or role.' }, 400);
  }

  // Identify the caller from their JWT (authedFetch sends it automatically).
  const authHeader = req.headers.get('Authorization');
  const supabaseUser = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader ?? '' } } }
  );
  const callerResult = await supabaseUser.auth.getUser();
  if (callerResult.error || !callerResult.data.user) {
    return jsonResponse({ error: 'Not authenticated.' }, 401);
  }
  const callerId = callerResult.data.user.id;

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  // Look up the invite by token to get its org, and never trust org_id from
  // the request body — always derive it from the token server-side.
  const inviteResult = await supabaseAdmin
    .from('invites')
    .select('org_id, organizations(name)')
    .eq('token', token)
    .maybeSingle();

  if (inviteResult.error || !inviteResult.data) {
    return jsonResponse({ error: 'Invite not found.' }, 404);
  }
  const orgId = inviteResult.data.org_id;
  const orgName = (inviteResult.data.organizations && inviteResult.data.organizations.name) || 'ClinicBook Pro';

  // Confirm the caller is an active admin/director of that same org before
  // sending anything on their behalf.
  const callerStaffResult = await supabaseAdmin
    .from('staff')
    .select('role')
    .eq('user_id', callerId)
    .eq('org_id', orgId)
    .eq('is_active', true)
    .maybeSingle();

  const callerRole = callerStaffResult.data && callerStaffResult.data.role;
  if (!callerRole || (callerRole !== 'admin' && callerRole !== 'director')) {
    return jsonResponse({ error: 'Not authorized to send invites for this organization.' }, 403);
  }

  const appBaseUrl = Deno.env.get('APP_BASE_URL') || 'https://clinicbookpro.com';
  const acceptUrl = appBaseUrl.replace(/\/$/, '') + '/accept-invite.html?token=' + token;

  const resendResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + (Deno.env.get('RESEND_API_KEY') ?? ''),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'ClinicBook Pro <invites@clinicbookpro.com>',
      to: [email],
      reply_to: 'alfred@clinicbookpro.com',
      subject: "You've been invited to " + orgName + ' on ClinicBook Pro',
      html: buildEmailHtml(orgName, role, acceptUrl)
    })
  });

  if (!resendResponse.ok) {
    const errText = await resendResponse.text();
    return jsonResponse({ error: 'Resend error: ' + errText }, 502);
  }

  return jsonResponse({ success: true }, 200);
});
